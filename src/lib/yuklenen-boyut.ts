import { prisma } from "@/lib/prisma";

/**
 * YAZICIYA YÜKLENEN DOSYANIN GERÇEK BOYUTU — "yazıcıda hazır" kısayolu için.
 *
 * NEDEN (19 Kas 2026 denetimi): U1'e (Snapmaker) gönderilen G-code'a parça iptali için
 * EXCLUDE_OBJECT komutları ekleniyor (moonraker.ts → excludeObjectEkle); dosya ~%0,9 büyüyor.
 * Baskı rotası "dosya yazıcıda zaten var mı?" sorusunu yazıcıdaki boyutu ÖZGÜN boyutla
 * karşılaştırarak soruyordu → bu dosyalarda hiç tutmuyor, aynı dosya her baskıda yeniden
 * indirilip yükleniyordu (baskı günlüğü: aynı dosyanın tekrarı 65 / 137 / 95 sn).
 *
 * Çözüm: yükleme bitince yazıcıya giden dosyanın boyutu, içerik imzalı yükleme adıyla
 * (`ad-md5ilk10.gcode`) saklanır. Ad içeriğin özetini taşıdığı için aynı ad + aynı boyut =
 * aynı dosya. Kayıt AppSetting'te (Mac ve Windows aynı yazıcılara basıyor).
 */
const ANAHTAR = "printers.yuklenenBoyutlar";
/** Saklanan en çok kayıt — eskiler düşer (yazıcı kartı zaten sınırlı sayıda dosya tutuyor). */
export const YUKLENEN_BOYUT_TAVANI = 400;

type Harita = Record<string, number>;

/** Saf: haritaya yeni kaydı ekle, tavanı aşarsa en eskileri at (ekleme sırası korunur). */
export function yuklenenBoyutEkle(harita: Harita, ad: string, boyut: number, tavan = YUKLENEN_BOYUT_TAVANI): Harita {
  const yeni: Harita = {};
  for (const [k, v] of Object.entries(harita)) if (k !== ad) yeni[k] = v;
  yeni[ad] = boyut;
  const anahtarlar = Object.keys(yeni);
  for (const k of anahtarlar.slice(0, Math.max(0, anahtarlar.length - tavan))) delete yeni[k];
  return yeni;
}

function coz(deger: string | null | undefined): Harita {
  if (!deger) return {};
  try {
    const j = JSON.parse(deger) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) return {};
    const temiz: Harita = {};
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) temiz[k] = v;
    }
    return temiz;
  } catch {
    return {};
  }
}

/** Bu yükleme adıyla daha önce yazıcıya giden dosyanın boyutu (bilinmiyorsa null). */
export async function yuklenenBoyutOku(ad: string): Promise<number | null> {
  try {
    const satir = await prisma.appSetting.findUnique({ where: { key: ANAHTAR } });
    return coz(satir?.value)[ad] ?? null;
  } catch {
    return null; // okunamazsa kısayol eskisi gibi yalnız özgün boyutla dener
  }
}

/** Yükleme başarıyla bitti: yazıcıdaki dosyanın boyutunu kaydet. Hata baskıyı ASLA bozmaz. */
export async function yuklenenBoyutYaz(ad: string, boyut: number): Promise<void> {
  try {
    const satir = await prisma.appSetting.findUnique({ where: { key: ANAHTAR } });
    const deger = JSON.stringify(yuklenenBoyutEkle(coz(satir?.value), ad, boyut));
    await prisma.appSetting.upsert({ where: { key: ANAHTAR }, create: { key: ANAHTAR, value: deger }, update: { value: deger } });
  } catch {
    /* kısayol bir sonraki baskıda yine yükleme yapar — zararsız */
  }
}
