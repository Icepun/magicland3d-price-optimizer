import { simulatePrice, trendyolMinQty } from "@core/pricing-engine";
import { resolveProductCost } from "@core/product-cost";
import {
  withProductCommissionRule,
  resolveListingCommissionOverride,
} from "@core/product-commission";
import {
  filterCargoRulesByPlatform,
  filterRulesByPlatform,
} from "@core/cargo-calculator";
import type {
  SimulationResult,
  CommissionRuleInput,
  CargoRuleInput,
  ExpenseRuleInput,
} from "@core/types";

import type { ProductDetail } from "@/lib/db/product-detail";
import type { Platform } from "@/lib/platforms";

export interface PlatformProfit {
  listingId: string;
  platform: Platform;
  salePrice: number;
  result: SimulationResult;
  /** Trendyol min sipariş adedi (>1 ise liste "×N" rozeti gösterir). */
  minOrderQty: number;
  /** Pazaryeri (Trendyol/HB) komisyon kaynağı yok (override yok + kural eşleşmedi) → kâr
   *  olduğundan yüksek görünür. Masaüstü ürün detayı v0.19.66 ile aynı uyarı koşulu. */
  commissionMissing: boolean;
}

export interface ProductProfit {
  productionCost: number;
  packagingCost: number;
  totalCost: number;
  hasCost: boolean;
  platforms: PlatformProfit[];
}

export interface Rules {
  commission: CommissionRuleInput[];
  cargo: CargoRuleInput[];
  expense: ExpenseRuleInput[];
}

/**
 * Bir ürünün her platform listing'i için kâr hesabı — masaüstü /api/products ve
 * /api/products/[id]/profit ile BİREBİR aynı (@core paylaşımı). Tek kaynak.
 */
export function computeProductProfit(
  detail: ProductDetail,
  rules: Rules,
  settings: Record<string, string>
): ProductProfit {
  const resolved = resolveProductCost(
    detail.cost ? { ...detail.cost, tapeUsed: !!detail.cost.tapeUsed } : null,
    settings,
    detail.cost?.costPerGram ?? 0
  );
  const productCost = resolved?.productionCost ?? 0;
  const packagingCost = resolved?.packagingCost ?? 0;
  const filamentMatCost = resolved?.filamentCost ?? 0; // KDV iadesine giren malzeme payı
  const vatRate = Number(settings.vatRate ?? 0);

  const productRules = withProductCommissionRule(detail, rules.commission);

  const platforms: PlatformProfit[] = detail.listings.map((listing) => {
    const result = simulatePrice({
      salePrice: listing.salePrice,
      productCost,
      packagingCost,
      categoryName: detail.categoryName,
      desi: detail.desi ?? 1,
      commissionRules: productRules,
      cargoRules: filterCargoRulesByPlatform(rules.cargo, listing.platform),
      expenseRules: filterRulesByPlatform(rules.expense, listing.platform),
      vatRate,
      ...resolveListingCommissionOverride(listing, settings),
      // Shopify sepet min 150₺ → <150₺ ürün tek başına satılamaz, kargo paylaşılır → 0.
      cargoCostOverride:
        listing.cargoCost ??
        (listing.platform === "shopify" && listing.salePrice < 150 ? 0 : undefined),
      // Trendyol min sipariş adedi → kâr N-adetlik sipariş üzerinden (masaüstüyle birebir).
      minOrderQty: listing.platform === "trendyol" ? trendyolMinQty(listing.salePrice) : 1,
      vatableProductCost: filamentMatCost,
    });
    return {
      listingId: listing.id,
      platform: listing.platform,
      salePrice: listing.salePrice,
      result,
      minOrderQty: result.minOrderQty,
      commissionMissing:
        (listing.platform === "trendyol" || listing.platform === "hepsiburada") &&
        !result.appliedCommissionRule &&
        listing.commissionRate == null,
    };
  });

  return {
    productionCost: productCost,
    packagingCost,
    totalCost: resolved?.totalCost ?? 0,
    hasCost: productCost > 0,
    platforms,
  };
}
