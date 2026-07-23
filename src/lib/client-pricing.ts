import { simulatePrice, trendyolMinQty } from "../core/pricing-engine";
import {
  withProductCommissionRule,
  resolveListingCommissionOverride,
} from "../core/product-commission";
import { filterCargoRulesByPlatform, filterRulesByPlatform } from "../core/cargo-calculator";
import { packagingScopeInput, resolveProductCost } from "../core/product-cost";
import {
  collectRulePriceBreakpoints,
  findMinimumPriceForMargin,
} from "../core/price-target";
import type {
  SimulationResult,
  CommissionRuleInput,
  CargoRuleInput,
  ExpenseRuleInput,
} from "../core/types";

/**
 * İSTEMCİ-TARAFI kâr hesabı (ürün detay sayfası canlı önizleme + Fiyat Lab).
 *
 * NEDEN: Next.js sunucusu Electron ANA sürecinde çalışır; maliyet her değişimde sunucuya gitmek
 * pencereyi donduruyordu. Aynı saf `@/core` fonksiyonlarıyla hesabı BURADA (tarayıcıda) yaparız.
 *
 * PERF: Önizleme UCUZ (platform başına 1 simülasyon) → her değişimde çalışır. Fiyat Lab PAHALI
 * (hedef-marj ikili araması) → ayrı `computePriceLab` ile ertelenebilir. Kurallar platform başına
 * BİR KEZ süzülür (eskiden her simülasyonda yeniden süzülüyordu → 45 kurallı veride ~68ms).
 */

const MARGINS = [20, 30, 40, 50];
const DISCOUNTS = [10, 15, 20, 25, 30];
// İkili arama adım sayısı. 24 adım → [0.5, 100000] aralığında ~0.006₺ hassasiyet (fazlasıyla yeter).

export interface PricingListing {
  id: string;
  platform: string;
  salePrice: number;
  commissionRate: number | null;
  commissionFixed: number | null;
  cargoCost: number | null;
  isActive: boolean;
}

export interface PricingProduct {
  id: string;
  name: string;
  categoryName: string;
  desi: number | null;
  currentSalePrice: number;
  commissionRate?: number | null;
  listings: PricingListing[];
}

/** Maliyet formundan gelen (kaydedilmemiş olabilir) canlı değerler. */
export interface PricingCost {
  filamentTypeId: string;
  filamentWeight: number;
  printTimeHours: number;
  wasteRate: number;
  packagingOptionId: string;
  nylonLevel: string;
  tapeUsed: boolean;
  desi: number | null;
}

export interface ProfitPreview {
  productionCost: number;
  packagingCost: number;
  totalCost: number;
  hasCost: boolean;
  platforms: Array<{
    platform: string;
    listingId: string;
    salePrice: number;
    result: SimulationResult | null;
  }>;
}

interface TargetRow {
  margin: number;
  price: number | null;
}
interface PlatformTarget {
  platform: string;
  currentPrice: number;
  currentMargin: number;
  rows: TargetRow[];
}
interface CampaignRow {
  discount: number;
  effectivePrice: number;
  profit: number;
  margin: number;
}
export interface PriceLab {
  hasCost: boolean;
  productCost?: number;
  packagingCost?: number;
  targets?: PlatformTarget[];
  campaign?: { currentPrice: number; rows: CampaignRow[] } | null;
}

export interface ClientPricingInput {
  product: PricingProduct;
  cost: PricingCost;
  filaments: Array<{ id: string; costPerGram: number }>;
  settings: Record<string, string | undefined>;
  commissionRules: CommissionRuleInput[];
  cargoRules: CargoRuleInput[];
  expenseRules: ExpenseRuleInput[];
}

/** Hem önizleme hem Fiyat Lab'ın paylaştığı çözülmüş taban — kurallar platform başına TEK kez süzülür. */
interface PricingBase {
  product: PricingProduct;
  settings: Record<string, string | undefined>;
  vatRate: number;
  productCost: number;
  packagingCost: number;
  packagingScope: ReturnType<typeof packagingScopeInput>;
  totalCost: number;
  hasCost: boolean;
  filamentMatCost: number;
  activeListings: PricingListing[];
  productRules: CommissionRuleInput[];
  desi: number;
  /** Platform → o platforma süzülmüş kargo/gider kuralları (yeniden-süzme yok). */
  cargoByPlatform: Record<string, CargoRuleInput[]>;
  expenseByPlatform: Record<string, ExpenseRuleInput[]>;
}

