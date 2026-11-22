/**
 * TRENDYOL KESİNTİLERİ — sipariş satırından, teslimden ÖNCE gösterilen tahmini kâr için.
 *
 * Trendyol panelinin "Sipariş Kayıtları" ekranıyla karşılaştırıldı (22 Kas 2026):
 *   • Komisyon, platform hizmet bedeli ve ciro zaten tutuyordu (oranlar KDV dahil).
 *   • ULUSLARARASI HİZMET BEDELİ: mikro ihracat siparişinde satış tutarının %6'sı — üç teslim
 *     edilmiş siparişte birebir (153,11 → 9,19 · 160,29 → 9,61 · 749,97 → 45,00). Uygulama hiç
 *     düşmüyordu; yurt dışı siparişlerin kârı o kadar yüksek görünüyordu.
 *   • STOPAJ: e-ticaret stopajı (7524 sayılı kanun) KDV hariç satış tutarının %1'i — vergiden
 *     mahsup edilir, KÂRA GİRMEZ; dökümde bilgi olarak gösterilir (Berke'nin kararı).
 *   • Satış KDV'si satırın kendi oranıyla (Trendyol satırda `vatRate` bildiriyor).
 *
 * Teslimden sonra komisyon ve kargo Trendyol'un gerçek kayıtlarından gelir (lib/trendyol-finance).
 * Masaüstü ve telefon aynı fonksiyonu çağırır.
 */

/** Mikro ihracat siparişinde uluslararası hizmet bedeli ÷ satış tutarı (KDV dahil fatura). */
export const TY_ULUSLARARASI_HIZMET_ORANI = 0.06;
/** Stopaj ÷ KDV hariç satış tutarı. */
export const TY_STOPAJ_ORANI = 0.01;

const kurus = (tl: number) => Math.round(tl * 100) / 100;

export interface TyKalemHesabi {
  /** Satırın satış KDV oranı (%) — Trendyol bildirdiyse; mikro ihracatta 0. */
  saleVatRate: number | null;
  /** Satırın stopajı (TL, adet dahil) — yalnız bilgi. */
  stoppage: number;
  /** Uluslararası hizmet bedeli (brüt TL, adet dahil) — yalnız mikro ihracatta. */
  internationalFee: number;
}

/**
 * Trendyol sipariş satırı → kâr hesabının ek satır girdileri.
 * `satirTutari`: satırın tamamı (birim fiyat × adet, satıcı indirimi düşülmüş — `price` alanı).
 */
export function tyKalemHesabi(
  satir: { vatRate?: unknown },
  satirTutari: number,
  secenek: { mikroIhracat?: boolean } = {}
): TyKalemHesabi {
  const tutar = Number.isFinite(satirTutari) && satirTutari > 0 ? satirTutari : 0;
  // ⚠️ null/boş "bilinmiyor"dur: Number(null) 0 verir ve satış KDV'si sessizce %0 sayılırdı.
  const kdvHam = satir.vatRate == null || satir.vatRate === "" ? Number.NaN : Number(satir.vatRate);
  const bildirilen = Number.isFinite(kdvHam) && kdvHam >= 0 && kdvHam < 100 ? kdvHam : null;
  // Mikro ihracat satışı KDV'den istisna — satır ne derse desin cirodan KDV ayrılmaz.
  const saleVatRate = secenek.mikroIhracat ? 0 : bildirilen;
  const kdvHaric = tutar / (1 + (saleVatRate ?? 20) / 100);
  return {
    saleVatRate,
    stoppage: kurus(kdvHaric * TY_STOPAJ_ORANI),
    internationalFee: secenek.mikroIhracat ? kurus(tutar * TY_ULUSLARARASI_HIZMET_ORANI) : 0,
  };
}
