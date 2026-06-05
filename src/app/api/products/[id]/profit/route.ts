import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { simulatePrice } from "@/core/pricing-engine";
import { withProductCommissionRule } from "@/core/product-commission";
import { resolveProductCost } from "@/core/product-cost";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

/**
 * Tek bir ürünün mevcut fiyatla net kâr durumunu hesaplar.
 * KDV + komisyon + kargo + giderler + indirim payı dahil — gerçek kâr/zarar.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureRuntimeSchema();

  const { id } = await params;
  const product = await prisma.product.findUnique({
    where: { id },
    include: { cost: { include: { filamentType: true } } },
  });

  if (!product) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [commissionRules, cargoRules, expenseRules, settings] =
    await Promise.all([
      prisma.commissionRule.findMany({ where: { isActive: true } }),
      prisma.cargoRule.findMany({ where: { isActive: true } }),
      prisma.expenseRule.findMany({ where: { isActive: true } }),
      prisma.appSetting.findMany(),
    ]);

  const settingsMap = Object.fromEntries(
    settings.map((s: { key: string; value: string }) => [s.key, s.value])
  );
  const vatRate = Number(settingsMap.vatRate ?? 0);

  // Maliyeti güncel ayarlardan yeniden hesapla (zam otomatik yansır)
  const resolved = resolveProductCost(
    product.cost,
    settingsMap,
    product.cost?.filamentType?.costPerGram ?? 0
  );

  if (!resolved || resolved.totalCost <= 0) {
    return NextResponse.json({ result: null, missingCost: true });
  }

  const productCost = resolved.productionCost;
  const packagingCost = resolved.packagingCost;

  const result = simulatePrice({
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
    vatRate,
    vatableProductCost: resolved.filamentCost,
  });

  return NextResponse.json({ result, missingCost: false });
}
