import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { simulatePrice } from "@/core/pricing-engine";
import { withProductCommissionRule, resolveListingCommissionOverride } from "@/core/product-commission";
import { filterCargoRulesByPlatform, filterRulesByPlatform } from "@/core/cargo-calculator";
import { resolveProductCost } from "@/core/product-cost";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

/**
 * Bir listing'in net kâr durumu — ana ürünün maliyeti + listing'in
 * platform-spesifik fiyat/komisyon/kargo override'larıyla hesaplanır.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureRuntimeSchema();
  const { id } = await params;

  const listing = await prisma.listing.findUnique({
    where: { id },
    include: { product: { include: { cost: { include: { filamentType: true } } } } },
  });

  if (!listing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const product = listing.product;

  const [commissionRules, cargoRules, expenseRules, settings] =
    await Promise.all([
      prisma.commissionRule.findMany({ where: { isActive: true } }),
      prisma.cargoRule.findMany({ where: { isActive: true } }),
      prisma.expenseRule.findMany({ where: { isActive: true } }),
      prisma.appSetting.findMany(),
    ]);

  const settingsMap = Object.fromEntries(
    settings.map((s) => [s.key, s.value])
  );
  const vatRate = Number(settingsMap.vatRate ?? 0);

  // Maliyeti güncel ayarlardan yeniden hesapla (zam otomatik yansır)
  const resolved = resolveProductCost(
    product.cost,
    settingsMap,
    product.cost?.filamentType?.costPerGram ?? 0
  );

  if (!resolved || resolved.totalCost <= 0) {
    return NextResponse.json({ listing, result: null, missingCost: true });
  }

  const productCost = resolved.productionCost;
  const packagingCost = resolved.packagingCost;

  const result = simulatePrice({
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
      listing.platform
    ),
    expenseRules: filterRulesByPlatform(
      expenseRules as Parameters<typeof simulatePrice>[0]["expenseRules"],
      listing.platform
    ),
    vatRate,
    ...resolveListingCommissionOverride(listing, settingsMap),
    cargoCostOverride: listing.cargoCost ?? undefined,
  });

  return NextResponse.json({ listing, result, missingCost: false });
}
