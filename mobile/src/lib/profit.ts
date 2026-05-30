import { simulatePrice } from "@core/pricing-engine";
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

export interface PlatformProfit {
  listingId: string;
  platform: "shopify" | "trendyol";
  salePrice: number;
  result: SimulationResult;
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
      cargoCostOverride: listing.cargoCost ?? undefined,
    });
    return {
      listingId: listing.id,
      platform: listing.platform,
      salePrice: listing.salePrice,
      result,
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
