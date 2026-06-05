import { simulatePrice, trendyolMinQty } from "@core/pricing-engine";
import { resolveProductCost } from "@core/product-cost";
import {
  withProductCommissionRule,
  resolveListingCommissionOverride,
} from "@core/product-commission";
import { filterCargoRulesByPlatform, filterRulesByPlatform } from "@core/cargo-calculator";

import type { ProductDetail, ListingRow } from "@/lib/db/product-detail";
import type { Rules } from "@/lib/profit";
import type { Platform } from "@/lib/platforms";

const MARGINS = [20, 30, 40, 50];
const DISCOUNTS = [10, 15, 20, 25, 30];

export interface PriceLabTarget {
  platform: Platform;
  currentPrice: number;
  currentMargin: number;
  rows: { margin: number; price: number | null }[];
}
export interface PriceLabCampaign {
  rows: { discount: number; effectivePrice: number; profit: number; margin: number }[];
}
export interface PriceLab {
  hasCost: boolean;
  targets: PriceLabTarget[];
  campaign: PriceLabCampaign | null;
}

/**
 * Fiyat Laboratuvarı — masaüstü /api/products/[id]/price-lab ile aynı (@core paylaşımı).
 * (a) hedef marj için gereken satış fiyatı (KDV dahil), (b) Shopify kampanya/zarar simülasyonu.
 * Tamamı cihazda hesaplanır.
 */
export function computePriceLab(
  detail: ProductDetail,
  rules: Rules,
  settings: Record<string, string>
): PriceLab {
  const resolved = resolveProductCost(
    detail.cost ? { ...detail.cost, tapeUsed: !!detail.cost.tapeUsed } : null,
    settings,
    detail.cost?.costPerGram ?? 0
  );
  const productCost = resolved?.productionCost ?? 0;
  const packagingCost = resolved?.packagingCost ?? 0;
  const filamentMatCost = resolved?.filamentCost ?? 0; // KDV iadesine giren malzeme payı
  if (productCost <= 0) return { hasCost: false, targets: [], campaign: null };

  const vatRate = Number(settings.vatRate ?? 0);
  const productRules = withProductCommissionRule(detail, rules.commission);

  const simFor = (listing: ListingRow, salePrice: number) =>
    simulatePrice({
      salePrice,
      productCost,
      packagingCost,
      categoryName: detail.categoryName,
      desi: detail.desi ?? 1,
      commissionRules: productRules,
      cargoRules: filterCargoRulesByPlatform(rules.cargo, listing.platform),
      expenseRules: filterRulesByPlatform(rules.expense, listing.platform),
      vatRate,
      ...resolveListingCommissionOverride(listing, settings),
      // Masaüstü price-lab route ile birebir: listing kargosu ya da otomatik (150₺-altı Shopify
      // özel kuralı YOK; o kural products route'a özgü, price-lab'da iki tarafta da uygulanmaz).
      cargoCostOverride: listing.cargoCost ?? undefined,
      minOrderQty: listing.platform === "trendyol" ? trendyolMinQty(salePrice) : 1,
      vatableProductCost: filamentMatCost,
    });

  // Marj fiyata göre monoton artar → ikili arama
  function priceForMargin(listing: ListingRow, targetPct: number): number | null {
    const tm = targetPct / 100;
    let lo = 0.5;
    let hi = 100000;
    if (simFor(listing, hi).profitMargin < tm) return null; // 100k TL'de bile ulaşılamıyor
    for (let i = 0; i < 44; i++) {
      const mid = (lo + hi) / 2;
      if (simFor(listing, mid).profitMargin >= tm) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  const targets: PriceLabTarget[] = detail.listings.map((listing) => {
    const cur = simFor(listing, listing.salePrice);
    return {
      platform: listing.platform,
      currentPrice: listing.salePrice,
      currentMargin: cur.profitMargin,
      rows: MARGINS.map((m) => ({ margin: m, price: priceForMargin(listing, m) })),
    };
  });

  const shopify = detail.listings.find((l) => l.platform === "shopify");
  let campaign: PriceLabCampaign | null = null;
  if (shopify) {
    campaign = {
      rows: DISCOUNTS.map((d) => {
        const eff = shopify.salePrice * (1 - d / 100);
        const r = simFor(shopify, eff);
        return { discount: d, effectivePrice: eff, profit: r.netProfit, margin: r.profitMargin };
      }),
    };
  }

  return { hasCost: true, targets, campaign };
}
