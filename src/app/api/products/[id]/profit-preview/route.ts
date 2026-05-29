import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { simulatePrice } from "@/core/pricing-engine";
import { withProductCommissionRule, resolveListingCommissionOverride } from "@/core/product-commission";
import { filterCargoRulesByPlatform, filterRulesByPlatform } from "@/core/cargo-calculator";
import { resolveProductCost } from "@/core/product-cost";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { z } from "zod";

/**
 * KAYDETMEDEN kâr önizlemesi.
 *
 * Ürün detay sayfası, maliyet formundaki KAYDEDİLMEMİŞ değerleri buraya POST eder;
 * sunucu aynı hesaplama koduyla (resolveProductCost + simulatePrice) her platform
 * için anlık kârı döner. DB'ye HİÇBİR ŞEY yazmaz.
 *
 * Böylece kullanıcı maliyet inputlarını değiştirdikçe sağ taraftaki platform
 * kartları real-time güncellenir; kaydetmeden çıkarsa hiçbir şey kalıcı olmaz.
 */
const PreviewSchema = z.object({
  filamentTypeId: z.string().nullable().optional(),
  filamentWeight: z.number().min(0).nullable().optional(),
  printTimeHours: z.number().min(0).nullable().optional(),
  wasteRate: z.number().min(0).max(1).nullable().optional(),
  packagingOptionId: z.string().nullable().optional(),
  nylonLevel: z.enum(["none", "low", "medium", "high"]).nullable().optional(),
  tapeUsed: z.boolean().nullable().optional(),
  /** Kaydedilmemiş desi — kargo baremi bunu kullanır. Null ise product.desi */
  desi: z.number().min(0).nullable().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureRuntimeSchema();
  const { id } = await params;
  const cost = PreviewSchema.parse(await req.json());

  const product = await prisma.product.findUnique({
    where: { id },
    include: { listings: { where: { isActive: true }, orderBy: { platform: "asc" } } },
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

  const settingsMap = Object.fromEntries(settings.map((s) => [s.key, s.value]));
  const vatRate = Number(settingsMap.vatRate ?? 0);

  // Filament gram fiyatı — gönderilen filamentTypeId'den
  let filamentCostPerGram = 0;
  if (cost.filamentTypeId) {
    const f = await prisma.filamentType.findUnique({ where: { id: cost.filamentTypeId } });
    filamentCostPerGram = f?.costPerGram ?? 0;
  }

  // Kaydedilmemiş değerlerden maliyeti çöz
  const resolved = resolveProductCost(
    {
      costMode: "detailed",
      manualCost: null,
      totalCost: null,
      filamentWeight: cost.filamentWeight ?? 0,
      printTimeHours: cost.printTimeHours ?? 0,
      wasteRate: cost.wasteRate ?? 0,
      packagingOptionId: cost.packagingOptionId ?? null,
      nylonLevel: cost.nylonLevel ?? null,
      tapeUsed: cost.tapeUsed ?? null,
    },
    settingsMap,
    filamentCostPerGram
  );

  const productCost = resolved?.productionCost ?? 0;
  const packagingCost = resolved?.packagingCost ?? 0;
  const hasCost = (resolved?.totalCost ?? 0) > 0;

  const productRules = withProductCommissionRule(
    product,
    commissionRules as Parameters<typeof simulatePrice>[0]["commissionRules"]
  );

  const platforms = product.listings.map((listing) => {
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
      desi: cost.desi ?? product.desi ?? 1,
      commissionRules: productRules,
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

    return {
      platform: listing.platform,
      listingId: listing.id,
      salePrice: listing.salePrice,
      result,
    };
  });

  return NextResponse.json({
    productionCost: productCost,
    packagingCost,
    totalCost: resolved?.totalCost ?? 0,
    hasCost,
    platforms,
  });
}
