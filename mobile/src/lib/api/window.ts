/**
 * Sipariş penceresi (son 30 gün) için ORTAK cutoff — UTC gün başına yuvarlanmış.
 *
 * Neden: `Date.now() - 30*gün` her saniye kayar; masaüstü ile mobil farklı anlarda sorgu
 * atınca tam 30-gün çizgisindeki sipariş birinde içeride, diğerinde dışarıda kalır → iki
 * platformda farklı sayı görünür. Gün başına sabitleyince iki uygulama da AYNI gün boyunca
 * AYNI cutoff'u üretir (yalnızca UTC gece yarısı ilerler) → sayılar her zaman eşleşir.
 *
 * ⚠️ Masaüstü `src/app/api/orders/route.ts` AYNI formülü kullanmalı (birebir senkron).
 */
export const ORDER_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** Son 30 günün başlangıcı (UTC gece yarısı), epoch ms. */
export function orderWindowCutoff(): number {
  return (Math.floor(Date.now() / DAY_MS) - ORDER_WINDOW_DAYS) * DAY_MS;
}
