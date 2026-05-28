import type { CommissionRuleInput } from "./types";

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
export function resolveListingCommissionOverride(
  listing: { platform: string; commissionRate: number | null; commissionFixed: number | null },
  settings: Record<string, string | undefined>
): { commissionRateOverride?: number; commissionFixedOverride?: number } {
  if (listing.commissionRate != null || listing.commissionFixed != null) {
    return {
      commissionRateOverride: listing.commissionRate ?? undefined,
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
