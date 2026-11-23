/**
 * DÖNEMLİ AYAR — KDV oranı ve Shopify komisyonu gibi tek değerli kâr ayarlarının GEÇMİŞİ.
 *
 * NEDEN (Berke'nin onayı, 23 Kas 2026): oran değişince geçmiş siparişler de yeni oranla
 * hesaplanıyordu. KDV'de son ~2 haftanın kayıtlı kârları bir sonraki senkronda yeni oranla
 * yeniden yazılıyor, "Yeniden hesapla" da geçmiş Shopify siparişlerini bugünkü komisyonla
 * yazıyordu. Kargo tarifelerinde olduğu gibi artık her sipariş KENDİ tarihindeki oranı kullanır;
 * ürün ekranları (satış öncesi) bugünkü oranı kullanmaya devam eder.
 *
 * Kayıt biçimi: AppSetting `<anahtar>Gecmisi` = JSON `[{ bas: ISO | null, deger: string }]`,
 * `bas`a göre artan. `bas: null` = en baştan beri. Geçmiş yoksa ayarın kendisi her tarihte geçerli
 * (eski davranış birebir). En son dönem için HER ZAMAN ayarın kendisi okunur: ayar başka bir
 * yoldan (geri yükleme vb.) değişip geçmiş güncellenmediyse bugünkü siparişler yine doğru oranı alır.
 */

export const DONEMLI_AYAR_ANAHTARLARI = ["vatRate", "shopifyCommissionRate"] as const;
export type DonemliAyarAnahtari = (typeof DONEMLI_AYAR_ANAHTARLARI)[number];

export interface DonemliKayit {
  /** Dönemin başladığı an (ISO); null = en baştan beri. */
  bas: string | null;
  /** O dönemde geçerli ham ayar değeri ("" = ayar girilmemişti → okuyucunun varsayılanı). */
  deger: string;
}

export function gecmisAnahtari(anahtar: DonemliAyarAnahtari): string {
  return `${anahtar}Gecmisi`;
}

function basMs(k: DonemliKayit): number {
  return k.bas == null ? Number.NEGATIVE_INFINITY : Date.parse(k.bas);
}

/** Ham JSON → geçerli kayıtlar (bozuk satırlar atlanır), başlangıca göre artan. */
export function donemliGecmisOku(ham: string | null | undefined): DonemliKayit[] {
  if (!ham) return [];
  let veri: unknown;
  try {
    veri = JSON.parse(ham);
  } catch {
    return [];
  }
  if (!Array.isArray(veri)) return [];
  const kayitlar: DonemliKayit[] = [];
  for (const x of veri) {
    if (!x || typeof x !== "object") continue;
    const { bas, deger } = x as { bas?: unknown; deger?: unknown };
    if (typeof deger !== "string") continue;
    if (bas !== null && (typeof bas !== "string" || !Number.isFinite(Date.parse(bas)))) continue;
    kayitlar.push({ bas: bas as string | null, deger });
  }
  return kayitlar.sort((a, b) => basMs(a) - basMs(b));
}

/**
 * `tarih` anında geçerli ham değer. Tarih yoksa, geçmiş yoksa ya da tarih son dönemin içindeyse
 * ayarın KENDİSİ döner.
 */
export function donemliDeger(
  settings: Record<string, string | undefined> | null | undefined,
  anahtar: DonemliAyarAnahtari,
  tarih: Date | null | undefined,
): string | undefined {
  const guncel = settings?.[anahtar];
  if (!tarih || !Number.isFinite(tarih.getTime())) return guncel;
  const gecmis = donemliGecmisOku(settings?.[gecmisAnahtari(anahtar)]);
  if (gecmis.length === 0) return guncel;
  const t = tarih.getTime();
  // Son dönem (ya da sonrası) → ayarın kendisi.
  if (t >= basMs(gecmis[gecmis.length - 1])) return guncel;
  for (let i = gecmis.length - 2; i >= 0; i--) {
    if (t >= basMs(gecmis[i])) return gecmis[i].deger === "" ? undefined : gecmis[i].deger;
  }
  // İlk kaydın başlangıcından önce: geçmiş o tarihi bilmiyor → en eski bilinen değer.
  return gecmis[0].deger === "" ? undefined : gecmis[0].deger;
}

/**
 * Sipariş kârı için ayar haritası: dönemli anahtarlar `tarih`teki değerle değiştirilir, gerisi
 * aynen kalır. Geçmiş yoksa aynı nesne döner (eşitlik: eski davranış birebir).
 */
export function donemliAyarlar(
  settings: Record<string, string | undefined>,
  tarih: Date | null | undefined,
): Record<string, string | undefined> {
  if (!tarih) return settings;
  let sonuc: Record<string, string | undefined> | null = null;
  for (const anahtar of DONEMLI_AYAR_ANAHTARLARI) {
    if (!settings[gecmisAnahtari(anahtar)]) continue;
    const deger = donemliDeger(settings, anahtar, tarih);
    if (deger === settings[anahtar]) continue;
    sonuc ??= { ...settings };
    sonuc[anahtar] = deger;
  }
  return sonuc ?? settings;
}

/**
 * Ayar değişince geçmişe yeni dönem ekler. İlk değişiklikte eski değer "en baştan beri" diye
 * tohumlanır → değişiklikten önceki siparişler eski oranla kalır. Değer aynıysa geçmiş değişmez
 * (null döner = yazmaya gerek yok).
 */
export function donemliGecmiseEkle(
  ham: string | null | undefined,
  eskiDeger: string | null | undefined,
  yeniDeger: string,
  simdi: Date,
): string | null {
  const eski = eskiDeger ?? "";
  if (eski === yeniDeger) return null;
  const gecmis = donemliGecmisOku(ham);
  if (gecmis.length === 0) gecmis.push({ bas: null, deger: eski });
  const son = gecmis[gecmis.length - 1];
  const an = simdi.toISOString();
  if (son.deger === yeniDeger) return null;
  // Aynı anda (ya da saat geri kaymışken) ikinci değişiklik: son dönemin değerini güncelle.
  if (son.bas != null && Date.parse(son.bas) >= simdi.getTime()) son.deger = yeniDeger;
  else gecmis.push({ bas: an, deger: yeniDeger });
  return JSON.stringify(gecmis);
}
