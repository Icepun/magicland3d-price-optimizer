import { NextRequest, NextResponse } from "next/server";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { printerCfgCached } from "@/core/printers/config-cache";
import { bambuKameraAkisi } from "@/core/printers/bambu-camera";
import { moonrakerBase } from "@/core/printers/moonraker";
import { aktarimSuruyor } from "@/core/printers/transfer-state";

export const dynamic = "force-dynamic";

/**
 * CANLI KAMERA — Bambu ve Moonraker yazıcılar için tek uç.
 *
 * Tarayıcıya `multipart/x-mixed-replace` (MJPEG) gönderiliyor: `<img src="…">` bunu doğrudan
 * oynatıyor, ek kütüphane ya da video kod çözücü gerekmiyor. Pencere kapanınca tarayıcı
 * bağlantıyı düşürüyor, biz de yazıcıyla olan bağlantıyı hemen kapatıyoruz.
 *
 * ⚠️ AÇIK KALDIĞI SÜRECE YAZICIYA YÜK BİNER. Bugün (21 Ağu 2026) Snapmaker U1'in aktarım
 * sırasında ağdan düştüğünü ölçtük; sebebi kartın üstüne bindirdiğimiz ek sorgulardı.
 * Bu yüzden kamera akışı: (a) yalnız pencere açıkken çalışır, (b) dosya aktarımı sürerken
 * hiç başlamaz.
 *
 * `?bilgi=1` → yalnız "bu yazıcıda kamera var mı" sorusunu yanıtlar (akış açmaz).
 */

type Cfg = { id: string; type: string; brand: string | null; host: string; port: number; accessCode: string | null; serial: string | null };

/** Moonraker kamerası VAR MI — nginx `/webcam/` yolunu tanıyor ama servis kapalı olabilir. */
const moonrakerKameraOnbellek = new Map<string, { at: number; var: boolean }>();
const KAMERA_TTL_MS = 60_000;

async function moonrakerKameraVar(host: string, port: number): Promise<boolean> {
  const k = `${host}:${port}`;
  const hit = moonrakerKameraOnbellek.get(k);
  if (hit && Date.now() - hit.at < KAMERA_TTL_MS) return hit.var;

  const ctrl = new AbortController();
  const zaman = setTimeout(() => ctrl.abort(), 2500);
  let sonuc = false;
  try {
    const r = await fetch(`${moonrakerBase(host, port)}/webcam/?action=snapshot`, { signal: ctrl.signal });
    // 502 = nginx yolu tanıyor ama kamera servisi çalışmıyor (U1'de baskı yokken böyle).
    sonuc = r.ok && (r.headers.get("content-type") || "").startsWith("image/");
    try { await r.arrayBuffer(); } catch { /* gövdeyi tüket */ }
  } catch {
    sonuc = false;
  } finally {
    clearTimeout(zaman);
  }
  moonrakerKameraOnbellek.set(k, { at: Date.now(), var: sonuc });
  return sonuc;
}

const SINIR = "mlhubkamera";

function mjpegBasliklari(): HeadersInit {
  return {
    "Content-Type": `multipart/x-mixed-replace; boundary=${SINIR}`,
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    Connection: "close",
  };
}

/** Tek kareyi multipart parçasına sar. */
function parca(jpeg: Buffer): Uint8Array {
  const bas = Buffer.from(
    `--${SINIR}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
    "ascii",
  );
  return new Uint8Array(Buffer.concat([bas, jpeg, Buffer.from("\r\n", "ascii")]));
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const cfg = await printerCfgCached<Cfg>(id);
    if (!cfg) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });

    const bambu = cfg.type === "bambu" || (cfg.brand || "").toLowerCase() === "bambu";
    const bilgi = req.nextUrl.searchParams.get("bilgi") === "1";

    if (bilgi) {
      /**
       * Düğme HER ZAMAN çiziliyor; kamera yoksa sönük duruyor. O yüzden "yok" cevabı yetmez,
       * kullanıcıya NEDEN olmadığını da söylemeliyiz — sönük bir düğmeye tıklayıp hiçbir şey
       * olmaması en sinir bozucu hâli.
       */
      if (bambu) {
        const varMi = !!(cfg.accessCode && cfg.serial);
        return NextResponse.json({
          var: varMi,
          neden: varMi ? null : "Bu yazıcı için erişim kodu girilmemiş.",
        });
      }
      const varMi = await moonrakerKameraVar(cfg.host, cfg.port);
      return NextResponse.json({
        var: varMi,
        neden: varMi ? null : "Bu yazıcı ağ üzerinden kamera görüntüsü paylaşmıyor.",
      });
    }

    // Dosya aktarımı sürerken kamera açma — yazıcıyı o an meşgul etmemek öğrenilmiş bir ders.
    if (aktarimSuruyor(cfg.host)) {
      return NextResponse.json(
        { error: "Dosya aktarılırken kamera açılamıyor. Aktarım bitince tekrar dene." },
        { status: 409 },
      );
    }

    if (bambu) {
      if (!cfg.accessCode) {
        return NextResponse.json({ error: "Bu yazıcı için erişim kodu girilmemiş." }, { status: 400 });
      }
      const kod = cfg.accessCode;
      const host = cfg.host;

      const akis = new ReadableStream<Uint8Array>({
        start(kontrol) {
          let kapandi = false;
          const kapat = () => {
            if (kapandi) return;
            kapandi = true;
            try { kamera.durdur(); } catch { /* zaten kapalı */ }
            try { kontrol.close(); } catch { /* zaten kapalı */ }
          };
          const kamera = bambuKameraAkisi(
            host,
            kod,
            (jpeg) => {
              if (kapandi) return;
              try { kontrol.enqueue(parca(jpeg)); } catch { kapat(); }
            },
            () => kapat(),
          );
          // Pencere kapandığında tarayıcı isteği düşürür → yazıcıyla bağlantıyı hemen bırak.
          req.signal.addEventListener("abort", kapat, { once: true });
        },
      });
      return new Response(akis, { headers: mjpegBasliklari() });
    }

    // ── Moonraker: yazıcının kendi MJPEG akışını aynen geçir ──
    const yukari = await fetch(`${moonrakerBase(cfg.host, cfg.port)}/webcam/?action=stream`, {
      signal: req.signal,
    }).catch(() => null);

    if (!yukari || !yukari.ok || !yukari.body) {
      return NextResponse.json(
        { error: "Kamera görüntüsü alınamadı. Yazıcının kamerası kapalı olabilir." },
        { status: 502 },
      );
    }
    return new Response(yukari.body, {
      headers: {
        "Content-Type": yukari.headers.get("content-type") || `multipart/x-mixed-replace; boundary=${SINIR}`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
