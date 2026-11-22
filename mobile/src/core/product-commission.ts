import type { CommissionRuleInput } from "./types";
import { HB_KOMISYON_KDV, hbSatisOncesiKesintiler } from "./hb-kesinti";

/** Shopify sabit komisyon oranı (kesir, örn. 0.032). AppSetting'ten okunur, default %3.2. */
export function getShopifyCommissionRate(
  settings: Record<string, string | undefined>
): number {
  const pct = Number(settings.shopifyCommissionRate ?? 3.2);
  return Number.isFinite(pct) ? pct / 100 : 0.032;
}

/**
 * Bir listing için komisyon override'ını çözer:
 * - Listing'in kendi commissionRate/Fixed override'ı varsa onu kullan
 * - Yoksa ve platform Shopify ise → global Shopify sabit komisyonu
 * - Yoksa ve platform Trendyol ise → {} (kategori bazlı commissionRules kullanılır)
 */
/** Bir ilanın fiyat hesabına taşıdığı pazaryerine özel girdiler (motor girdisine doğrudan yayılır). */
export interface ListingPricingOverride {
  commissionRateOverride?: number;
  commissionFixedOverride?: number;
  /** İlanın kendi satış KDV oranı (%) — biliniyorsa. */
  saleVatRate?: number;
  /** Tahsilat bedeli oranı (KDV hariç fiyat üzerinden). */
  paymentFeeRate?: number;
  /** Kuraldaki sabit bedelin yerine geçen tutar (0 = bu ilanda kesilmiyor). */
  fixedExpenseOverride?: number;
}

/** İlandan okunan, fiyat hesabını etkileyen alanlar. Son ikisi yalnız Hepsiburada'da anlamlı. */
export interface ListingPricingFields {
  platform: string;
  commissionRate: number | null;
  commissionFixed: number | null;
  /** Kargoya verme süresi (gün) — Hepsiburada hizmet bedeli buna göre kesilir. */
  dispatchDays?: number | null;
  /** İlanın satış KDV oranı (%). */
  vatRate?: number | null;
}

/**
 * SATIŞ ÖNCESİ fiyat hesabı için ilanın TÜM pazaryerine özel girdileri: komisyon + (Hepsiburada)
 * tahsilat bedeli, hizmet bedeli ve ilanın KDV oranı. Ürünler ekranı, Panel, fiyat hesabı ve
 * telefon bunu motor girdisine yayar. Sipariş kârı bunu KULLANMAZ — orada kesintiler siparişin
 * kendisinden gelir (`resolveListingCommissionOnly`).
 */
export function resolveListingCommissionOverride(
  listing: ListingPricingFields,
  settings: Record<string, string | undefined>
): ListingPricingOverride {
  const komisyon = resolveListingCommissionOnly(listing, settings);
  if (listing.platform !== "hepsiburada") return komisyon;
  return { ...komisyon, ...hbSatisOncesiKesintiler(listing, settings) };
}

/** Yalnız komisyon (eski davranış) — sipariş kârı satırlarında kullanılır. */
export function resolveListingCommissionOnly(
  listing: { platform: string; commissionRate: number | null; commissionFixed: number | null },
  settings: Record<string, string | undefined>
): { commissionRateOverride?: number; commissionFixedOverride?: number } {
  if (listing.commissionRate != null || listing.commissionFixed != null) {
    // HEPSİBURADA ORANLARI KDV HARİÇTİR. Hepsiburada komisyonu "%10 + KDV" diye bildirir ve ilana
    // da o girilir; kesilen tutar oran × 1,2'dir (ölçüldü 22 Kas 2026: 152 kalemde birebir, panel
    // aynı ürün için "%12 KDV dahil" yazıyor). Motor oranı KDV DAHİL beklediği için burada çevrilir;
    // çevrilmezken Hepsiburada komisyonu her yerde %16,7 eksik düşülüyordu. Trendyol oranları
    // zaten KDV dahildir (ödeme kayıtlarıyla doğrulandı) → dokunulmaz.
    const kdvCarpani = listing.platform === "hepsiburada" ? 1 + HB_KOMISYON_KDV / 100 : 1;
    return {
      commissionRateOverride:
        listing.commissionRate != null ? listing.commissionRate * kdvCarpani : undefined,
      commissionFixedOverride: listing.commissionFixed ?? undefined,
    };
  }
  if (listing.platform === "shopify") {
    return { commissionRateOverride: getShopifyCommissionRate(settings) };
  }
  return {};
}

export function withProductCommissionRule<T extends { id: string; name: string; categoryName: string; commissionRate?: number | null }>(
  product: T,
  commissionRules: CommissionRuleInput[]
): CommissionRuleInput[] {
  if (product.commissionRate === null || product.commissionRate === undefined) {
    return commissionRules;
  }

  return [
    {
      id: `product-commission-${product.id}`,
      name: `Ürün bazlı komisyon - ${product.name}`,
      categoryName: product.categoryName,
      minPrice: 0,
      maxPrice: 999999,
      commissionRate: product.commissionRate,
      fixedCommission: 0,
      priority: 10_000,
      isActive: true,
    },
    ...commissionRules,
  ];
}
