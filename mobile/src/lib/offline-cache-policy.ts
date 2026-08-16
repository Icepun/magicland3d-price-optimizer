/**
 * ÇEVRİMDIŞI ÖNBELLEK KURALLARI — saf karar mantığı (dosya/ağ dokunuşu YOK).
 *
 * Ayrı dosya çünkü `offline-cache.ts` `expo-file-system`'i içe aktarıyor ve kökteki testlerde
 * çözülemiyor; kurallar burada durunca gerçek kod test edilebiliyor
 * (bkz. src/lib/mobile-offline-cache.test.ts).
 */

/** Dosya biçimi değişirse eski dosya okunmaz — çöp veriyle açılmaktansa boş açılmak iyidir. */
export const ONBELLEK_BICIMI = 2;

/** Bu yaştan eski önbellek atılır: "geçen haftaki siparişler" diye açılmasın. */
export const ONBELLEK_MAKSIMUM_YAS_MS = 3 * 24 * 60 * 60_000;

/**
 * Diske yazılan sorgular. LİSTE BİLİNÇLİ OLARAK DAR: açılışta gösterilen ve ağır olan veriler
 * var. ANLIK durumlar (yazıcı anlık görüntüsü) YOK — kapanışta %62'de olan baskıyı ertesi gün
 * "%62 sürüyor" diye göstermek yanlış bilgi olurdu; o veri her açılışta canlı çekilir.
 */
export const KALICI_SORGULAR: readonly string[] = [
  "orders",
  "match-products",
  "products",
  "rules",
  "settings",
  "dashboard-data",
  "spools",
  "notifications",
  "prep-done",
  "monthly-finance",
];

/** Sorgu anahtarının kökü diske yazılmalı mı? */
export function kaliciSorguMu(queryKey: readonly unknown[]): boolean {
  const kok = queryKey[0];
  return typeof kok === "string" && KALICI_SORGULAR.includes(kok);
}

/** Diskten okunan dosya kullanılabilir mi? (biçim doğru + fazla eski değil) */
export function onbellekGecerliMi(
  dosya: { bicim?: unknown; yazilma?: unknown } | null | undefined,
  simdi: number
): boolean {
  if (!dosya || dosya.bicim !== ONBELLEK_BICIMI) return false;
  const yazilma = typeof dosya.yazilma === "number" ? dosya.yazilma : 0;
  if (yazilma <= 0) return false;
  // Gelecek tarihli damga (cihaz saati geri alınmış) → güvenme.
  if (yazilma > simdi + 60_000) return false;
  return simdi - yazilma <= ONBELLEK_MAKSIMUM_YAS_MS;
}
