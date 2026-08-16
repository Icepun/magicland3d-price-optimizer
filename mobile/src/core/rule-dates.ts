/**
 * KURAL TARİHLERİNİ CANLANDIR — süzgecin ölmesini engelleyen tek satırlık ama kritik iş.
 *
 * SORUN (ölçüldü, 16 Ağu 2026): Ürün detay ve Fiyat Lab ekranları kargo/komisyon kurallarını
 * `fetchJson("/api/cargo-rules")` ile ham JSON olarak çekiyordu. JSON'da `validFrom`/`validTo`
 * METİNDİR. Motorlar ise şu karşılaştırmayı yapar:
 *
 *     if (r.validFrom && date < r.validFrom) return false;
 *
 * `date` bir Date, `r.validFrom` bir metin olunca JS ikisini de sayıya çevirir; metin `NaN`
 * olur ve NaN'lı HER karşılaştırma `false` döner → süzgeç hiçbir şeyi elemez. Sonuç: süresi
 * dolmuş TEMMUZ tarifesi hâlâ aday kalıyor ve eşit `priority` yüzünden sıralamada önce geldiği
 * için KAZANIYORDU. 0-2 desi bandında kargo 77,54 hesaplanıyordu, oysa güncel tarife 81,95 —
 * o ekranlarda kâr olduğundan yüksek görünüyordu.
 *
 * Sunucu yolları etkilenmiyordu (Prisma gerçek `Date` verir); bozuk olan yalnız istemcide
 * hesaplanan önizlemelerdi.
 *
 * Bu yüzden kural listesi motora girmeden ÖNCE buradan geçmeli.
 */

/** Tarih alanı; kaynağa göre Date, ISO metin, epoch-ms sayı ya da boş gelebilir. */
type HamTarih = Date | string | number | null | undefined;

interface TarihliKural {
  validFrom?: HamTarih;
  validTo?: HamTarih;
}

/** Tek bir tarih alanını `Date`e çevirir; çözülemezse `null` (= sınırsız) döner. */
export function kuralTarihi(deger: HamTarih): Date | null {
  if (deger == null) return null;
  if (deger instanceof Date) return Number.isNaN(deger.getTime()) ? null : deger;
  if (typeof deger === "number") return Number.isFinite(deger) ? new Date(deger) : null;
  const t = Date.parse(deger);
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * Kural listesindeki `validFrom`/`validTo` alanlarını gerçek `Date`e çevirir.
 *
 * ⚠️ Çözülemeyen tarih `null` olur, yani kural SINIRSIZ sayılır. Bilinçli: bozuk bir tarih
 * yüzünden kuralı tamamen elemek, kargoyu sessizce kuralsız bırakmaktan daha kötü olurdu.
 */
export function reviveRuleDates<T extends TarihliKural>(kurallar: readonly T[]): T[] {
  return kurallar.map((r) => {
    const from = kuralTarihi(r.validFrom);
    const to = kuralTarihi(r.validTo);
    // Zaten Date ise yeni nesne üretme (gereksiz render tetiklemesin).
    if (from === r.validFrom && to === r.validTo) return r;
    return { ...r, validFrom: from, validTo: to };
  });
}
