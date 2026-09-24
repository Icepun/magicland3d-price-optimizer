import { YAZICI_DURUM_ADI, durumAnahtari } from "@core/printer-status";

import { color } from "../theme/tokens";

export { bitisSaati, kalanSure, katmanMetni, yazicilariSirala } from "@core/printer-status";

/**
 * YAZICI DURUMU — Atölye, Yazıcılar ve yazıcı ekranı TEK tablodan okur.
 *
 * Bir tur iki ayrı tablo vardı ve birbirini tutmuyordu: Atölye'de basan yazıcı yeşil
 * "Yazdırıyor", biten mor "Bitti"; Yazıcılar ekranında basan mor, biten yeşil "Tamamlandı".
 * Aynı yazıcı iki ekranda farklı renkte görünüyordu. Anlam: yeşil = iş başarıyla bitti,
 * mor (marka) = şu an basıyor. Adlar ve sıralama `@core/printer-status`te (kökte test edilir).
 *
 * ⚠️ Kökteki testler bu dosyayı İÇE AKTARMAMALI: tema dosyası `react-native` tiplerini çekiyor,
 * kökteki `tsc` de onların global `FormData`'sını görüp masaüstü rotalarında sahte hata veriyor.
 */
const RENK: Record<string, string> = {
  printing: color.accentBright,
  paused: color.warn,
  finished: color.good,
  idle: color.textDim,
  error: color.bad,
  offline: color.textFaint,
};

export const YAZICI_DURUM: Record<string, { label: string; color: string }> = Object.fromEntries(
  Object.entries(YAZICI_DURUM_ADI).map(([k, label]) => [k, { label, color: RENK[k] ?? color.textDim }])
);

export function durumBilgisi(status: string, online: boolean | number = true): { label: string; color: string } {
  return YAZICI_DURUM[durumAnahtari(status, online)];
}
