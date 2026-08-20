/**
 * MOONRAKER KALICI BAĞLANTISI — Fluidd/Mainsail'in yaptığı iş.
 *
 * NEDEN: HTTP yoklamasında her tur yeni bir TCP bağlantısı kuruluyordu (undici'nin
 * keep-alive duvarı 4 sn, panel aralığı 5 sn). Neptune 4 Plus'ta bağlantı kurmanın %3,3'ü
 * SYN kaybına düşüp SABİT +1000 ms ekliyor (ölçüldü, 20 Ağu 2026) — yani her yoklamada o
 * riski yeniden alıyorduk. Kullanıcı aynı WiFi'da Fluidd'i sorunsuz kullanıyor; fark tam
 * olarak burada: Fluidd bağlantıyı BİR KEZ kurup açık tutuyor, durumu kendisi sormuyor,
 * değişiklikler ona geliyor.
 *
 * BU MODÜL HIZLI YOLDUR, TEK YOL DEĞİL. Bağlantı yoksa/bayatsa `wsDurumAl` null döner ve
 * çağıran eski HTTP yoluna düşer. Yani en kötü ihtimalde bugünkü davranış korunur.
 *
 * ⚠️ Bağlantılar `globalThis` üzerinde tutulur: Next, instrumentation (relay) ile rotaları
 * AYRI paketlere derliyor ve modül kapsamındaki `new Map()` İKİ kopya oluyor — Bambu'da tam
 * bu yüzden iki MQTT istemcisi birbirini susturmuştu.
 */
import { processSingleton } from "./process-singleton";

/** Abone olunacak nesneler — HTTP sorgusuyla AYNI alan kümesi olmalı. */
export const ABONE_NESNELER: Record<string, string[] | null> = {
  print_stats: null,
  virtual_sdcard: ["progress", "file_position", "file_size"],
  display_status: ["progress"],
  extruder: ["temperature", "target"],
  extruder1: ["temperature", "target"],
  extruder2: ["temperature", "target"],
  extruder3: ["temperature", "target"],
  toolhead: ["extruder"],
  heater_bed: ["temperature", "target"],
  gcode_move: ["gcode_position", "speed_factor"],
  exclude_object: ["current_object", "excluded_objects"],
};

/** Bu süre içinde mesaj gelmediyse bağlantıya güvenilmez → HTTP'ye düşülür. */
const BAYAT_MS = 15_000;
/** Yeniden bağlanma: 1s, 2s, 4s … tavan 30s. */
const YENIDEN_BASE_MS = 1_000;
const YENIDEN_MAX_MS = 30_000;
/** Moonraker'a düzenli ping — ölü bağlantı sessizce açık kalmasın. */
const PING_MS = 20_000;

interface Baglanti {
  soket: unknown;
  /** Birleştirilmiş son durum — `parseStatus`'a olduğu gibi verilir. */
  durum: Record<string, unknown>;
  sonMesajMs: number;
  abone: boolean;
  kapandi: boolean;
  denemeler: number;
  yenidenZamanlayici: ReturnType<typeof setTimeout> | null;
  pingZamanlayici: ReturnType<typeof setInterval> | null;
  sonrakiId: number;
}

const baglantilar = processSingleton("mrws_baglantilar", () => new Map<string, Baglanti>());

function anahtar(host: string, port: number): string {
  return `${host}:${port}`;
}

/** Kısmi güncellemeyi mevcut duruma birleştirir (Moonraker yalnız DEĞİŞENİ gönderir). */
function birlestir(hedef: Record<string, unknown>, gelen: Record<string, unknown>): void {
  for (const [nesne, alanlar] of Object.entries(gelen)) {
    if (!alanlar || typeof alanlar !== "object") continue;
    const mevcut = (hedef[nesne] as Record<string, unknown> | undefined) ?? {};
    hedef[nesne] = { ...mevcut, ...(alanlar as Record<string, unknown>) };
  }
}

function temizle(b: Baglanti): void {
  if (b.yenidenZamanlayici) { clearTimeout(b.yenidenZamanlayici); b.yenidenZamanlayici = null; }
  if (b.pingZamanlayici) { clearInterval(b.pingZamanlayici); b.pingZamanlayici = null; }
}

function yenidenDene(host: string, port: number, b: Baglanti): void {
  if (b.kapandi || b.yenidenZamanlayici) return;
  const bekle = Math.min(YENIDEN_MAX_MS, YENIDEN_BASE_MS * 2 ** Math.min(5, b.denemeler));
  b.denemeler += 1;
  b.yenidenZamanlayici = setTimeout(() => {
    b.yenidenZamanlayici = null;
    void ac(host, port);
  }, bekle);
}

/** `ws` yalnız sunucu tarafında ve yalnız gerektiğinde yüklenir. */
async function wsSinifi(): Promise<(new (url: string) => unknown) | null> {
  try {
    const m = (await import("ws")) as unknown as { default?: new (url: string) => unknown };
    return (m.default ?? (m as unknown as new (url: string) => unknown)) ?? null;
  } catch {
    return null; // kütüphane yoksa sessizce HTTP yolunda kalınır
  }
}

type SoketGibi = {
  on(olay: string, geri: (...a: never[]) => void): void;
  send(veri: string): void;
  close(): void;
  ping?: () => void;
  readyState: number;
};

