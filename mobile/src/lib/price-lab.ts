import { simulatePrice, trendyolMinQty } from "@core/pricing-engine";
import { packagingScopeInput, resolveProductCost } from "@core/product-cost";
import {
  collectRulePriceBreakpoints,
  findMinimumPriceForMargin,
} from "@core/price-target";
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
  // Masaüstü price-lab route:37 ile birebir kapı: totalCost (yalnız paketleme maliyeti girilmiş
  // ürün de hesaplanır; eski productCost>0 kapısı onu yanlışlıkla "maliyet yok" sayıyordu).
  if (!resolved || resolved.totalCost <= 0) return { hasCost: false, targets: [], campaign: null };
  const productCost = resolved.productionCost;
  const packagingCost = resolved.packagingCost;
  const filamentMatCost = resolved.filamentCost; // KDV iadesine giren malzeme payı

  const vatRate = Number(settings.vatRate ?? 0);
  const productRules = withProductCommissionRule(detail, rules.commission);

  // Listing olmayan platformda masaüstü null-listing ile simüle eder (route:66-68) — aynı şekil.
  type LabListing = Pick<ListingRow, "platform" | "commissionRate" | "commissionFixed" | "cargoCost">;

  const simFor = (listing: LabListing, salePrice: number, discountBuffer = 0) =>
    simulatePrice({
      salePrice,
      productCost,
      packagingCost,
      ...packagingScopeInput(resolved),
      categoryName: detail.categoryName,
      desi: detail.desi ?? 1,
      commissionRules: productRules,
      cargoRules: filterCargoRulesByPlatform(rules.cargo, listing.platform),
      expenseRules: filterRulesByPlatform(rules.expense, listing.platform),
      vatRate,
      discountBuffer,
      ...resolveListingCommissionOverride(listing, settings),
      // Masaüstü price-lab route ile birebir: listing kargosu varsa onu kullanır; yoksa
      // Shopify'ın 150 TL altı ücretsiz kargo varsayımını kampanya sonrası etkin fiyata uygular.
      cargoCostOverride:
        listing.cargoCost ??
        (listing.platform === "shopify" &&
        salePrice * (1 - discountBuffer / 100) < 150
          ? 0
          : undefined),
      // Trendyol min sipariş adedi — karar: iki tarafta da uygulanır (masaüstü route'a da eklendi).
      minOrderQty: listing.platform === "trendyol" ? trendyolMinQty(salePrice) : 1,
      vatableProductCost: filamentMatCost,
    });

  // Kargo/min-adet eşiklerinde marj aşağı sıçrayabilir; her sabit aralığı ayrı ara.
  function priceForMargin(listing: LabListing, targetPct: number): number | null {
    const tm = targetPct / 100;
    const platformCargo = filterCargoRulesByPlatform(rules.cargo, listing.platform);
    const platformExpense = filterRulesByPlatform(rules.expense, listing.platform);
    const breakpoints = collectRulePriceBreakpoints(
      productRules,
      platformCargo,
      platformExpense
    );
    if (listing.platform === "trendyol") breakpoints.push(25, 35, 50, 75);
    if (listing.platform === "shopify") breakpoints.push(150);
    return findMinimumPriceForMargin({
      marginAt: (price) => simFor(listing, price).profitMargin,
      targetMargin: tm,
      breakpoints,
    });
  }

  // Masaüstü route:88-100 ile birebir: hiç listing yoksa Shopify hedefi currentSalePrice ile gösterilir.
  const listingPlatforms = detail.listings.map((l) => l.platform);
  const targetPlatforms: Platform[] = listingPlatforms.length > 0 ? listingPlatforms : ["shopify"];

  const targets: PriceLabTarget[] = targetPlatforms.map((platform) => {
    const real = detail.listings.find((l) => l.platform === platform) ?? null;
    const listing: LabListing = real ?? {
      platform,
      commissionRate: null,
      commissionFixed: null,
      cargoCost: null,
    };
    const currentPrice = real?.salePrice ?? detail.currentSalePrice;
    const cur = simFor(listing, currentPrice);
    return {
      platform,
      currentPrice,
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
        const r = simFor(shopify, shopify.salePrice, d);
        return { discount: d, effectivePrice: eff, profit: r.netProfit, margin: r.profitMargin };
      }),
    };
  }

  return { hasCost: true, targets, campaign };
}
