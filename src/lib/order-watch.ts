import { remotePrisma } from "./prisma";

/**
 * Sipariş izleyici — sunucu tarafında periyodik çalışır (relay gibi):
 *
 * Sipariş bildirimleri (stoğu bitene sipariş / sipariş-üzerine üretim) /api/orders hesaplanınca
 * üretiliyor; o da yalnız SAYFA ZİYARETİYLE tetikleniyordu → kullanıcı Panel/Siparişler'i açana
 * dek bildirim doğmuyordu (dünkü sipariş bugün, üstelik TOPLU bildiriliyordu). Bu izleyici
 * /api/orders'ı kendi kendine periyodik çağırır (SWR önbelleğini de sıcak tutar → Siparişler
 * sayfası hep anında açılır) + bildirim tablosunu budar.
 *
 * Maliyet: 5 dk'da bir 3 pazaryeri listeleme çağrısı (~288/gün/platform) — limitlerin çok altında.
 */
const WATCH_MS = 5 * 60_000;
const FIRST_RUN_MS = 90_000; // açılışın ilk saniyelerinde pazaryeri çekimiyle yarışma
let started = false;
let running = false;
let lastPruneAt = 0;

function baseUrl(): string {
  // main.js dinlediği portu MLHUB_PORT'a yazar; dev'de PORT/3000'e düş.
  const port = process.env.MLHUB_PORT || process.env.PORT || "3000";
  return `http://127.0.0.1:${port}`;
}

async function tick(): Promise<void> {
  if (running) return;
  if ((globalThis as { __MLHUB_DB_PAUSED__?: boolean }).__MLHUB_DB_PAUSED__) return; // uyku koruması
  running = true;
  try {
    // /api/orders SWR'ı tetikle: taze değilse arka planda yeniden hesaplanır → yeni siparişlerin
    // bildirimleri (route içinde) doğar + kritikler telefona push'lanır.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30_000);
    try {
      await fetch(`${baseUrl()}/api/orders`, { signal: ctrl.signal, cache: "no-store" });
    } finally {
      clearTimeout(t);
    }

    // Budama (~6 saatte bir): tablo sonsuz büyüyordu + bayat sipariş bildirimleri kalıcı
    // "okunmamış kritik" olarak asılı kalıyordu.
    if (Date.now() - lastPruneAt > 6 * 60 * 60_000) {
      lastPruneAt = Date.now();
      const now = Date.now();
      // 1) Okunmuşlar 30 gün sonra silinir.
      await remotePrisma.notification.deleteMany({
        where: { acknowledgedAt: { not: null, lt: new Date(now - 30 * 86_400_000) } },
      }).catch(() => {});
      // 2) 7 günden eski sipariş bildirimleri otomatik okundu (aday penceresiyle aynı — sipariş
      //    çoktan kargolandı; sonsuza dek kırmızı rozet üretmesin).
      await remotePrisma.notification.updateMany({
        where: {
          type: { in: ["order-stock", "order-made"] },
          acknowledgedAt: null,
          createdAt: { lt: new Date(now - 7 * 86_400_000) },
        },
        data: { acknowledgedAt: new Date() },
      }).catch(() => {});
    }
  } catch {
    /* ağ yok / sunucu meşgul — sonraki tick dener */
  } finally {
    running = false;
  }
}

export function startOrderWatch(): void {
  if (started) return;
  started = true;
  setTimeout(() => { void tick(); }, FIRST_RUN_MS);
  setInterval(() => { void tick(); }, WATCH_MS);
}
