import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { simulatePrice } from "@/core/pricing-engine";
import { withProductCommissionRule } from "@/core/product-commission";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

export async function GET() {
  await ensureRuntimeSchema();

  const [products, commissionRules, cargoRules, expenseRules, settings] =
    await Promise.all([
      prisma.product.findMany({
        where: { isActive: true },
        include: {
          cost: true,
          recommendations: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      }),
      prisma.commissionRule.findMany({ where: { isActive: true } }),
      prisma.cargoRule.findMany({ where: { isActive: true } }),
      prisma.expenseRule.findMany({ where: { isActive: true } }),
      prisma.appSetting.findMany(),
    ]);

  const settingsMap = Object.fromEntries(settings.map((s: { key: string; value: string }) => [s.key, s.value]));
  const minNetProfit = Number(settingsMap.defaultMinNetProfit ?? 0);
  const minProfitMargin = Number(settingsMap.defaultMinMargin ?? 0);

  const totalProducts = products.length;
  let missingCost = 0;
  let negativeProfitCount = 0;
  let belowMinimumCount = 0;
  let optimizableCount = 0;
  let inStockCount = 0;
  let outOfStockCount = 0;
  let currentTotalProfit = 0;
  let optimizedTotalProfit = 0;

  const problemProducts = [];
  const opportunityProducts = [];

  for (const product of products) {
    if (product.stock > 0) inStockCount++;
    else outOfStockCount++;

    const productCost = product.cost?.totalCost ?? product.cost?.manualCost ?? null;
    if (productCost === null) {
      missingCost++;
      problemProducts.push({
        id: product.id,
        name: product.name,
        currentSalePrice: product.currentSalePrice,
        problem: "missing_cost",
        profit: null,
        margin: null,
      });
      continue;
    }

    const packagingCost = product.cost?.packagingCost ?? 0;
    const currentResult = simulatePrice({
      salePrice: product.currentSalePrice,
      productCost,
      packagingCost,
      categoryName: product.categoryName,
      desi: product.desi ?? 1,
      commissionRules: withProductCommissionRule(
        product,
        commissionRules as Parameters<typeof simulatePrice>[0]["commissionRules"]
      ),
      cargoRules: cargoRules as Parameters<typeof simulatePrice>[0]["cargoRules"],
      expenseRules: expenseRules as Parameters<typeof simulatePrice>[0]["expenseRules"],
      minNetProfit,
      minProfitMargin,
    });

    currentTotalProfit += currentResult.netProfit;

    const rec = product.recommendations[0];
    if (rec) {
      optimizedTotalProfit += rec.recommendedProfit;
    } else {
      optimizedTotalProfit += currentResult.netProfit;
    }

    if (currentResult.netProfit < 0) {
      negativeProfitCount++;
      problemProducts.push({
        id: product.id,
        name: product.name,
        currentSalePrice: product.currentSalePrice,
        problem: "negative_profit",
        profit: currentResult.netProfit,
        margin: currentResult.profitMargin,
      });
    } else if (
      (minNetProfit > 0 && currentResult.netProfit < minNetProfit) ||
      (minProfitMargin > 0 && currentResult.profitMargin < minProfitMargin)
    ) {
      belowMinimumCount++;
      problemProducts.push({
        id: product.id,
        name: product.name,
        currentSalePrice: product.currentSalePrice,
        problem: "below_minimum",
        profit: currentResult.netProfit,
        margin: currentResult.profitMargin,
      });
    }

    if (rec && rec.status === "ready" && rec.profitDifference > 5) {
      optimizableCount++;
      opportunityProducts.push({
        id: product.id,
        name: product.name,
        currentSalePrice: product.currentSalePrice,
        recommendedPrice: rec.recommendedPrice,
        currentProfit: rec.currentProfit,
        recommendedProfit: rec.recommendedProfit,
        profitDifference: rec.profitDifference,
      });
    }
  }

  return NextResponse.json({
    totalProducts,
    activeProducts: totalProducts,
    inStockCount,
    outOfStockCount,
    missingCost,
    negativeProfitCount,
    belowMinimumCount,
    optimizableCount,
    currentTotalProfit,
    optimizedTotalProfit,
    potentialIncrease: optimizedTotalProfit - currentTotalProfit,
    problemProducts: problemProducts.slice(0, 10),
    opportunityProducts: opportunityProducts
      .sort((a, b) => b.profitDifference - a.profitDifference)
      .slice(0, 10),
  });
}
