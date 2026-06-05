import { simulatePrice, trendyolMinQty } from "../core/pricing-engine";
import {
  withProductCommissionRule,
  resolveListingCommissionOverride,
} from "../core/product-commission";
import { filterCargoRulesByPlatform, filterRulesByPlatform } from "../core/cargo-calculator";
import { resolveProductCost } from "../core/product-cost";
import type {
  SimulationResult,
  CommissionRuleInput,
  CargoRuleInput,
  ExpenseRuleInput,
} from "../core/types";

/**
 * İSTEMCİ-TARAFI kâr hesabı (ürün detay sayfası canlı önizleme + Fiyat Lab).
 *
 * NEDEN: Bu uygulamada Next.js sunucusu Electron ANA sürecinde çalışır (pencereyi süren
 * süreçle AYNI). Maliyet inputu her değişince `/api/.../profit-preview` ve (kaydetten sonra)
 * `/api/.../price-lab` çağrılıyordu; her biri ana süreçte 6+ libSQL sorgusu + (price-lab)
 * ~530 simülasyon yapıyordu → ana sürecin olay döngüsü kilitlenip pencere donuyordu
 * ("maliyette değer değiştirince 1-2 sn donma").
 *
 * ÇÖZÜM: Aynı saf `@/core` fonksiyonlarıyla hesabı BURADA (tarayıcıda) yap. Kurallar bir kez
 * çekilip cache'lenir; maliyet değişince ana sürece HİÇBİR otomatik okuma gitmez (yalnız
 * gerçek kayıt PATCH'i kalır). simulatePrice mikro-saniyelik olduğundan tarayıcı da donmaz.
 *
 * Sunucu route'larıyla (profit-preview + price-lab) BİREBİR aynı mantık → sonuç farkı YOK.
 */

const MARGINS = [20, 30, 40, 50];
const DISCOUNTS = [10, 15, 20, 25, 30];

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

export function computeClientPricing(input: ClientPricingInput): {
  preview: ProfitPreview;
  priceLab: PriceLab;
} {
  const { product, cost, filaments, settings } = input;
  const vatRate = Number(settings.vatRate ?? 0);

  // Sunucu route'ları kuralları `where: { isActive: true }` ile çeker; liste endpoint'i
  // ise HEPSİNİ döner → birebir parite için BURADA süz.
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
  const filamentMatCost = resolved?.filamentCost ?? 0; // KDV iadesine giren malzeme payı
  const hasCost = totalCost > 0;

  const activeListings = product.listings.filter((l) => l.isActive);
  const productRules = withProductCommissionRule(product, commissionRules);
  const desi = cost.desi ?? product.desi ?? 1;

  // ── Canlı önizleme (profit-preview route ile birebir) ──
  const platforms = activeListings.map((listing) => {
    if (!hasCost) {
      return {
        platform: listing.platform,
        listingId: listing.id,
        salePrice: listing.salePrice,
        result: null,
      };
    }
    const result = simulatePrice({
      salePrice: listing.salePrice,
      productCost,
      packagingCost,
      categoryName: product.categoryName,
      desi,
      commissionRules: productRules,
      cargoRules: filterCargoRulesByPlatform(cargoRules, listing.platform),
      expenseRules: filterRulesByPlatform(expenseRules, listing.platform),
      vatRate,
      ...resolveListingCommissionOverride(listing, settings),
      // Shopify sepet min 150₺ → <150₺ üründe kargo paylaşılır → katma (0).
      cargoCostOverride:
        listing.cargoCost ??
        (listing.platform === "shopify" && listing.salePrice < 150 ? 0 : undefined),
      minOrderQty: listing.platform === "trendyol" ? trendyolMinQty(listing.salePrice) : 1,
      vatableProductCost: filamentMatCost,
    });
    return {
      platform: listing.platform,
      listingId: listing.id,
      salePrice: listing.salePrice,
      result,
    };
  });
  const preview: ProfitPreview = {
    productionCost: productCost,
    packagingCost,
    totalCost,
    hasCost,
    platforms,
  };

  // ── Fiyat Lab (price-lab route ile birebir) ──
  let priceLab: PriceLab;
  if (!hasCost) {
    priceLab = { hasCost: false };
  } else {
    const simFor = (
      platform: string,
      listing: PricingListing | null,
      salePrice: number,
      discountBuffer = 0
    ) =>
      simulatePrice({
        salePrice,
        productCost,
        packagingCost,
        categoryName: product.categoryName,
        desi,
        commissionRules: productRules,
        cargoRules: filterCargoRulesByPlatform(cargoRules, platform),
        expenseRules: filterRulesByPlatform(expenseRules, platform),
        vatRate,
        discountBuffer,
        ...resolveListingCommissionOverride(
          listing
            ? {
                platform,
                commissionRate: listing.commissionRate,
                commissionFixed: listing.commissionFixed,
              }
            : { platform, commissionRate: null, commissionFixed: null },
          settings
        ),
        cargoCostOverride: listing?.cargoCost ?? undefined,
        vatableProductCost: filamentMatCost,
      });

    // Hedef marj → fiyat (ikili arama; marj fiyatla artar)
    const priceForMargin = (
      platform: string,
      listing: PricingListing | null,
      targetMargin: number
    ): number | null => {
      const margAt = (p: number) => simFor(platform, listing, p).profitMargin;
      let hi = 100000;
      if (margAt(hi) < targetMargin) return null; // hiçbir fiyatta ulaşılamıyor
      let lo = 0.5;
      for (let i = 0; i < 44; i++) {
        const mid = (lo + hi) / 2;
        if (margAt(mid) >= targetMargin) hi = mid;
        else lo = mid;
      }
      return hi;
    };

    const platformNames = activeListings.map((l) => l.platform);
    const targetPlatforms = platformNames.length > 0 ? platformNames : ["shopify"];
    const targets = targetPlatforms.map((platform) => {
      const listing = activeListings.find((l) => l.platform === platform) ?? null;
      const currentPrice = listing?.salePrice ?? product.currentSalePrice;
      return {
        platform,
        currentPrice,
        currentMargin: simFor(platform, listing, currentPrice).profitMargin,
        rows: MARGINS.map((m) => ({ margin: m, price: priceForMargin(platform, listing, m / 100) })),
      };
    });

    const shopifyListing = activeListings.find((l) => l.platform === "shopify") ?? null;
    const shopifyPrice =
      shopifyListing?.salePrice ??
      (platformNames.includes("shopify") ? product.currentSalePrice : null);
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

    priceLab = { hasCost: true, productCost, packagingCost, targets, campaign };
  }

  return { preview, priceLab };
}
