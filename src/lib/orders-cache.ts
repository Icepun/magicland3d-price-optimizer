/**
 * Siparişler sunucu önbelleği (stale-while-revalidate) — PAYLAŞILAN modül.
 *
 * /api/orders 3 pazaryerinden canlı çeker (1-3sn) + kâr'ı fiyatlama kurallarıyla (kargo/komisyon/
 * gider/maliyet) hesaplar. Sonuç 60sn önbeklenir. SORUN: bu kurallar değişince önbeklenmiş gövde
 * ESKİ kurallarla hesaplanmış kalır → kâr güncellenmez (uygulama yeniden başlayana dek). ÇÖZÜM:
 * kural değiştiren rotalar (kargo modu vb.) invalidateOrdersCache() çağırır → sonraki istek TAZE
 * hesaplar. Önbellek Electron ana sürecinde tek instance (modül-düzeyi state).
 *
 * NESİL (generation) NEDEN VAR: hesap 1-3sn (bazen daha uzun) sürüyor ve o sırada kullanıcı bir
 * kural değiştirebiliyor. Nesil, "bu sonuç hangi kural setiyle üretildi" sorusunun cevabı:
 * hesap başlarken alınır, sonuç yayınlanırken karşılaştırılır. Eskimişse sonuç YAYINLANMAZ.
 */
import fs from "node:fs";

export interface OrdersCacheEntry {
  at: number;
  body: Record<string, unknown>;
}

let cache: OrdersCacheEntry | null = null;
let refreshing = false;
let generation = 0;
let diskLoaded = false;

/** Disk biçimi 2: gövde artık hesaplama zamanı damgası (computedAt) taşıyor. */
const DISK_FORMAT = 2;

/**
 * Disk kopyasının kabul edilebilir en büyük yaşı.
 *
 * ESKİDEN 14 GÜNDÜ: uygulama açıldığında iki hafta öncesinin sipariş listesi hiçbir işaret
 * olmadan "güncel" gibi dönebiliyordu. Yarım günü aşan kopya artık kullanılmaz; o durumda
 * canlı çekim yapılır (ekranda çekim göstergesi zaten var). Daha genç kopyalar hızlı açılış
 * için kullanılır ama gövdedeki computedAt sayesinde ekranda "ne zaman güncellendi" yazar.
 */
// Disk kopyasının kabul edilebilir yaşı. 14 gün fazlaydı (bayat veri sessizce güncel gibi
// dönüyordu), 6 saat ise fazla sertti: "akşam kapat, sabah aç" senaryosunda kopya HER ZAMAN
// eskiyor ve kalıcı önbelleğin varlık sebebi olan anında açılış çalışmıyordu. 3 gün ikisinin
// arasında: hafta içi her sabah anında açılır, gerçekten bayat veri de dönmez. Yanıt kendi
// hesap zamanını taşıdığı için ekran zaten "X önce güncellendi" diyor.
const MAX_DISK_AGE_MS = 3 * 24 * 60 * 60_000;

/**
 * Kural değişimi hesabın ortasına denk gelirse kaç kez yeniden hesaplanacağının sınırı.
 * Sınırsız döngü olmasın diye var; pratikte tek yeniden hesap yeter.
 */
const MAX_RECOMPUTE_ATTEMPTS = 3;

function cacheFile(): string | null {
  return process.env.MLHUB_ORDERS_CACHE_FILE?.trim() || null;
}

/**
 * Gövdeye hesaplama zamanı damgası koyar (yoksa). Damgayı normalde /api/orders yazar; burası
 * yalnız güvenlik ağı: damga olmadan ekran "ne zaman güncellendi" satırını gösteremez ve eski
 * bir kopya yeniymiş gibi görünür.
 */
function stampComputedAt(body: Record<string, unknown>, at: number): Record<string, unknown> {
  const existing = body.computedAt;
  if (typeof existing === "string" || typeof existing === "number") return body;
  body.computedAt = new Date(at).toISOString();
  return body;
}

