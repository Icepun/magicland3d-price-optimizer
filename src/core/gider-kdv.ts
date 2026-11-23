/**
 * GİDER KDV'Sİ — Gider Ödemeleri'ndeki tutarın içindeki KDV. TEK kural, masaüstü + telefon.
 *
 * Girilen tutar KDV DAHİL ödenen paradır. Oran seçilmişse:
 *     net  = tutar / (1 + oran / 100)      → aylık net kârdan bu düşer
 *     KDV  = tutar − net                   → o ayın "indirilecek KDV"sine eklenir
 *
 * NEDEN: sipariş kârı maliyetlerin indirilecek KDV'sini geri ekliyor (`order-profit.ts`), gider ise
 * KDV dahil tutarıyla düşülüyordu → KDV'li giderde net kâr KDV kadar düşük görünüyordu.
 *
 * ⚠️ Oran BOŞ / 0 / geçersiz → KDV indirilmez, net = tutar. Eski kayıtların hepsi böyle (kolon
 * v64'te NULL olarak açıldı), yani bu kural bugünkü rakamları DEĞİŞTİRMEZ.
 *
 * Kuruş TAMSAYI: net yuvarlanır, KDV farktan çıkar → net + KDV her zaman tutara eşit (kuruş kaybı yok).
 */

/** Formlarda sunulan oranlar (%). "Yok" = null. */
export const GIDER_KDV_ORANLARI = [1, 10, 20] as const;

/** Geçerli bir KDV oranı mı (0 < oran < 100)? Değilse null — "KDV indirilmez". */
export function gecerliGiderKdvOrani(oran: unknown): number | null {
  if (oran == null || oran === "") return null;
  const sayi = typeof oran === "number" ? oran : Number(oran);
  if (!Number.isFinite(sayi) || sayi <= 0 || sayi >= 100) return null;
  return sayi;
}

export interface GiderKdvAyrimi {
  /** KDV hariç tutar (kuruş) — net kârdan düşen. */
  netKurus: number;
  /** İçindeki KDV (kuruş) — indirilecek KDV. */
  kdvKurus: number;
}

/** KDV dahil tutarı (kuruş) net + KDV olarak ayırır. */
export function giderKdvAyir(tutarKurus: number, oran: unknown): GiderKdvAyrimi {
  const tutar = Number.isFinite(Number(tutarKurus)) ? Math.round(Number(tutarKurus)) : 0;
  const gecerli = gecerliGiderKdvOrani(oran);
  if (gecerli == null || tutar === 0) return { netKurus: tutar, kdvKurus: 0 };
  // `tutar * 100 / (100 + oran)`: `tutar / 1.2` gibi kayan nokta bölmesi 0,5 sınırında kuruş kaydırabiliyor.
  const netKurus = Math.round((tutar * 100) / (100 + gecerli));
  return { netKurus, kdvKurus: tutar - netKurus };
}

/** Net kârdan düşen tutar (kuruş). */
export function giderNetKurus(tutarKurus: number, oran: unknown): number {
  return giderKdvAyir(tutarKurus, oran).netKurus;
}

/** Listede gösterilen kısa etiket ("KDV %20"); KDV yoksa null. */
export function giderKdvEtiketi(oran: unknown): string | null {
  const gecerli = gecerliGiderKdvOrani(oran);
  if (gecerli == null) return null;
  return `KDV %${Number.isInteger(gecerli) ? gecerli : String(gecerli).replace(".", ",")}`;
}
