import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { simulatePrice, trendyolMinQty } from "@/core/pricing-engine";
import { withProductCommissionRule, resolveListingCommissionOverride } from "@/core/product-commission";
import { filterCargoRulesByPlatform, filterRulesByPlatform } from "@/core/cargo-calculator";
import { resolveProductCost } from "@/core/product-cost";
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
  const vatRate = Number(settingsMap.vatRate ?? 0);

  const resolved = resolveProductCost(product.cost, settingsMap, product.cost?.filamentType?.costPerGram ?? 0);
  if (!resolved || resolved.totalCost <= 0) {
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
      cargoCostOverride: listing?.cargoCost ?? undefined,
      // Trendyol min sipariş adedi — karar: Fiyat Lab da uygular (mobil price-lab.ts ile birebir;
      // Ürünler sayfası zaten uyguluyordu → üç yüzey aynı).
      minOrderQty: platform === "trendyol" ? trendyolMinQty(salePrice) : 1,
      vatableProductCost: filamentMatCost,
    });
  }

  // Hedef marj → fiyat (platform başına; ikili arama, marj fiyatla artar)
  function priceForMargin(platform: string, listing: Parameters<typeof simFor>[1], targetMargin: number): number | null {
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
            return {
              discount: d,
              effectivePrice: shopifyPrice * (1 - d / 100),
              profit: sim.netProfit,
              margin: sim.profitMargin,
            };
          }),
        }
      : null;

  return NextResponse.json({ hasCost: true, productCost, packagingCost, targets, campaign });
}
