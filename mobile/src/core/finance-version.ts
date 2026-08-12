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
/**
 * ⚠️ v3'te BIRAKILDI (2026-08-12) — bilerek, unutulduğu için değil.
 *
 * `productionCostKnown` kapısı sıkılaştırıldı (malzeme payı 0 ise maliyet artık "bilinmiyor").
 * Kural gereği bu sayının artması gerekirdi; ölçüm bunu GEREKSİZ kıldı: canlı verideki 284
 * detaylı maliyet kaydının TAMAMINDA filament türü seçili ve malzeme bedeli > 0, yani hiçbir
 * mevcut kayıt yeni kuralla farklı sonuç vermiyor → bayat snapshot YOK. Sayıyı artırmak tüm
 * geçmiş siparişleri "eski hesaplamayla kayıtlı" gösterip yüzlerce siparişi gereksiz yere
 * yeniden hesaplatırdı (uzak veritabanında her sorgu ~96ms).
 *
 * ARTIRMA KOŞULU: kâr formülü ya da maliyet kapısı, MEVCUT bir kaydın sonucunu değiştirecek
 * biçimde değişirse artır. Değiştirip artırmazsan Raporlar o ayları "yeniden hesapla" diye
 * HİÇ işaretlemez ve eski rakamlar kalıcı olur.
 */
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
