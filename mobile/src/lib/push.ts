/**
 * Push bildirimleri — OTA GÜVENLİ NO-OP.
 *
 * NEDEN NO-OP: expo-notifications & expo-device NATIVE modüllerdir. Sahadaki yüklü iOS binary'si
 * bunları İÇERMİYOR (son native EAS build expo-notifications package.json'a eklenmeden önce, commit
 * 49ed542'te alındı; app.json plugins'inde de "expo-notifications" YOK). Bu modüllere herhangi bir
 * şekilde (üst-seviye VEYA dinamik `import()`) DOKUNMAK, Metro'nun onları JS bundle'a koymasına ve
 * native modül yokken `requireNativeModule`/`requireNativeViewManager` ile açılışta ÇÖKMESİNE yol açar.
 *
 * Bu dosya KASITLI olarak SIFIR expo-import içerir → Metro `expo-notifications`/`expo-device`'ı
 * bundle'a HİÇ koymaz → native modülü olmayan binary'de açılış çökmesi GARANTİ önlenir (sadece-JS OTA).
 *
 * GERÇEK PUSH'U GERİ AÇMAK İÇİN (gelecekte):
 *   1. app.json "plugins" dizisine "expo-notifications" ekle.
 *   2. expo-notifications + expo-device paketleri kuruluyken YENİ bir native EAS build al ve dağıt.
 *   3. Bu dosyadaki gerçek registerForPush implementasyonunu git geçmişinden (bafe1a4 öncesi
 *      defensive sürüm: dinamik import + try/catch) geri getir — AMA ancak yeni binary yayıldıktan sonra.
 */

/** No-op. Native push modülü olmayan binary'de açılış çökmesini önlemek için kasıtlı boş. */
export async function registerForPush(): Promise<void> {
  // İntentionally empty — see file header. Hiçbir expo native modülüne dokunmaz.
}
