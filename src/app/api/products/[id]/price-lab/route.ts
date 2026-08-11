import { NextRequest, NextResponse } from "next/server";
import { vatRateOf } from "@/core/vat";
import { prisma } from "@/lib/prisma";
import { simulatePrice } from "@/core/pricing-engine";
import {
  belowShopifyMinBasket,
  platformMinOrderQty,
  platformPriceBreakpoints,
  shopifyCargoOverride,
} from "@/core/platform-rules";
import { withProductCommissionRule, resolveListingCommissionOverride } from "@/core/product-commission";
import { filterCargoRulesByPlatform, filterRulesByPlatform } from "@/core/cargo-calculator";
import { packagingScopeInput, resolveProductCost } from "@/core/product-cost";
import {
  collectRulePriceBreakpoints,
  findMinimumPriceForMargin,
} from "@/core/price-target";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

/**
 * Fiyat Laboratuvarı — ürün bazlı hızlı simülasyon:
 *  - Hedef marj → KDV dahil önerilen fiyat (her platform için, mevcut listing kurallarıyla)
 *  - Shopify kampanya: mevcut fiyata %indirim → kalan net kâr / marj
 */
const MARGINS = [20, 30, 40, 50];
const DISCOUNTS = [10, 15, 20, 25, 30];

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ensureRuntimeSchema();
  const { id } = await params;

  const product = await prisma.product.findUnique({
    where: { id },
    include: { cost: { include: { filamentType: true } }, listings: { where: { isActive: true } } },
  });
  if (!product) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [commissionRules, cargoRules, expenseRules, settings] = await Promise.all([
    prisma.commissionRule.findMany({ where: { isActive: true } }),
    prisma.cargoRule.findMany({ where: { isActive: true } }),
    prisma.expenseRule.findMany({ where: { isActive: true } }),
    prisma.appSetting.findMany(),
  ]);
  const settingsMap = Object.fromEntries(settings.map((s) => [s.key, s.value]));
  const vatRate = vatRateOf(settingsMap);

  const resolved = resolveProductCost(product.cost, settingsMap, product.cost?.filamentType?.costPerGram ?? 0);
  if (!resolved || !resolved.productionCostKnown) {
    return NextResponse.json({ hasCost: false });
  }
  const productCost = resolved.productionCost;
  const packagingCost = resolved.packagingCost;
  const filamentMatCost = resolved.filamentCost; // KDV iadesine giren malzeme payı

  type CR = Parameters<typeof simulatePrice>[0]["commissionRules"];
  type KR = Parameters<typeof simulatePrice>[0]["cargoRules"];
  type ER = Parameters<typeof simulatePrice>[0]["expenseRules"];
  const productRules = withProductCommissionRule(product, commissionRules as CR);

  function simFor(
    platform: string,
    listing: { commissionRate: number | null; commissionFixed: number | null; cargoCost: number | null } | null,
    salePrice: number,
    discountBuffer = 0
  ) {
    return simulatePrice({
      salePrice,
      productCost,
      packagingCost,
      ...packagingScopeInput(resolved),
      categoryName: product!.categoryName,
      desi: product!.desi ?? 1,
      commissionRules: productRules,
      cargoRules: filterCargoRulesByPlatform(cargoRules as KR, platform),
      expenseRules: filterRulesByPlatform(expenseRules as ER, platform),
      vatRate,
      discountBuffer,
      ...(listing
        ? resolveListingCommissionOverride({ platform, commissionRate: listing.commissionRate, commissionFixed: listing.commissionFixed }, settingsMap)
        : resolveListingCommissionOverride({ platform, commissionRate: null, commissionFixed: null }, settingsMap)),
      // Platform kuralları TEK kaynaktan (core/platform-rules). Eşiğe müşterinin GERÇEKTEN
      // ödediği tutar girer → kampanyada indirim UYGULANDIKTAN sonraki fiyat. Sepet minimumu
      // ürünün etiketine değil, müşterinin ödediğine bakar.
      cargoCostOverride:
        listing?.cargoCost ??
        shopifyCargoOverride(platform, salePrice * (1 - discountBuffer / 100)),
      minOrderQty: platformMinOrderQty(platform, salePrice),
      vatableProductCost: filamentMatCost,
    });
  }

  // Hedef marj → fiyat; kargo/min-adet sıçramalarında her sabit aralığı ayrı ara.
  function priceForMargin(platform: string, listing: Parameters<typeof simFor>[1], targetMargin: number): number | null {
    const platformCargo = filterCargoRulesByPlatform(cargoRules as KR, platform);
    const platformExpense = filterRulesByPlatform(expenseRules as ER, platform);
    const breakpoints = collectRulePriceBreakpoints(
      productRules,
      platformCargo,
      platformExpense
    );
    breakpoints.push(...platformPriceBreakpoints(platform));
    return findMinimumPriceForMargin({
      marginAt: (price) => simFor(platform, listing, price).profitMargin,
      targetMargin,
      breakpoints,
    });
  }

  const platforms = product.listings.map((l) => l.platform);
  const targetPlatforms = platforms.length > 0 ? platforms : ["shopify"];

  const targets = targetPlatforms.map((platform) => {
    const listing = product.listings.find((l) => l.platform === platform) ?? null;
    const currentPrice = listing?.salePrice ?? product.currentSalePrice;
    return {
      platform,
      currentPrice,
      currentMargin: simFor(platform, listing, currentPrice).profitMargin,
      rows: MARGINS.map((m) => ({ margin: m, price: priceForMargin(platform, listing, m / 100) })),
    };
  });

  // Shopify kampanya simülatörü
  const shopifyListing = product.listings.find((l) => l.platform === "shopify") ?? null;
  const shopifyPrice = shopifyListing?.salePrice ?? (platforms.includes("shopify") ? product.currentSalePrice : null);
  const campaign =
    shopifyPrice != null
      ? {
          currentPrice: shopifyPrice,
          rows: DISCOUNTS.map((d) => {
            const sim = simFor("shopify", shopifyListing, shopifyPrice, d);
            const effectivePrice = shopifyPrice * (1 - d / 100);
            return {
              discount: d,
              effectivePrice,
              profit: sim.netProfit,
              margin: sim.profitMargin,
              /**
               * Bu indirimde sepet minimumunun altına düşülüyor → kargo satıcıda kalmıyor.
               * Kâr bu satırda ARTABİLİR; sayı doğru ama açıklamasız bakınca ters görünür,
               * o yüzden arayüz bunu tek satırla söyler.
               */
              crossesFreeShipping:
                shopifyListing?.cargoCost == null &&
                belowShopifyMinBasket("shopify", effectivePrice) &&
                !belowShopifyMinBasket("shopify", shopifyPrice),
            };
          }),
        }
      : null;

  return NextResponse.json({ hasCost: true, productCost, packagingCost, targets, campaign });
}
