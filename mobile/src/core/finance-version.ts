/**
 * Aylık finans hesap sürümü — masaüstü ve mobil AYNI değeri yazmalı.
 *
 * Mobil eskiden sabit 1 yazıyor, masaüstü 2 yazıyordu; mobil bir satıra dokununca masaüstünün
 * sürüm damgasını 1'e düşürüyordu. "Sürümü N'den eski satırları yeniden hesapla" türü bir
 * geri-doldurma yazıldığı gün yanlış kümeyi seçerdi. Tek kaynak burada (sync-core ile paylaşılır).
 */
export const FINANCE_CALCULATION_VERSION = 2;
