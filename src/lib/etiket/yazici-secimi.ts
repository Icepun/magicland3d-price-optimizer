/**
 * Hangi yazıcıya etiket gidecek? Saf karar — dosya/işletim sistemi yok, test edilebilir.
 *
 * 1. Kullanıcının seçtiği yazıcı hâlâ listedeyse o.
 * 2. Değilse adından etiket yazıcısı olduğu anlaşılan ilk yazıcı (Xprinter, Zebra, TSC…).
 * 3. Hiçbiri yoksa null → arayüz yazıcı seçtirir. Ofis yazıcısına (HP vb.) ASLA tahminle
 *    gönderilmez: ZPL orada sayfalarca anlamsız yazı olarak basılır.
 */

const ETIKET_YAZICISI = /xprinter|\bxp-?\d|zebra|\bzd\d|\bgk\d|\bgx\d|label|etiket|zpl|\btsc\b|godex|argox|rongta|honeywell|citizen cl|sato\b/i;

export function etiketYazicisiMi(ad: string): boolean {
  return ETIKET_YAZICISI.test(ad);
}

export function etiketYazicisiSec(
  yazicilar: readonly string[],
  kayitli: string | null
): { yazici: string | null; elleSecildi: boolean } {
  if (kayitli && yazicilar.includes(kayitli)) return { yazici: kayitli, elleSecildi: true };
  const tahmin = yazicilar.find(etiketYazicisiMi) ?? null;
  return { yazici: tahmin, elleSecildi: false };
}
