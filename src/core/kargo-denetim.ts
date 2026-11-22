/**
 * KARGO DENETİMİ — pazaryerinin kestiği kargo, ürünün desisine göre beklenenden PAHALIYSA.
 *
 * Pazaryeri (kargo firması) paketi kendisi ölçüyor ve sık sık ürünün kayıtlı desisinden büyük
 * kesiyor (ölçüldü 22 Kas 2026: Hepsiburada'da 14 siparişte 1 → 4 desi). Bu durumda itiraz
 * edilebilir: Trendyol'da Kargo İşlemleri → Desi İtiraz İşlemleri (paket numarasıyla), Hepsiburada'da
 * satıcı desteği. Yalnız fiyatı ARTIRAN fazla desi sayılır — barem siparişinde desi fiyatı değiştirmez.
 * Masaüstü ve telefon aynı fonksiyonu kullanır.
 */

export interface FazlaDesi {
  /** Ürünlerin kayıtlı desisiyle fiyatlanan desi. */
  bizimDesi: number;
  /** Pazaryerinin kestiği desi. */
  kesilenDesi: number;
  /** Fazladan ödenen kargo (brüt TL). */
  fazla: number;
}

/** İtiraza değmeyecek kadar küçük fark (TL). */
const ESIK_TL = 1;

export function fazlaDesiBul(g: {
  kesilenDesi: number | null | undefined;
  bizimDesi: number | null | undefined;
  /** Kesilen kargo (brüt TL). */
  gercekKargo: number | null | undefined;
  /** Ürün desisiyle tarifeden beklenen kargo (brüt TL). */
  tahminiKargo: number | null | undefined;
}): FazlaDesi | null {
  const { kesilenDesi, bizimDesi, gercekKargo, tahminiKargo } = g;
  if (kesilenDesi == null || bizimDesi == null || gercekKargo == null || tahminiKargo == null) return null;
  if (![kesilenDesi, bizimDesi, gercekKargo, tahminiKargo].every(Number.isFinite)) return null;
  const kesilen = Math.ceil(kesilenDesi - 1e-9);
  if (kesilen <= bizimDesi) return null;
  const fazla = Math.round((gercekKargo - tahminiKargo) * 100) / 100;
  if (fazla < ESIK_TL) return null;
  return { bizimDesi, kesilenDesi: kesilen, fazla };
}
