/**
 * AMS KARARI — baskı komutunda AMS kullanılsın mı? Renk ekranı (istemci) ile baskı ucu (sunucu)
 * AYNI kuralı kullanır; bu dosya bu yüzden saf (düğüm modülü yok, istemciye de girer).
 *
 * 23 Eyl 2026: AMS'si takılı olmayan A2L'ye `use_ams: true` gitti; yazıcı ısınıp başlangıçta
 * bekledi, baskı hiç başlamadı. Renk ekranı yazıcı yuva bildirmese de dört hayali yuva
 * gösteriyor ve AMS'yi varsayılan açık gönderiyordu.
 */

/** AMS'siz yazıcıda çok renkli dosya basılamaz — kullanıcıya gösterilen metin. */
export const AMS_YOK_COK_RENK = "Bu dosya çok renkli ama yazıcıda AMS takılı değil. Tek renkli bir dosya seç.";

/**
 * AMS takılı değilse her zaman dış makara; çok renkli dosya reddedilir. AMS durumu bilinmiyorsa
 * (`null`: rapor gelmedi) istenen aynen geçer — bilmediğimiz şeye göre baskıyı engellemeyiz.
 */
export function amsKarari(
  amsVar: boolean | null | undefined,
  istenen: boolean | undefined,
  renkSayisi: number,
): { useAms: boolean | undefined; hata: string | null } {
  if (amsVar !== false) return { useAms: istenen, hata: null };
  if (renkSayisi > 1) return { useAms: false, hata: AMS_YOK_COK_RENK };
  return { useAms: false, hata: null };
}
