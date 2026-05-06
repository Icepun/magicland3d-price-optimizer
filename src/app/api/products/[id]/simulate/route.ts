import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { simulateRange } from "@/core/pricing-engine";
import { generateRecommendations } from "@/core/recommendation-engine";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { z } from "zod";

const SimulateSchema = z.object({
  minPrice: z.number().optional(),
  maxPrice: z.number().optional(),
  minNetProfit: z.number().optional(),
  minProfitMargin: z.number().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureRuntimeSchema();

  const { id } = await params;
  const body = await req.json();
  const options = SimulateSchema.parse(body);

  const product = await prisma.product.findUnique({
    where: { id },
    include: { cost: true },
  });

  if (!product) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [commissionRules, cargoRules, expenseRules, settings] = await Promise.all([
    prisma.commissionRule.findMany({ where: { isActive: true } }),
    prisma.cargoRule.findMany({ where: { isActive: true } }),
    prisma.expenseRule.findMany({ where: { isActive: true } }),
    prisma.appSetting.findMany(),
  ]);

  const settingsMap = Object.fromEntries(settings.map((s: { key: string; value: string }) => [s.key, s.value]));
  const minNetProfit = options.minNetProfit ?? Number(settingsMap.defaultMinNetProfit ?? 0);
  const minProfitMargin = options.minProfitMargin ?? Number(settingsMap.defaultMinMargin ?? 0);

  const isDetailed = product.cost?.costMode === "detailed";
  const packagingCost = product.cost?.packagingCost ?? 0;
  const productCost = isDetailed
    ? (product.cost?.totalCost ?? 0) - packagingCost
    : (product.cost?.manualCost ?? 0);

  const baseInput = {
    productCost,
    packagingCost,
    categoryName: product.categoryName,
    desi: product.desi ?? 1,
    commissionRules: commissionRules as Parameters<typeof simulateRange>[0]["commissionRules"],
    cargoRules: cargoRules as Parameters<typeof simulateRange>[0]["cargoRules"],
    expenseRules: expenseRules as Parameters<typeof simulateRange>[0]["expenseRules"],
    minNetProfit,
    minProfitMargin,
  };

  const recommendations = generateRecommendations(
    baseInput,
    product.currentSalePrice,
    options.minPrice !== undefined
      ? { min: options.minPrice, max: options.maxPrice ?? product.currentSalePrice * 2 }
      : undefined
  );

  return NextResponse.json({
    product: {
      id: product.id,
      name: product.name,
      currentSalePrice: product.currentSalePrice,
      productCost,
      packagingCost,
    },
    recommendations,
  });
}
