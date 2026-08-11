/**
 * Aylık finans hesap sürümü — masaüstü ve mobil AYNI değeri yazmalı.
 *
 * Mobil eskiden sabit 1 yazıyor, masaüstü 2 yazıyordu; mobil bir satıra dokununca masaüstünün
 * sürüm damgasını 1'e düşürüyordu. "Sürümü N'den eski satırları yeniden hesapla" türü bir
 * geri-doldurma yazıldığı gün yanlış kümeyi seçerdi. Tek kaynak burada (sync-core ile paylaşılır).
 */
export const FINANCE_CALCULATION_VERSION = 2;

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
