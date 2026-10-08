/**
 * AÇILIŞ EKRANI NE ZAMAN KALKAR — saf kural (SplashScreen kullanır, testle kilitli).
 *
 * Eskiden yalnız Panel'in ["dashboard"] sorgusunu bekliyordu. Panel DIŞINDAKİ bir sayfa
 * yeniden yüklenince (Mac uykudan uyanınca Electron açık sayfayı yeniler) o sorgu hiç
 * çalışmadığı için logo 7 sn'lik güvenlik süresine kadar ekranda kalıyordu (9 Eki 2026 denetimi).
 * Artık açık sayfanın KENDİ ilk verisi beklenir: herhangi bir sorgu başlayıp hepsi bitince.
 */
export const SPLASH_MIN_MS = 550; // logo flaş etmesin
export const SPLASH_MAX_MS = 7000; // güvenlik: hiçbir zaman asılı kalmasın
/** Hiç sorgu başlamayan sayfa (yalnız durağan içerik) bu kadar sonra açılır. */
export const SPLASH_SORGUSUZ_MS = 1200;

export function splashKalksinMi(d: { gecenMs: number; sorguGoruldu: boolean; havadaSorgu: number }): boolean {
  if (d.gecenMs >= SPLASH_MAX_MS) return true;
  if (d.gecenMs < SPLASH_MIN_MS) return false;
  if (d.sorguGoruldu) return d.havadaSorgu === 0;
  return d.gecenMs >= SPLASH_SORGUSUZ_MS;
}
