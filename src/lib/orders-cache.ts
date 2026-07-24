/**
 * Siparişler sunucu önbelleği (stale-while-revalidate) — PAYLAŞILAN modül.
 *
 * /api/orders 3 pazaryerinden canlı çeker (1-3sn) + kâr'ı fiyatlama kurallarıyla (kargo/komisyon/
 * gider/maliyet) hesaplar. Sonuç 60sn önbeklenir. SORUN: bu kurallar değişince önbeklenmiş gövde
 * ESKİ kurallarla hesaplanmış kalır → kâr güncellenmez (uygulama yeniden başlayana dek). ÇÖZÜM:
 * kural değiştiren rotalar (kargo modu vb.) invalidateOrdersCache() çağırır → sonraki istek TAZE
 * hesaplar. Önbellek Electron ana sürecinde tek instance (modül-düzeyi state).
 */
import fs from "node:fs";

let cache: { at: number; body: Record<string, unknown> } | null = null;
let refreshing = false;
let generation = 0;
let diskLoaded = false;
const DISK_FORMAT = 1;
const MAX_DISK_AGE_MS = 14 * 24 * 60 * 60_000;

function cacheFile(): string | null {
  return process.env.MLHUB_ORDERS_CACHE_FILE?.trim() || null;
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
        body: parsed.body as Record<string, unknown>,
      };
    }
  } catch {
    // Dosya yok/yarım kalmış/eski format → normal canlı hesap.
  }
}

function persistDiskCache(value: {
  at: number;
  body: Record<string, unknown>;
}): void {
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

export function getOrdersCache(): { at: number; body: Record<string, unknown> } | null {
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
  cache = { at: Date.now(), body };
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