function buildBase(input: ClientPricingInput): PricingBase {
  const { product, cost, filaments, settings } = input;
  const vatRate = Number(settings.vatRate ?? 0);

  // Sunucu route'ları kuralları isActive:true ile çeker; liste endpoint'i hepsini döner → birebir
  // parite için BURADA süz (bir kez).
  const commissionRules = (input.commissionRules ?? []).filter((r) => r.isActive);
  const cargoRules = (input.cargoRules ?? []).filter((r) => r.isActive);
  const expenseRules = (input.expenseRules ?? []).filter((r) => r.isActive);

  const filamentCostPerGram =
    filaments.find((f) => f.id === cost.filamentTypeId)?.costPerGram ?? 0;
  const resolved = resolveProductCost(
    {
      costMode: "detailed",
      manualCost: null,
      totalCost: null,
      filamentWeight: cost.filamentWeight,
      printTimeHours: cost.printTimeHours,
      wasteRate: cost.wasteRate,
      packagingOptionId: cost.packagingOptionId || null,
      nylonLevel: cost.nylonLevel || null,
      tapeUsed: cost.tapeUsed,
    },
    settings,
    filamentCostPerGram
  );
  const productCost = resolved?.productionCost ?? 0;
  const packagingCost = resolved?.packagingCost ?? 0;
  const totalCost = resolved?.totalCost ?? 0;
  const filamentMatCost = resolved?.filamentCost ?? 0;

  const activeListings = product.listings.filter((l) => l.isActive);
  const productRules = withProductCommissionRule(product, commissionRules);
  const desi = cost.desi ?? product.desi ?? 1;

  // Platform başına BİR KEZ süz (önizleme + tüm ikili-arama adımları bunu paylaşır).
  const cargoByPlatform: Record<string, CargoRuleInput[]> = {};
  const expenseByPlatform: Record<string, ExpenseRuleInput[]> = {};
  const platforms = new Set<string>(["shopify", ...activeListings.map((l) => l.platform)]);
  for (const pf of platforms) {
    cargoByPlatform[pf] = filterCargoRulesByPlatform(cargoRules, pf);
    expenseByPlatform[pf] = filterRulesByPlatform(expenseRules, pf);
  }

  return {
    product,
    settings,
    vatRate,
    productCost,
    packagingCost,
    packagingScope: packagingScopeInput(resolved),
    totalCost,
    hasCost: totalCost > 0,
    filamentMatCost,
    activeListings,
    productRules,
    desi,
    cargoByPlatform,
    expenseByPlatform,
  };
}

function previewFromBase(b: PricingBase): ProfitPreview {
  const platforms = b.activeListings.map((listing) => {
    if (!b.hasCost) {
      return { platform: listing.platform, listingId: listing.id, salePrice: listing.salePrice, result: null };
    }
    const result = simulatePrice({
      salePrice: listing.salePrice,
      productCost: b.productCost,
      packagingCost: b.packagingCost,
      ...b.packagingScope,
      categoryName: b.product.categoryName,
      desi: b.desi,
      commissionRules: b.productRules,
      cargoRules: b.cargoByPlatform[listing.platform] ?? [],
      expenseRules: b.expenseByPlatform[listing.platform] ?? [],
      vatRate: b.vatRate,
      ...resolveListingCommissionOverride(listing, b.settings),
      // Shopify sepet min 150₺ → <150₺ üründe kargo paylaşılır → katma (0).
      cargoCostOverride:
        listing.cargoCost ??
        (listing.platform === "shopify" && listing.salePrice < 150 ? 0 : undefined),
      minOrderQty: listing.platform === "trendyol" ? trendyolMinQty(listing.salePrice) : 1,
      vatableProductCost: b.filamentMatCost,
    });
    return { platform: listing.platform, listingId: listing.id, salePrice: listing.salePrice, result };
  });
  return {
    productionCost: b.productCost,
    packagingCost: b.packagingCost,
    totalCost: b.totalCost,
    hasCost: b.hasCost,
    platforms,
  };
}

