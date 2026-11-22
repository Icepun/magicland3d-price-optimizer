/**
 * HEPSİBURADA KESİNTİLERİ — sipariş kaleminden, teslimden ÖNCE gösterilen tahmini kâr için.
 *
 * Kurallar Hepsiburada'nın kendi muhasebe kayıtlarından ÖLÇÜLDÜ (22 Kas 2026, son 6 hafta,
 * teslim edilmiş 152 kalem — aşağıdaki oranların her biri 152/152 kalemde birebir tuttu):
 *
 *   • Komisyon      : ilan oranı × 1,2 (oran KDV HARİÇ bildirilir; fatura %20 KDV'li).
 *                     Taban = müşterinin ödediği + Hepsiburada'nın karşıladığı indirim.
 *   • HB indirimi   : Hepsiburada'nın karşıladığı indirim satıcıya GERİ ÖDENİR → satıcının geliri
 *                     müşterinin ödediğinden fazladır (450 ödenen + 49,99 indirim = 499,99).
 *   • Tahsilat      : KDV hariç ödenen tutarın %0,96'sı (KDV dahil tutar; ödeme hizmeti yansıtması).
 *   • Stopaj        : KDV hariç ödenen tutarın %1'i — vergiden mahsup edilir, KÂRA GİRMEZ.
 *   • Satış KDV'si  : ilanın kendi oranı (104 kalem %20, 48 kalem %10).
 *   • Hizmet bedeli : her siparişe DEĞİL — 152 kalemin 34'ünde, 13,19 TL. 32'si kargoya verme süresi
 *                     2 gün olan tek üründe (o üründe 32/32); süresi 1 gün olanlarda 120'de 2.
 *
 * Teslimden sonra bu tahminlerin yerini muhasebe servisinden gelen GERÇEK kayıtlar alır.
 * Masaüstü ve telefon aynı fonksiyonu çağırır (iki cihaz aynı kârı göstersin).
 */
import { gecerliSiparisOrani, hbSiparisKomisyonOrani } from "./order-commission";

/** Komisyon faturasının KDV oranı (%). */
export const HB_KOMISYON_KDV = 20;
/** Tahsilat bedeli (KDV dahil) ÷ KDV hariç ödenen tutar. */
export const HB_TAHSILAT_ORANI = 0.0096;
/** Stopaj ÷ KDV hariç ödenen tutar. */
export const HB_STOPAJ_ORANI = 0.01;
/** Hizmet bedeli (KDV dahil, sipariş başına) — ölçülen tutar. Ayarlarda `hbServiceFee` varsa o kullanılır. */
export const HB_HIZMET_BEDELI = 13.19;
/** Kargoya verme süresi bu kadar gün ve üstüyse hizmet bedeli kesilir. */
export const HB_HIZMET_BEDELI_ESIK_GUN = 2;
/** İlanın KDV oranı bildirilmediyse tahsilat/stopaj tabanı için varsayılan (%). */
const VARSAYILAN_URUN_KDV = 20;

/** `{ amount }` nesnesi, düz sayı ya da sayı metni → sayı (geçersizse NaN). */
function sayi(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "amount" in (v as Record<string, unknown>)) {
    return Number((v as { amount?: unknown }).amount);
  }
  if (v == null || v === "") return Number.NaN;
  return Number(v);
}

const kurus = (tl: number) => Math.round(tl * 100) / 100;

export interface HbKalemHesabi {
  /** Satıcının birim geliri = müşterinin ödediği + Hepsiburada'nın karşıladığı indirim. */
  unitPrice: number;
  /** Müşterinin ödediği birim fiyat (tahsilat ve stopajın tabanı). */
  paidUnitPrice: number;
  /** Hepsiburada'nın karşıladığı birim indirim (yoksa 0). */
  hbDiscountUnit: number;
  /** Siparişte kesilen komisyon — KDV DAHİL kesir, `unitPrice`'a göre. Bilinmiyorsa null. */
  commissionRate: number | null;
  /** İlanın satış KDV oranı (%); bildirilmediyse null. */
  saleVatRate: number | null;
  /** Satırın tahsilat bedeli (brüt TL, adet dahil). */
  paymentFee: number;
  /** Satırın stopajı (TL, adet dahil) — yalnız bilgi. */
  stoppage: number;
  /** Kargoya verme süresi (gün); bildirilmediyse null. */
  dispatchDays: number | null;
}

/**
 * Hepsiburada sipariş/detay kalemi → kâr hesabının satır girdileri.
 * `paidUnitPrice`: çağıranın zaten çözdüğü, müşterinin ödediği birim fiyat (`unitPrice`/`totalPrice`).
 */
