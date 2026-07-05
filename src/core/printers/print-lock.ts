/**
 * Yazıcı-başına eşzamanlı baskı-başlatma kilidi (süreç içi).
 *
 * Aynı yazıcıya iki baskı başlatma isteği aynı anda gelirse (masaüstü çift tık, masaüstü +
 * telefon relay komutu, iki pencere) ikisi de "yazıcı boşta" ön kontrolünü geçebilir → çift
 * upload + çift start yarışı. Başlatma akışının tamamı (upload + start + doğrulama) kilit
 * altında koşar; ikinci istek net "meşgul" hatası alır.
 */
const active = new Set<string>();

/** Kilidi almayı dene — alınamazsa false (çağıran "meşgul" hatası üretir). */
export function tryAcquirePrintLock(printerConfigId: string): boolean {
  if (active.has(printerConfigId)) return false;
  active.add(printerConfigId);
  return true;
}

export function releasePrintLock(printerConfigId: string): void {
  active.delete(printerConfigId);
}
