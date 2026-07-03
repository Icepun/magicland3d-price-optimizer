import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { simulatePrice, trendyolMinQty } from "@/core/pricing-engine";
import { withProductCommissionRule, resolveListingCommissionOverride } from "@/core/product-commission";
import { filterCargoRulesByPlatform, filterRulesByPlatform } from "@/core/cargo-calculator";
import { resolveProductCost } from "@/core/product-cost";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

type Platform = "shopify" | "trendyol" | "hepsiburada";

interface PlatformStats {
  platform: Platform;
  activeListings: number;
  totalProfit: number;
  averageMargin: number;
  negativeProfitCount: number;
  thinMarginCount: number;
}

export async function GET() {
  await ensureRuntimeSchema();

  const [products, commissionRules, cargoRules, expenseRules, settings] =
    await Promise.all([
      prisma.product.findMany({
        where: { isActive: true, hidden: false },
        include: {
          cost: { include: { filamentType: { select: { costPerGram: true } } } },
          listings: { where: { isActive: true } },
        },
      }),
      prisma.commissionRule.findMany({ where: { isActive: true } }),
      prisma.cargoRule.findMany({ where: { isActive: true } }),
      prisma.expenseRule.findMany({ where: { isActive: true } }),
      prisma.appSetting.findMany(),
    ]);

  const settingsMap = Object.fromEntries(
    settings.map((s) => [s.key, s.value])
  );
  const vatRate = Number(settingsMap.vatRate ?? 0);

  const totalProducts = products.length;
  let missingCost = 0;
  let totalNegativeListings = 0;
  let inStockCount = 0;
  let outOfStockCount = 0;
  let lowStockCount = 0;

  const lowStockProducts: Array<{
    id: string;
    name: string;
    stock: number;
    imageUrl: string | null;
  }> = [];

  const platformStats: Record<Platform, PlatformStats> = {
    shopify: { platform: "shopify", activeListings: 0, totalProfit: 0, averageMargin: 0, negativeProfitCount: 0, thinMarginCount: 0 },
    trendyol: { platform: "trendyol", activeListings: 0, totalProfit: 0, averageMargin: 0, negativeProfitCount: 0, thinMarginCount: 0 },
    hepsiburada: { platform: "hepsiburada", activeListings: 0, totalProfit: 0, averageMargin: 0, negativeProfitCount: 0, thinMarginCount: 0 },
  };

  const platformMarginSums: Record<Platform, { sum: number; count: number }> = {
    shopify: { sum: 0, count: 0 },
    trendyol: { sum: 0, count: 0 },
    hepsiburada: { sum: 0, count: 0 },
  };

  const problemProducts: Array<{
    id: string;
    name: string;
    listingId?: string;
    platform?: Platform;
    salePrice: number;
    problem: "missing_cost" | "negative_profit";
    profit: number | null;
    margin: number | null;
  }> = [];

  for (const product of products) {
    // "Sipariş üzerine üretilir" ürünler stok tutmaz → stok sayımına/uyarısına girmez.
    if (!product.madeToOrder) {
      if (product.stock > 0) inStockCount++;
      else outOfStockCount++;

      // Düşük stok (≤1) takibi
      if (product.stock <= 1) {
        lowStockCount++;
        if (lowStockProducts.length < 30) {
          lowStockProducts.push({
            id: product.id,
            name: product.name,
            stock: product.stock,
            imageUrl: product.imageUrl,
          });
        }
      }
    }

    // Maliyeti güncel ayarlardan yeniden hesapla (zam otomatik yansır)
    const resolved = resolveProductCost(
      product.cost,
      settingsMap,
      product.cost?.filamentType?.costPerGram ?? 0
    );
    const productCost = resolved?.productionCost ?? 0;
    const packagingCost = resolved?.packagingCost ?? 0;

    if (!resolved || resolved.totalCost <= 0) {
      missingCost++;
      problemProducts.push({
        id: product.id,
        name: product.name,
        salePrice: product.currentSalePrice,
        problem: "missing_cost",
        profit: null,
        margin: null,
      });
      continue;
    }

    // Her aktif listing için kâr hesabı
    for (const listing of product.listings) {
      const platform = listing.platform as Platform;
      if (!platformStats[platform]) continue;

      platformStats[platform].activeListings++;

      const sim = simulatePrice({
        salePrice: listing.salePrice,
        productCost,
        packagingCost,
        categoryName: product.categoryName,
        desi: product.desi ?? 1,
        commissionRules: withProductCommissionRule(
          product,
          commissionRules as Parameters<typeof simulatePrice>[0]["commissionRules"]
        ),
        cargoRules: filterCargoRulesByPlatform(
          cargoRules as Parameters<typeof simulatePrice>[0]["cargoRules"],
          platform
        ),
        expenseRules: filterRulesByPlatform(
          expenseRules as Parameters<typeof simulatePrice>[0]["expenseRules"],
          platform
        ),
        vatRate,
        ...resolveListingCommissionOverride(listing, settingsMap),
        // ÜRÜNLER sayfası matematiğiyle BİREBİR (karar): Panel eskiden bu iki kuralı uygulamıyordu
        // → aynı listing Panel'de farklı, Ürünler sayfasında/mobilde farklı kâr gösteriyordu.
        // Shopify sepet min 150₺ → <150₺ ürün tek başına satılamaz, kargo paylaşılır → 0.
        cargoCostOverride:
          listing.cargoCost ??
          (listing.platform === "shopify" && listing.salePrice < 150 ? 0 : undefined),
        // Trendyol min sipariş adedi → kâr N-adetlik sipariş üzerinden.
        minOrderQty: listing.platform === "trendyol" ? trendyolMinQty(listing.salePrice) : 1,
        vatableProductCost: resolved.filamentCost,
      });

      platformStats[platform].totalProfit += sim.netProfit;
      platformMarginSums[platform].sum += sim.profitMargin;
      platformMarginSums[platform].count++;

      if (sim.netProfit < 0) {
        platformStats[platform].negativeProfitCount++;
        totalNegativeListings++;
        problemProducts.push({
          id: product.id,
          name: product.name,
          listingId: listing.id,
          platform,
          salePrice: listing.salePrice,
          problem: "negative_profit",
          profit: sim.netProfit,
          margin: sim.profitMargin,
        });
      }
    }
  }

  // Ortalama marjları hesapla — HB dahil (eskiden atlanıyordu → masaüstü HB marjı hep 0,
  // mobil hesaplıyordu; iki cihaz farklı değer gösteriyordu).
  for (const platform of ["shopify", "trendyol", "hepsiburada"] as Platform[]) {
    const m = platformMarginSums[platform];
    platformStats[platform].averageMargin = m.count > 0 ? m.sum / m.count : 0;
  }

  const grandTotalProfit =
    platformStats.shopify.totalProfit + platformStats.trendyol.totalProfit + platformStats.hepsiburada.totalProfit;

  // Stok 0 olanlar önce, sonra 1 olanlar
  lowStockProducts.sort((a, b) => a.stock - b.stock);

  return NextResponse.json({
    totalProducts,
    inStockCount,
    outOfStockCount,
    lowStockCount,
    lowStockProducts,
    missingCost,
    negativeListings: totalNegativeListings,
    grandTotalProfit,
    platforms: Object.values(platformStats),
    problemProducts: problemProducts.slice(0, 30),
  });
}
