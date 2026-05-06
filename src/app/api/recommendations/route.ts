import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { simulatePrice } from "@/core/pricing-engine";
import { generateRecommendations } from "@/core/recommendation-engine";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

export async function GET() {
  await ensureRuntimeSchema();

  const recommendations = await prisma.recommendation.findMany({
    include: { product: { include: { cost: true } } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
  return NextResponse.json(recommendations);
}

export async function POST(req: NextRequest) {
  await ensureRuntimeSchema();

  const body = await req.json();
  const { productIds } = body as { productIds?: string[] };

  const [products, commissionRules, cargoRules, expenseRules, settings] =
    await Promise.all([
      prisma.product.findMany({
        where: productIds ? { id: { in: productIds } } : { isActive: true },
        include: { cost: true },
      }),
      prisma.commissionRule.findMany({ where: { isActive: true } }),
      prisma.cargoRule.findMany({ where: { isActive: true } }),
      prisma.expenseRule.findMany({ where: { isActive: true } }),
      prisma.appSetting.findMany(),
    ]);

  const settingsMap = Object.fromEntries(settings.map((s: { key: string; value: string }) => [s.key, s.value]));
  const minNetProfit = Number(settingsMap.defaultMinNetProfit ?? 0);
  const minProfitMargin = Number(settingsMap.defaultMinMargin ?? 0);

  const results = [];

  for (const product of products) {
    const productCost = product.cost?.totalCost ?? product.cost?.manualCost ?? 0;
    const packagingCost = product.cost?.packagingCost ?? 0;

    if (productCost === 0) {
      await prisma.recommendation.upsert({
        where: { id: `${product.id}-latest` },
        create: {
          id: `${product.id}-latest`,
          productId: product.id,
          currentPrice: product.currentSalePrice,
          recommendedPrice: product.currentSalePrice,
          currentProfit: 0,
          recommendedProfit: 0,
          profitDifference: 0,
          currentMargin: 0,
          recommendedMargin: 0,
          reason: "Ürün maliyeti girilmemiş",
          status: "needs_cost",
        },
        update: {
          currentPrice: product.currentSalePrice,
          status: "needs_cost",
          reason: "Ürün maliyeti girilmemiş",
        },
      });
      continue;
    }

    const baseInput = {
      productCost,
      packagingCost,
      categoryName: product.categoryName,
      desi: product.desi ?? 1,
      commissionRules: commissionRules as Parameters<typeof simulatePrice>[0]["commissionRules"],
      cargoRules: cargoRules as Parameters<typeof simulatePrice>[0]["cargoRules"],
      expenseRules: expenseRules as Parameters<typeof simulatePrice>[0]["expenseRules"],
      minNetProfit,
      minProfitMargin,
    };

    const currentResult = simulatePrice({
      ...baseInput,
      salePrice: product.currentSalePrice,
    });

    const recs = generateRecommendations(baseInput, product.currentSalePrice);
    const safeRec = recs.safe ?? recs.bestNetProfit;

    const status =
      !safeRec
        ? "no_better_price"
        : safeRec.salePrice === product.currentSalePrice
          ? "no_better_price"
          : "ready";

    const recommendedPrice = safeRec?.salePrice ?? product.currentSalePrice;
    const recommendedResult = safeRec?.result ?? currentResult;

    await prisma.recommendation.deleteMany({ where: { productId: product.id } });
    const rec = await prisma.recommendation.create({
      data: {
        productId: product.id,
        currentPrice: product.currentSalePrice,
        recommendedPrice,
        currentProfit: currentResult.netProfit,
        recommendedProfit: recommendedResult.netProfit,
        profitDifference: recommendedResult.netProfit - currentResult.netProfit,
        currentMargin: currentResult.profitMargin,
        recommendedMargin: recommendedResult.profitMargin,
        reason: safeRec?.reason ?? "Daha iyi fiyat bulunamadı",
        status,
      },
    });

    results.push(rec);
  }

  return NextResponse.json({ count: results.length, recommendations: results });
}