function loadDiskCacheOnce(): void {
  if (diskLoaded) return;
  diskLoaded = true;
  const file = cacheFile();
  if (!file) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      format?: number;
      at?: number;
      body?: unknown;
    };
    if (
      parsed.format === DISK_FORMAT &&
      typeof parsed.at === "number" &&
      Date.now() - parsed.at <= MAX_DISK_AGE_MS &&
      parsed.body &&
      typeof parsed.body === "object" &&
      !Array.isArray(parsed.body)
    ) {
      cache = {
        at: parsed.at,
        // Damga gövdenin KENDİ hesaplandığı ana ait olmalı — diskten okumak onu tazelemez.
        body: stampComputedAt(parsed.body as Record<string, unknown>, parsed.at),
      };
    }
  } catch {
    // Dosya yok/yarım kalmış/eski format → normal canlı hesap.
  }
}

function persistDiskCache(value: OrdersCacheEntry): void {
  const file = cacheFile();
  if (!file) return;
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({ format: DISK_FORMAT, ...value }),
      "utf8"
    );
  } catch {
    // Disk cache yalnız hızlandırmadır; yazılamaması sipariş akışını bozmamalı.
  }
}

export function getOrdersCache(): OrdersCacheEntry | null {
  loadDiskCacheOnce();
  return cache;
}
/** Devam eden hesap cache'e yazmadan önce bu nesli yakalar. */
export function getOrdersCacheGeneration(): number {
  return generation;
}
/**
 * Yalnız hesap başladığından beri invalidation olmadıysa sonucu yayınla.
 * Böylece eski bir background refresh, düşürülen cache'i sonradan geri dolduramaz.
 */
export function setOrdersCache(body: Record<string, unknown>, expectedGeneration: number): boolean {
  if (expectedGeneration !== generation) return false;
  // Aynı gövde ikinci kez yayınlanıyorsa (paylaşılan hesabı bekleyen ikinci istek) damgayı ve
  // yaşı OLDUĞU GİBİ bırak: yoksa hiç yeniden hesaplanmadan veri tazelenmiş gibi görünür.
  if (cache && cache.body === body) return true;
  const at = Date.now();
  cache = { at, body: stampComputedAt(body, at) };
  persistDiskCache(cache);
  return true;
}
/** Fiyatlama girdisi değişti → önbeleği düş, sonraki /api/orders yeni kurallarla hesaplasın. */
export function invalidateOrdersCache(): void {
  generation += 1;
  cache = null;
  const file = cacheFile();
  if (file) {
    try { fs.rmSync(file, { force: true }); } catch { /* sonraki istek canlı hesaplar */ }
  }
}
export function isOrdersRefreshing(): boolean {
  return refreshing;
}
export function setOrdersRefreshing(v: boolean): void {
  refreshing = v;
}

// ── Paylaşılan hesap (tekilleştirme + nesil koruması) ────────────────────────────────────────
// Panel, Siparişler, Raporlar ve arka plan izleyici aynı anda tetikleyebiliyor; hepsi TEK hesabı
// paylaşır. Paylaşımın gizli tuzağı buydu: hesap gen 5'te başlarken kullanıcı kuralı değiştirip
// gen 6'ya geçtiğinde, sonradan gelen istek gen 6'yı yakalıyor ama gen 5'in sonucunu alıyordu →
// eski kurallı kâr hem ekrana hem önbelleğe gidiyordu ("Yenile"ye iki kez basmak gerekiyordu).
// Artık bekleyen hesap KENDİ neslini taşır: yayın anında nesil eskimişse sonuç atılır ve
// hesap yeni kurallarla baştan koşar.
let pendingCompute:
  | { generation: number; promise: Promise<Record<string, unknown>> }
  | null = null;

export async function computeOrdersShared(
  compute: () => Promise<Record<string, unknown>>
): Promise<Record<string, unknown>> {
  let lastBody: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < MAX_RECOMPUTE_ATTEMPTS; attempt += 1) {
    let current = pendingCompute;
    if (!current || current.generation !== generation) {
      const entry = { generation, promise: compute() };
      pendingCompute = entry;
      // Hata da olsa bekleyen kaydı temizle; kimliğe bakıyoruz ki YENİ hesabı silmeyelim.
      void entry.promise
        .catch(() => {})
        .finally(() => {
          if (pendingCompute === entry) pendingCompute = null;
        });
      current = entry;
    }
    lastBody = await current.promise;
    if (current.generation === generation) {
      setOrdersCache(lastBody, current.generation);
      return lastBody;
    }
    // Nesil eskidi → sonucu YAYINLAMA, yeni kurallarla yeniden hesapla.
  }
  // Kurallar üst üste değişti: elde olanı döndür ama ÖNBELLEĞE YAZMA — bir sonraki istek taze hesaplar.
  return lastBody ?? {};
}