export function hbKalemHesabi(
  kalem: Record<string, unknown>,
  quantity: number,
  paidUnitPrice: number
): HbKalemHesabi {
  const adet = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
  const odenen = Number.isFinite(paidUnitPrice) && paidUnitPrice > 0 ? paidUnitPrice : 0;

  const indirim = (kalem.hbDiscount ?? null) as { unitPrice?: unknown; totalPrice?: unknown } | null;
  let hbDiscountUnit = sayi(indirim?.unitPrice);
  if (!(hbDiscountUnit > 0)) hbDiscountUnit = sayi(indirim?.totalPrice) / adet;
  if (!Number.isFinite(hbDiscountUnit) || hbDiscountUnit < 0) hbDiscountUnit = 0;
  const unitPrice = odenen + hbDiscountUnit;

  // Oran KDV hariç bildirilir; kesilen tutar da KDV hariçtir ve indirim ÖNCESİ fiyat üzerindendir.
  const kdvHaric = hbSiparisKomisyonOrani(kalem as { commissionRate?: unknown; commission?: unknown }, unitPrice);
  const commissionRate =
    kdvHaric == null
      ? null
      : gecerliSiparisOrani(Math.round(kdvHaric * (1 + HB_KOMISYON_KDV / 100) * 1_000_000) / 1_000_000);

  const kdv = sayi(kalem.vatRate);
  const saleVatRate = Number.isFinite(kdv) && kdv >= 0 && kdv < 100 ? kdv : null;

  // Tahsilat ve stopajın tabanı müşterinin ÖDEDİĞİ tutarın KDV hariç hâlidir (HB indirimi dahil değil).
  const odenenNet = (odenen * adet) / (1 + (saleVatRate ?? VARSAYILAN_URUN_KDV) / 100);

  const gun = sayi(kalem.dispatchTime);
  return {
    unitPrice,
    paidUnitPrice: odenen,
    hbDiscountUnit,
    commissionRate,
    saleVatRate,
    paymentFee: kurus(odenenNet * HB_TAHSILAT_ORANI),
    stoppage: kurus(odenenNet * HB_STOPAJ_ORANI),
    dispatchDays: Number.isFinite(gun) && gun >= 0 ? gun : null,
  };
}

/**
 * Bu siparişe hizmet bedeli kesilir mi, ne kadar? (brüt TL; 0 = kesilmez)
 *
 * Kural ölçümden: kargoya verme süresi 2+ gün olan kalem varsa kesilir. Süre bilinmiyorsa
 * "kesilmez" sayılır (ölçümde süresi 1 gün olan 120 kalemin 118'inde kesilmedi). Geç gönderim gibi
 * istisnalar teslimden sonra gerçek kayıtla düzelir.
 */
export function hbHizmetBedeli(
  kalemler: ReadonlyArray<{ dispatchDays?: number | null }>,
  settings?: Record<string, string | undefined>
): number {
  const kesilir = kalemler.some(
    (k) => typeof k.dispatchDays === "number" && k.dispatchDays >= HB_HIZMET_BEDELI_ESIK_GUN
  );
  if (!kesilir) return 0;
  const ayar = Number(settings?.hbServiceFee);
  return Number.isFinite(ayar) && ayar > 0 ? ayar : HB_HIZMET_BEDELI;
}

/**
 * SATIŞ ÖNCESİ (Ürünler ekranı, Panel, fiyat hesabı): bir Hepsiburada ilanının fiyat motoruna
 * taşıdığı kesintiler. Sipariş kârıyla AYNI kurallar; fark yalnız verinin ilandan gelmesi.
 *
 *   • tahsilat bedeli : KDV hariç fiyatın %0,96'sı — her ilanda
 *   • hizmet bedeli   : kargoya verme süresi 2+ gün ise; süre bilinmiyorsa kesilmez sayılır
 *                       (gider kuralındaki "her ilana" sabit bedelin YERİNE geçer)
 *   • satış KDV'si    : ilanın kendi oranı biliniyorsa o; bilinmiyorsa genel oran
 */
export function hbSatisOncesiKesintiler(
  ilan: { dispatchDays?: number | null; vatRate?: number | null },
  settings?: Record<string, string | undefined>
): { paymentFeeRate: number; fixedExpenseOverride: number; saleVatRate?: number } {
  const kdv = ilan.vatRate;
  return {
    paymentFeeRate: HB_TAHSILAT_ORANI,
    fixedExpenseOverride: hbHizmetBedeli([{ dispatchDays: ilan.dispatchDays ?? null }], settings),
    ...(typeof kdv === "number" && Number.isFinite(kdv) && kdv >= 0 && kdv < 100 ? { saleVatRate: kdv } : {}),
  };
}
