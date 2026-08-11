/**
 * KDV oranının TEK okuma noktası.
 *
 * NEDEN: oran dokuz ayrı yerde `Number(settings.vatRate ?? 0)` ile okunuyordu. İki sessiz
 * arıza üretiyordu:
 *   • Ayar HİÇ yoksa (yeni kurulum) 0 kabul ediliyor → KDV hiç uygulanmıyor → TÜM kârlar
 *     yaklaşık %20 şişik görünüyor ve hiçbir uyarı çıkmıyor.
 *   • Ayar bozuksa ("", "yirmi", "20%") Number() NaN üretiyor → NaN hesabın içine sızıp
 *     kârı tamamen anlamsız yapıyor.
 *
 * Artık geçersiz her durumda Türkiye standart oranı %20 kabul edilir ve `invalid` bayrağı
 * ile arayüz kullanıcıyı uyarır. SIFIR geçerli bir tercihtir (KDV uygulanmasın) — bilerek
 * girilmiş 0 ile hiç girilmemiş değer birbirinden ayrılır.
 */

/** Ayar bozuk/eksikse kullanılacak oran — Türkiye'de standart KDV. */
export const DEFAULT_VAT_RATE = 20;

export interface ResolvedVatRate {
  /** Hesaplarda kullanılacak oran (yüzde). */
  rate: number;
  /** true = kayıtlı değer okunamadı, varsayılana düşüldü (kullanıcıya söylenmeli). */
  invalid: boolean;
}

export function resolveVatRate(
  settings: Record<string, string | undefined> | null | undefined
): ResolvedVatRate {
  const raw = settings?.vatRate;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { rate: DEFAULT_VAT_RATE, invalid: true };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    return { rate: DEFAULT_VAT_RATE, invalid: true };
  }
  return { rate: parsed, invalid: false };
}

/** Yalnız oranı isteyen çağrı yerleri için kısa yol. */
export function vatRateOf(
  settings: Record<string, string | undefined> | null | undefined
): number {
  return resolveVatRate(settings).rate;
}
