import { simulatePrice } from "@core/pricing-engine";
import { platformMinOrderQty, shopifyCargoOverride } from "@core/platform-rules";
import { packagingScopeInput, resolveProductCost } from "@core/product-cost";
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
  /** Raporlar için kaynak platformun (yoksa ilk gerçek listing'in) net kârı. */
  currentNetProfit: number | null;
}

export interface Rules {
  commission: CommissionRuleInput[];
  cargo: CargoRuleInput[];
  expense: ExpenseRuleInput[];
  /**
   * Trendyol settlement kayıtları (gerçek komisyon) — dış sipariş kimliğine göre.
   * Masaüstü bunu kâra uyguluyordu, mobil uygulamıyordu → aynı sipariş iki cihazda farklı
   * kâr gösteriyordu. Artık iki taraf da çekirdekteki resolveOrderProfit'i besliyor.
   */
  financialByExternalId?: Map<string, { actualCommission: number; settlementRevenue: number }>;
  /** Aynı sipariş numarası TEKİLSE güvenli fallback (settlement'ta shipmentPackageId yoksa). */
  financialByOrderNumber?: Map<string, { actualCommission: number; settlementRevenue: number }[]>;
}

/**
 * Ürün-nesnesi kimliğine göre kâr önbelleği. Kural/ayar referansı da aynıysa yeniden hesaplamaz.
 * Optimistic güncellemeler (stok +/-) dizide YALNIZ değişen ürünün referansını yeniler →
 * 420/421 ürün önbellekten gelir; eskiden tek dokunuş tüm sekmelerde ~1300+ simulatePrice
 * zincirini tetikliyordu. Ekranlar (ürünler/panel/raporlar) bu memo'yu kullanır.
 */
const profitCache = new WeakMap<
  ProductDetail,
  { rules: Rules; settings: Record<string, string>; value: ProductProfit }
>();
export function computeProductProfitMemo(
  detail: ProductDetail,
  rules: Rules,
  settings: Record<string, string>
): ProductProfit {
  const hit = profitCache.get(detail);
  if (hit && hit.rules === rules && hit.settings === settings) return hit.value;
  const value = computeProductProfit(detail, rules, settings);
  profitCache.set(detail, { rules, settings, value });
  return value;
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
  const hasCost = resolved?.productionCostKnown ?? false;
  const vatRate = Number(settings.vatRate ?? 0);

  const productRules = withProductCommissionRule(detail, rules.commission);

  const platforms: PlatformProfit[] = detail.listings.map((listing) => {
    const result = simulatePrice({
      salePrice: listing.salePrice,
      productCost,
      packagingCost,
      ...packagingScopeInput(resolved),
      categoryName: detail.categoryName,
      desi: detail.desi ?? 1,
      commissionRules: productRules,
      cargoRules: filterCargoRulesByPlatform(rules.cargo, listing.platform),
      expenseRules: filterRulesByPlatform(rules.expense, listing.platform),
      vatRate,
      ...resolveListingCommissionOverride(listing, settings),
      // Platform kuralları TEK kaynaktan (@core/platform-rules) → masaüstüyle birebir.
      cargoCostOverride:
        listing.cargoCost ?? shopifyCargoOverride(listing.platform, listing.salePrice),
      minOrderQty: platformMinOrderQty(listing.platform, listing.salePrice),
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

  // Rapor metriği tek bir gerçek platform sonucundan gelir; platform kuralları karışmaz.
  let currentNetProfit: number | null = null;
  if (hasCost) {
    const preferredPlatforms = [
      detail.source,
      "shopify",
      "trendyol",
      "hepsiburada",
    ];
    const primary = preferredPlatforms
      .map((platform) => platforms.find((summary) => summary.platform === platform))
      .find(Boolean);
    if (primary) {
      currentNetProfit = primary.result.netProfit;
    } else {
      const fallbackPlatform: Platform =
        detail.source === "trendyol" ||
        detail.source === "hepsiburada" ||
        detail.source === "shopify"
          ? detail.source
          : "shopify";
      const sim = simulatePrice({
        salePrice: detail.currentSalePrice,
        productCost,
        packagingCost,
        ...packagingScopeInput(resolved),
        categoryName: detail.categoryName,
        desi: detail.desi ?? 1,
        commissionRules: productRules,
        cargoRules: filterCargoRulesByPlatform(rules.cargo, fallbackPlatform),
        expenseRules: filterRulesByPlatform(rules.expense, fallbackPlatform),
        vatRate,
        ...resolveListingCommissionOverride(
          {
            platform: fallbackPlatform,
            commissionRate: null,
            commissionFixed: null,
          },
          settings
        ),
        cargoCostOverride: shopifyCargoOverride(fallbackPlatform, detail.currentSalePrice),
        minOrderQty: platformMinOrderQty(fallbackPlatform, detail.currentSalePrice),
        vatableProductCost: filamentMatCost,
      });
      currentNetProfit = sim.netProfit;
    }
  }

  return {
    productionCost: productCost,
    packagingCost,
    totalCost: resolved?.totalCost ?? 0,
    hasCost,
    platforms,
    currentNetProfit,
  };
}
