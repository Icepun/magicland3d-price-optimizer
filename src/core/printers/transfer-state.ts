/**
 * "BU YAZICIYA ŞU AN DOSYA AKTARIYORUZ" kaydı.
 *
 * NEDEN VAR (21 Ağu 2026, ölçüldü): Snapmaker U1'e büyük bir dosya yüklenirken yazıcı
 * %40-50 civarında ağdan tamamen düşüyordu — ICMP yok, 7125/80/22'nin üçü de "bağlantı
 * reddedildi" değil ZAMAN AŞIMI veriyordu (yani adreste yanıt veren cihaz kalmıyor), aynı
 * anda Neptune 4 Pro 2 ms'de cevap veriyordu. Aktarım da o anda düşüyor.
 *
 * Kartın WiFi'ı zaten doymuşken biz üstüne durum sorgusu bindiriyorduk: panel açıkken
 * `/api/printers` her turda bu yazıcıyı yokluyor, relay 10 saniyede bir aynısını yapıyor.
 * `commandInFlight` freni yalnız duraklat/iptal gibi KOMUTLARI kapsıyor, aktarımı değil.
 *
 * Bu modül aktarım süresince yoklamayı susturur:
 *   • Yazıcıya binen gereksiz yük kalkar (düşmenin bir sebebi ortadan kalkar).
 *   • Kart "Yazıcıya ulaşılamadı" YALANINI söylemez — aktarım sürerken son bilinen durum
 *     gösterilir, ilerleme zaten üstteki çubukta akıyor.
 *
 * ⚠️ Ayrı modül olmasının sebebi döngüsel import: `status-cache` zaten `moonraker`'ı
 * içe aktarıyor, aktarımı başlatan da `moonraker`. İkisi de buraya bakar.
 *
 * ⚠️ `processSingleton`: Next, relay'i (instrumentation) rotalardan ayrı pakete derliyor.
 * Modül kapsamında tutulsa relay'in kopyası aktarımdan haberdar olmaz ve yoklamaya devam ederdi.
 */
import { processSingleton } from "./process-singleton";

/** host → aktarımın en geç biteceği an (ms). Süre dolarsa kayıt kendiliğinden düşer. */
const aktarimlar = processSingleton("printer_aktarimlar", () => new Map<string, number>());

/**
 * Aktarım başladı. `tavanMs` bir emniyet kemeri: süreç aktarımı bitiremeden çökerse
 * (ya da `aktarimBitti` çağrısı bir şekilde atlanırsa) yoklama sonsuza dek susmaz.
 */
export function aktarimBasladi(host: string, tavanMs = 30 * 60_000): void {
  aktarimlar.set(host, Date.now() + tavanMs);
}

export function aktarimBitti(host: string): void {
  aktarimlar.delete(host);
}

/** Bu adrese şu an dosya aktarılıyor mu? */
export function aktarimSuruyor(host: string): boolean {
  const bitis = aktarimlar.get(host);
  if (bitis == null) return false;
  if (Date.now() > bitis) {
    aktarimlar.delete(host); // emniyet kemeri devrede
    return false;
  }
  return true;
}

/** Testler için. */
export function aktarimlariSifirla(): void {
  aktarimlar.clear();
}