async function ac(host: string, port: number): Promise<void> {
  const k = anahtar(host, port);
  const b = baglantilar.get(k);
  if (!b || b.kapandi || b.soket) return;

  const WS = await wsSinifi();
  if (!WS) return;

  let soket: SoketGibi;
  try {
    soket = new WS(`ws://${host}:${port}/websocket`) as unknown as SoketGibi;
  } catch {
    yenidenDene(host, port, b);
    return;
  }
  b.soket = soket;

  soket.on("open", () => {
    b.denemeler = 0;
    b.sonMesajMs = Date.now();
    // Tek istekte abone ol: sonuç ilk tam durumu da getirir.
    const id = b.sonrakiId++;
    try {
      soket.send(JSON.stringify({
        jsonrpc: "2.0",
        method: "printer.objects.subscribe",
        params: { objects: ABONE_NESNELER },
        id,
      }));
    } catch {
      /* gönderilemedi → kapanış olayı yeniden bağlanmayı tetikler */
    }
    b.pingZamanlayici = setInterval(() => {
      try { soket.ping?.(); } catch { /* ölü soket → close tetiklenir */ }
    }, PING_MS);
  });

  soket.on("message", ((ham: unknown) => {
    b.sonMesajMs = Date.now();
    let m: {
      method?: string;
      params?: unknown[];
      result?: { status?: Record<string, unknown> };
    };
    try {
      m = JSON.parse(String(ham));
    } catch {
      return;
    }

    // Abonelik yanıtı — ilk tam durum.
    if (m.result?.status) {
      birlestir(b.durum, m.result.status);
      b.abone = true;
      return;
    }
    // Sonraki kısmi güncellemeler.
    if (m.method === "notify_status_update" && Array.isArray(m.params)) {
      const gelen = m.params[0];
      if (gelen && typeof gelen === "object") birlestir(b.durum, gelen as Record<string, unknown>);
      return;
    }
    /**
     * Klippy yeniden başladı/durdu: elde tuttuğumuz durum artık geçersiz. Temizlenmezse
     * yazıcı yeniden başlarken kart eski işi göstermeye devam eder.
     */
    if (m.method === "notify_klippy_disconnected" || m.method === "notify_klippy_shutdown") {
      b.durum = {};
      b.abone = false;
    }
    if (m.method === "notify_klippy_ready") {
      const id = b.sonrakiId++;
      try {
        soket.send(JSON.stringify({
          jsonrpc: "2.0",
          method: "printer.objects.subscribe",
          params: { objects: ABONE_NESNELER },
          id,
        }));
      } catch { /* kapanış yeniden bağlanmayı tetikler */ }
    }
  }) as (...a: never[]) => void);

  const kapanis = () => {
    if (b.soket !== soket) return;
    b.soket = null;
    b.abone = false;
    if (b.pingZamanlayici) { clearInterval(b.pingZamanlayici); b.pingZamanlayici = null; }
    yenidenDene(host, port, b);
  };
  soket.on("close", kapanis as (...a: never[]) => void);
  soket.on("error", kapanis as (...a: never[]) => void);
}

/**
 * Bu yazıcı için kalıcı bağlantıyı başlatır (zaten varsa hiçbir şey yapmaz).
 * Çağırmak ucuzdur; her durum isteğinde çağrılabilir.
 */
export function wsBaslat(host: string, port: number): void {
  const k = anahtar(host, port);
  if (baglantilar.has(k)) return;
  baglantilar.set(k, {
    soket: null, durum: {}, sonMesajMs: 0, abone: false, kapandi: false,
    denemeler: 0, yenidenZamanlayici: null, pingZamanlayici: null, sonrakiId: 1,
  });
  void ac(host, port);
}

/**
 * Kalıcı bağlantıdan TAZE durum. Bağlantı yoksa, aboneliği tamamlanmadıysa ya da mesaj
 * akışı kesildiyse `null` döner → çağıran HTTP yoluna düşer.
 */
export function wsDurumAl(host: string, port: number): Record<string, unknown> | null {
  const b = baglantilar.get(anahtar(host, port));
  if (!b || !b.abone) return null;
  if (Date.now() - b.sonMesajMs > BAYAT_MS) return null;
  if (!b.durum.print_stats) return null; // henüz anlamlı veri yok
  return b.durum;
}

/** Yazıcı ayarları değişince / test için: bağlantıyı kapat. */
export function wsKapat(host: string, port: number): void {
  const k = anahtar(host, port);
  const b = baglantilar.get(k);
  if (!b) return;
  b.kapandi = true;
  temizle(b);
  try { (b.soket as SoketGibi | null)?.close(); } catch { /* zaten kapalı */ }
  baglantilar.delete(k);
}

/**
 * Bir HOST'un tüm bağlantılarını kapat — port fark etmeksizin.
 *
 * Yazıcı silindiğinde ya da adresi değiştiğinde eski kayıt kapatılmıyordu: `wsKapat` üretimde
 * HİÇ çağrılmıyordu (tek çağıran testlerdi). Sonuç, artık var olmayan bir yazıcıya süreç
 * bitene kadar 30 saniyede bir yeniden bağlanma denemesi. Port çözümü zaman içinde
 * değişebildiği için kapatma anahtarı porta bağlanamaz — bu yüzden host bazlı.
 */
export function wsHostKapat(host: string): void {
  for (const k of [...baglantilar.keys()]) {
    if (k.slice(0, k.lastIndexOf(":")) !== host) continue;
    const port = Number(k.slice(k.lastIndexOf(":") + 1));
    wsKapat(host, port);
  }
}

/** Testler için: tüm bağlantıları bırak. */
export function wsHepsiniKapat(): void {
  for (const k of [...baglantilar.keys()]) {
    const [host, port] = k.split(":");
    wsKapat(host, Number(port));
  }
}
