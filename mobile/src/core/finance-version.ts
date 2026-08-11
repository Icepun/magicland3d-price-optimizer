/**
 * Aylık finans hesap sürümü — masaüstü ve mobil AYNI değeri yazmalı.
 *
 * Mobil eskiden sabit 1 yazıyor, masaüstü 2 yazıyordu; mobil bir satıra dokununca masaüstünün
 * sürüm damgasını 1'e düşürüyordu. "Sürümü N'den eski satırları yeniden hesapla" türü bir
 * geri-doldurma yazıldığı gün yanlış kümeyi seçerdi. Tek kaynak burada (sync-core ile paylaşılır).
 */
// v3: bu sürümde sipariş kârının çekirdek formülü değişti (maliyet bilinirliği kapısı, tamamen
// iade edilmiş satırın elenmesi, KDV yedeği, gider kuralı kategori eşleşmesi). Sürümü artırmak
// hiçbir rakamı KENDİLİĞİNDEN değiştirmez; yalnızca eski damgalı ayları "güncel değil" olarak
// işaretler ki kullanıcı isterse "Bu ayı yeniden hesapla" diyebilsin.
// KURAL: çekirdek kâr formülüne dokunan her değişiklikte bu sayı artar.
export const FINANCE_CALCULATION_VERSION = 3;

/**
 * Bu satır GÜNCEL hesapla mı yazılmış?
 *
 * NEDEN tek yerde: "yeniden hesapla" eylemi hem hangi ayın bayat olduğunu işaretlemek hem de
 * yazımdan sonra damgayı güncellemek için aynı karşılaştırmayı yapıyor. İki tarafta ayrı ayrı
 * `< FINANCE_CALCULATION_VERSION` yazılırsa sürüm arttığı gün biri güncellenmeyi unutur.
 */
export function isFinanceSnapshotOutdated(calculationVersion: number): boolean {
  return calculationVersion < FINANCE_CALCULATION_VERSION;
}
