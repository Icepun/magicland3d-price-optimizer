/**
 * SNAPMAKER U1 KAMERASI.
 *
 * U1'in kamerası standart Moonraker/crowsnest yolunda DEĞİL: `/webcam/` adresi nginx'te
 * tanımlı ama her koşulda 502 veriyor (boştayken de, baskı sürerken de ölçüldü). Kamera
 * bunun yerine Moonraker'ın dosya yolundan tek bir kare olarak sunuluyor:
 *
 *   GET /server/files/camera/monitor.jpg
 *
 * ⚠️ KAMERA BOŞTA UYUYOR. Kimse istemezse kare tazelenmeyi bırakıyor ve adres son (bayat)
 * görüntüyü döndürmeye devam ediyor — yani "200 + JPEG" almak canlı olduğu anlamına gelmez.
 * Uyandırmak için Moonraker'ın WebSocket'ine şu istek gönderilmeli ve periyodik olarak
 * TEKRARLANMALI:
 *
 *   {"jsonrpc":"2.0","method":"camera.start_monitor","params":{"domain":"lan","interval":0}}
 *
 * Yazıcı `notify_camera_status_change` ile `monitoring: true` diye yanıtlıyor.
 *
 * ÖLÇÜLDÜ (23 Ağu 2026, gerçek cihazda): uyandırıldıktan sonra kare ~480 ms'de bir değişiyor
 * (≈2,1 fps), tek istek ~51 ms sürüyor, kare ~80-88 KB. Bu yüzden 480 ms'de bir çekiyoruz —
 * daha sık çekmek AYNI kareyi tekrar indirmek ve yazıcıyı boşuna yormak olurdu.
 *
 * Kaynak: SimplyPrint'in U1 kamera kılavuzu ve Snapmaker forumundaki topluluk çalışmaları.
 */
import crypto from "node:crypto";
import { moonrakerBase } from "./moonraker";

/** Kare adresi — hem 7125 hem 80 üzerinden çalışıyor (nginx aynı yere veriyor). */
function kareUrl(host: string, port: number): string {
  return `${moonrakerBase(host, port)}/server/files/camera/monitor.jpg`;
}

/** Bu yazıcıda kamera var mı? (uyandırma gerekmez — bayat kare de 200 döner) */
export async function snapmakerKameraVar(host: string, port: number): Promise<boolean> {
  const ctrl = new AbortController();
  const zaman = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(kareUrl(host, port), { signal: ctrl.signal });
    if (!r.ok) return false;
    if (!(r.headers.get("content-type") || "").startsWith("image/")) return false;
    const b = Buffer.from(await r.arrayBuffer());
    return b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
  } catch {
    return false;
  } finally {
    clearTimeout(zaman);
  }
}

export interface KameraAkisi {
  durdur: () => void;
}

/** Uyandırma isteğinin tekrar aralığı — yazıcı bu gelmezse kamerayı uykuya alıyor. */
const UYANDIRMA_MS = 8_000;
/** Kare çekme aralığı — ölçülen tazelenme hızıyla aynı (daha sık çekmek boşuna). */
const KARE_MS = 480;

/**
 * Canlı akış: kamerayı uyanık tutar ve değişen her kareyi verir.
 *
 * `durdur()` çağrılınca uyandırma da durur → kamera kendiliğinden uykuya döner ve yazıcı
 * boşuna meşgul kalmaz.
 */
export function snapmakerKameraAkisi(
  host: string,
  port: number,
  onKare: (jpeg: Buffer) => void,
  onHata: (mesaj: string) => void,
): KameraAkisi {
  let kapandi = false;
  let sonHash = "";
  let bosCekim = 0;
  let soket: { close: () => void; send: (v: string) => void; on: (o: string, f: (...a: never[]) => void) => void; readyState: number } | null = null;
  let uyandirmaZamanlayici: ReturnType<typeof setInterval> | null = null;
  let kareZamanlayici: ReturnType<typeof setTimeout> | null = null;

  const bitir = (mesaj: string) => {
    if (kapandi) return;
    kapandi = true;
    temizle();
    onHata(mesaj);
  };

  const temizle = () => {
    if (uyandirmaZamanlayici) { clearInterval(uyandirmaZamanlayici); uyandirmaZamanlayici = null; }
    if (kareZamanlayici) { clearTimeout(kareZamanlayici); kareZamanlayici = null; }
    try { soket?.close(); } catch { /* zaten kapalı */ }
    soket = null;
  };

  const uyandir = () => {
    try {
      soket?.send(JSON.stringify({
        jsonrpc: "2.0",
        method: "camera.start_monitor",
        params: { domain: "lan", interval: 0 },
        id: Date.now() % 100000,
      }));
    } catch {
      /* soket düştüyse kare çekimi zaten bayatlığı fark eder */
    }
  };

  // WebSocket yalnız sunucuda ve yalnız gerektiğinde yüklenir (Moonraker'ın durum bağlantısıyla aynı desen).
  void (async () => {
    try {
      const m = (await import("ws")) as unknown as { default?: new (url: string) => unknown };
      const WS = (m.default ?? (m as unknown as new (url: string) => unknown));
      if (kapandi) return;
      soket = new WS(`ws://${host}:${port}/websocket`) as unknown as typeof soket;
      soket!.on("open", (() => {
        uyandir();
        uyandirmaZamanlayici = setInterval(uyandir, UYANDIRMA_MS);
      }) as (...a: never[]) => void);
      // Bağlantı düşerse kare çekimi devam eder ama görüntü bayatlar; sessizce yalan
      // söylememek için akışı bitiriyoruz.
      soket!.on("error", (() => bitir("Kamera bağlantısı kurulamadı.")) as (...a: never[]) => void);
    } catch {
      bitir("Kamera bağlantısı kurulamadı.");
    }
  })();

  const kareCek = async () => {
    if (kapandi) return;
    try {
      const r = await fetch(kareUrl(host, port));
      if (r.ok) {
        const b = Buffer.from(await r.arrayBuffer());
        if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) {
          const h = crypto.createHash("md5").update(b).digest("hex");
          // Aynı kareyi tekrar yollamak bant genişliği israfı; tarayıcı da boşuna çizer.
          if (h !== sonHash) {
            sonHash = h;
            bosCekim = 0;
            onKare(b);
          } else if (++bosCekim > 40) {
            // ~20 saniyedir kare değişmiyor: kamera uyandırılamıyor demektir.
            bitir("Kameradan yeni görüntü gelmiyor.");
            return;
          }
        }
      }
    } catch {
      /* tek düşen istek akışı bitirmesin — bir sonraki tur dener */
    }
    if (!kapandi) kareZamanlayici = setTimeout(kareCek, KARE_MS);
  };
  void kareCek();

  return {
    durdur: () => {
      kapandi = true; // bilinçli kapatma: hata geri çağrısı tetiklenmesin
      temizle();
    },
  };
}
