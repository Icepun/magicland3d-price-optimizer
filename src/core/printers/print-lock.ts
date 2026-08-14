/**
 * Yazıcı-başına eşzamanlı baskı-başlatma kilidi (süreç içi).
 *
 * Aynı yazıcıya iki baskı başlatma isteği aynı anda gelirse (masaüstü çift tık, masaüstü +
 * telefon relay komutu, iki pencere) ikisi de "yazıcı boşta" ön kontrolünü geçebilir → çift
 * upload + çift start yarışı. Başlatma akışının tamamı (upload + start + doğrulama) kilit
 * altında koşar; ikinci istek net "meşgul" hatası alır.
 */
import { processSingleton } from "./process-singleton";

/**
 * Kilit kümesi SÜREÇ GENELİNDE tek (`globalThis`). Modül kapsamında tutulunca kilit tam da
 * yukarıda sayılan "masaüstü + telefon relay komutu" durumunda ÇALIŞMIYORDU: relay ile API
 * rotaları ayrı paketlere derleniyor, her paket kendi kümesini taşıyordu ve iki taraf
 * birbirinin kilidini göremiyordu. Ayrıntı: `process-singleton.ts`.
 */
const active = processSingleton("printLock", () => new Set<string>());

/** Kilidi almayı dene — alınamazsa false (çağıran "meşgul" hatası üretir). */
export function tryAcquirePrintLock(printerConfigId: string): boolean {
  if (active.has(printerConfigId)) return false;
  active.add(printerConfigId);
  return true;
}

export function releasePrintLock(printerConfigId: string): void {
  active.delete(printerConfigId);
}
