/**
 * Siparişler sunucu önbelleği (stale-while-revalidate) — PAYLAŞILAN modül.
 *
 * /api/orders 3 pazaryerinden canlı çeker (1-3sn) + kâr'ı fiyatlama kurallarıyla (kargo/komisyon/
 * gider/maliyet) hesaplar. Sonuç 60sn önbeklenir. SORUN: bu kurallar değişince önbeklenmiş gövde
 * ESKİ kurallarla hesaplanmış kalır → kâr güncellenmez (uygulama yeniden başlayana dek). ÇÖZÜM:
 * kural değiştiren rotalar (kargo modu vb.) invalidateOrdersCache() çağırır → sonraki istek TAZE
 * hesaplar. Önbellek Electron ana sürecinde tek instance (modül-düzeyi state).
 */
let cache: { at: number; body: Record<string, unknown> } | null = null;
let refreshing = false;

export function getOrdersCache(): { at: number; body: Record<string, unknown> } | null {
  return cache;
}
export function setOrdersCache(body: Record<string, unknown>): void {
  cache = { at: Date.now(), body };
}
/** Fiyatlama girdisi değişti → önbeleği düş, sonraki /api/orders yeni kurallarla hesaplasın. */
export function invalidateOrdersCache(): void {
  cache = null;
}
export function isOrdersRefreshing(): boolean {
  return refreshing;
}
export function setOrdersRefreshing(v: boolean): void {
  refreshing = v;
}
