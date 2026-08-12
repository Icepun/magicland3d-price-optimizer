/**
 * Trendyol zaman damgası çevirisi — TEK KAYNAK.
 *
 * SORUN (12 Ağu 2026'da kullanıcı Trendyol satıcı panelinden doğruladı):
 *   sipariş 11499653852 → uygulamamız "21:03", Trendyol paneli "18:03".
 *
 * Trendyol'un `orderDate` alanı epoch milisaniye GİBİ görünüyor ama gerçek bir UTC anı
 * değil: Türkiye DUVAR SAATİNİ epoch'a çevirmiş hâli. Yani 18:03'te verilen sipariş,
 * "1970'ten beri geçen ms" olarak 18:03 UTC'ye denk gelen sayıyı taşıyor. Biz bunu
 * `new Date(epoch)` ile gerçek an sanıp arayüzde `Europe/Istanbul` (+3) ile
 * biçimlendirince üstüne 3 saat daha biniyor.
 *
 * İSTATİSTİKSEL DOĞRULAMA (aynı gün, çalışan uygulamanın kendi verisiyle):
 *   gece 02:00-06:00 arası sipariş oranı
 *     Trendyol %21,3  |  Shopify %2,2  |  Hepsiburada %4,3
 *   Trendyol 3 saat geri alınınca oran %6,3'e düşüp diğer platformlara oturuyor.
 *   (Shopify ve Hepsiburada DOĞRU çalışıyor — onların tarih yollarına dokunulmadı.)
 *
 * NEDEN SABİT 3 SAAT: Türkiye 2016'dan beri yaz saati uygulamıyor, kalıcı UTC+3.
 * Bu yüzden "duvar saatini Europe/Istanbul olarak yorumla" ile "3 saat çıkar" yıl
 * boyunca AYNI sonucu verir. Sabit çıkarma seçildi çünkü saat dilimi veritabanına
 * bağımlı değil ve testi kesin. DST geri gelirse burası tek değiştirilecek yer.
 */

/** Türkiye kalıcı UTC+3 (2016'dan beri yaz saati yok). */
const TR_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Trendyol'un duvar-saati epoch'unu gerçek UTC anına çevirir.
 * Geçersiz/eksik değerde `null` döner — çağıran "tarih yok" durumunu kendisi ele alsın.
 * (BİLİNMEYEN ≠ SIFIR: 0'a düşürüp 1970'e yazmıyoruz.)
 */
export function trendyolDateToUtc(value: number | string | null | undefined): Date | null {
  if (value == null || value === "") return null;
  const ms = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms - TR_OFFSET_MS);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Aynı çeviri, doğrudan ISO metin olarak (rota katmanı böyle kullanıyor). */
export function trendyolDateToIso(value: number | string | null | undefined): string | null {
  return trendyolDateToUtc(value)?.toISOString() ?? null;
}

/**
 * Trendyol'a GÖNDERİLEN pencere sınırı (startDate/endDate).
 *
 * Trendyol sorgu parametrelerini de aynı duvar-saati düzleminde yorumluyorsa, gerçek
 * UTC gönderdiğimizde pencere 3 saat geriye kayar ve EN YENİ siparişler listeye hiç
 * girmez. Hangi düzlemi kullandıkları belgelenmediği için pencereyi iki uçtan da
 * genişletiyoruz: fazladan gelen satırlar rotanın kendi kırpması ile zaten eleniyor,
 * eksik gelen satırın telafisi ise yok.
 */
export function padTrendyolWindow(bound: number, edge: "start" | "end"): number {
  return edge === "start" ? bound - TR_OFFSET_MS : bound + TR_OFFSET_MS;
}