function priceLabFromBase(b: PricingBase): PriceLab {
  if (!b.hasCost) return { hasCost: false };

  const simFor = (
    platform: string,
    listing: PricingListing | null,
    salePrice: number,
    discountBuffer = 0
  ) =>
    simulatePrice({
      salePrice,
      productCost: b.productCost,
      packagingCost: b.packagingCost,
      ...b.packagingScope,
      categoryName: b.product.categoryName,
      desi: b.desi,
      commissionRules: b.productRules,
      cargoRules: b.cargoByPlatform[platform] ?? [],
      expenseRules: b.expenseByPlatform[platform] ?? [],
      vatRate: b.vatRate,
      discountBuffer,
      ...resolveListingCommissionOverride(
        listing
          ? { platform, commissionRate: listing.commissionRate, commissionFixed: listing.commissionFixed }
          : { platform, commissionRate: null, commissionFixed: null },
        b.settings
      ),
      // Canlı önizlemeyle aynı platform semantiği: Shopify'da 150 TL altı
      // ürünün kargosu sepete paylaşılır; Trendyol baremi fiyat adayına göre değişir.
      cargoCostOverride:
        listing?.cargoCost ??
        (platform === "shopify" &&
        salePrice * (1 - discountBuffer / 100) < 150
          ? 0
          : undefined),
      minOrderQty: platform === "trendyol" ? trendyolMinQty(salePrice) : 1,
      vatableProductCost: b.filamentMatCost,
    });

  // Hedef marj → fiyat. Kargo/min-adet eşiklerinde marj aşağı sıçrayabilir; aralık bazlı ara.
  const priceForMargin = (
    platform: string,
    listing: PricingListing | null,
    targetMargin: number
  ): number | null => {
    const breakpoints = collectRulePriceBreakpoints(
      b.productRules,
      b.cargoByPlatform[platform] ?? [],
      b.expenseByPlatform[platform] ?? []
    );
    if (platform === "trendyol") breakpoints.push(25, 35, 50, 75);
    if (platform === "shopify") breakpoints.push(150);
    return findMinimumPriceForMargin({
      marginAt: (price) => simFor(platform, listing, price).profitMargin,
      targetMargin,
      breakpoints,
    });
  };

  const platformNames = b.activeListings.map((l) => l.platform);
  const targetPlatforms = platformNames.length > 0 ? platformNames : ["shopify"];
  const targets = targetPlatforms.map((platform) => {
    const listing = b.activeListings.find((l) => l.platform === platform) ?? null;
    const currentPrice = listing?.salePrice ?? b.product.currentSalePrice;
    return {
      platform,
      currentPrice,
      currentMargin: simFor(platform, listing, currentPrice).profitMargin,
      rows: MARGINS.map((m) => ({ margin: m, price: priceForMargin(platform, listing, m / 100) })),
    };
  });

  const shopifyListing = b.activeListings.find((l) => l.platform === "shopify") ?? null;
  const shopifyPrice =
    shopifyListing?.salePrice ??
    (platformNames.includes("shopify") ? b.product.currentSalePrice : null);
  const campaign =
    shopifyPrice != null
      ? {
          currentPrice: shopifyPrice,
          rows: DISCOUNTS.map((d) => {
            const sim = simFor("shopify", shopifyListing, shopifyPrice, d);
            return {
              discount: d,
              effectivePrice: shopifyPrice * (1 - d / 100),
              profit: sim.netProfit,
              margin: sim.profitMargin,
            };
          }),
        }
      : null;

  return { hasCost: true, productCost: b.productCost, packagingCost: b.packagingCost, targets, campaign };
}

/** Yalnız önizleme (UCUZ — her maliyet değişiminde çalıştırılabilir). */
export function computeProfitPreview(input: ClientPricingInput): ProfitPreview {
  return previewFromBase(buildBase(input));
}

/** Yalnız Fiyat Lab (PAHALI — ertelenebilir / debounce'lanabilir). */
export function computePriceLab(input: ClientPricingInput): PriceLab {
  return priceLabFromBase(buildBase(input));
}

/** İkisi birden (taban tek kez çözülür). */
export function computeClientPricing(input: ClientPricingInput): {
  preview: ProfitPreview;
  priceLab: PriceLab;
} {
  const base = buildBase(input);
  return { preview: previewFromBase(base), priceLab: priceLabFromBase(base) };
}
