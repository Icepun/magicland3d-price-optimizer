import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { computeFullProductCost } from "@/core/cost-calculator";
import { computePackagingCost, parsePackagingSettings } from "@/core/packaging";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { z } from "zod";

const UpdateProductSchema = z.object({
  name: z.string().min(1).optional(),
  // Barkod elle düzeltilebilir: Shopify'da gerçek barkod yoksa "shopify-variant-X" fallback'i
  // yazılır; kullanıcı gerçek (Trendyol/HB ile ortak) barkodu girince siparişler eşleşir.
  barcode: z.string().trim().min(1).max(120).optional(),
  // Kısa takma ad — listede gösterilir + aramada kullanılır. Boş gönderilirse temizlenir.
  alias: z.string().max(80).nullable().optional(),
  categoryName: z.string().min(1).optional(),
  currentSalePrice: z.number().positive().optional(),
  listPrice: z.number().positive().nullable().optional(),
  stock: z.number().int().min(0).optional(),
  desi: z.number().positive().nullable().optional(),
  weight: z.number().positive().nullable().optional(),
  isActive: z.boolean().optional(),
  hidden: z.boolean().optional(),
  variantGroupId: z.string().nullable().optional(),
  variantLabel: z.string().nullable().optional(),
  cost: z
    .object({
      costMode: z.enum(["manual", "template", "detailed"]).optional(),
      templateId: z.string().nullable().optional(),
      filamentTypeId: z.string().nullable().optional(),
      filamentWeight: z.number().min(0).nullable().optional(),
      printTimeHours: z.number().min(0).nullable().optional(),
      wasteRate: z.number().min(0).max(1).nullable().optional(),
      packagingPoset: z.number().min(0).nullable().optional(),
      packagingNaylon: z.number().min(0).nullable().optional(),
      packagingBant: z.number().min(0).nullable().optional(),
      packagingKart: z.number().min(0).nullable().optional(),
      // Yeni seçim bazlı paketleme
      packagingOptionId: z.string().nullable().optional(),
      nylonLevel: z.enum(["none", "low", "medium", "high"]).nullable().optional(),
      tapeUsed: z.boolean().nullable().optional(),
      manualCost: z.number().min(0).nullable().optional(),
      materialWeight: z.number().min(0).nullable().optional(),
      materialCost: z.number().min(0).nullable().optional(),
      electricityCost: z.number().min(0).nullable().optional(),
      machineWearCost: z.number().min(0).nullable().optional(),
      packagingCost: z.number().min(0).nullable().optional(),
      laborCost: z.number().min(0).nullable().optional(),
      otherCost: z.number().min(0).nullable().optional(),
      totalCost: z.number().min(0).nullable().optional(),
    })
    .optional(),
});
type ProductCostPatch = NonNullable<z.infer<typeof UpdateProductSchema>["cost"]>;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureRuntimeSchema();

  const { id } = await params;
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      cost: {
        include: {
          filamentType: true,
        }
      },
      priceHistory: { orderBy: { changedAt: "desc" }, take: 20 },
      listings: { orderBy: { platform: "asc" } },
      variantGroup: {
        select: {
          id: true,
          name: true,
          products: {
            select: { id: true, name: true, variantLabel: true, imageUrl: true, stock: true, currentSalePrice: true },
            orderBy: [{ variantLabel: "asc" }, { name: "asc" }],
          },
        },
      },
    },
  });

  if (!product) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(product);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureRuntimeSchema();

  const { id } = await params;
  const body = await req.json();
  const { cost, ...productData } = UpdateProductSchema.parse(body);

  // Boş takma ad → null (DB'de tutarlı). Barkod trim'lendi (şemada).
  if (typeof productData.alias === "string") {
    productData.alias = productData.alias.trim() || null;
  }

  // Manuel fiyat değişikliğini fiyat geçmişine yaz (yalnızca fiyat gerçekten değişince).
  let priceBefore: number | null = null;
  if (productData.currentSalePrice !== undefined) {
    const before = await prisma.product.findUnique({
      where: { id },
      select: { currentSalePrice: true },
    });
    priceBefore = before?.currentSalePrice ?? null;
  }

  // Varyant grubu değişiyorsa, eski grubu sonradan temizlemek için önceki grubu al.
  let prevGroupId: string | null = null;
  if (productData.variantGroupId !== undefined) {
    const before = await prisma.product.findUnique({
      where: { id },
      select: { variantGroupId: true },
    });
    prevGroupId = before?.variantGroupId ?? null;
  }

  // Barkod UNIQUE — kullanıcı başka üründe kullanılan bir barkod girerse net hata dön.
  const product = await prisma.product
    .update({ where: { id }, data: productData })
    .catch((e: unknown) => {
      if ((e as { code?: string })?.code === "P2002") return null;
      throw e;
    });
  if (!product) {
    return NextResponse.json(
      { error: "Bu barkod başka bir üründe kullanılıyor." },
      { status: 409 }
    );
  }

  // Üye eski gruptan ayrıldıysa ve grup boş kaldıysa grubu sil (yetim grup bırakma).
  if (prevGroupId && prevGroupId !== productData.variantGroupId) {
    const remaining = await prisma.product.count({ where: { variantGroupId: prevGroupId } });
    if (remaining === 0) {
      await prisma.variantGroup.delete({ where: { id: prevGroupId } }).catch(() => {});
    }
  }

  if (
    priceBefore !== null &&
    productData.currentSalePrice !== undefined &&
    Math.abs(priceBefore - productData.currentSalePrice) > 0.001
  ) {
    await prisma.priceHistory.create({
      data: {
        productId: id,
        oldPrice: priceBefore,
        newPrice: productData.currentSalePrice,
        changeSource: "manual",
      },
    });
  }

  if (cost !== undefined) {
    let finalCost: ProductCostPatch = { ...cost };
    if (cost.costMode === "detailed") {
      const appSettings = await prisma.appSetting.findMany();
      const settings = Object.fromEntries(appSettings.map((s) => [s.key, s.value]));
      const electricityCostPerHour = parseFloat(settings.costElectricityPerHour || "0");
      const machineWearCostPerHour = parseFloat(settings.costMachineWearPerHour || "0");
      const laborCostPerHour = parseFloat(settings.costLaborPerHour || "0");

      let costPerGram = 0;
      if (cost.filamentTypeId) {
        const filament = await prisma.filamentType.findUnique({
          where: { id: cost.filamentTypeId },
        });
        costPerGram = filament?.costPerGram || 0;
      }

      // Dinamik paketleme — seçimlerden + güncel ayarlardan
      const packagingSettings = parsePackagingSettings(settings);
      const packaging = computePackagingCost(
        {
          packagingOptionId: cost.packagingOptionId,
          nylonLevel: cost.nylonLevel,
          tapeUsed: cost.tapeUsed,
        },
        packagingSettings
      );

      const calc = computeFullProductCost({
        filamentWeight: cost.filamentWeight ?? 0,
        costPerGram,
        printTimeHours: cost.printTimeHours ?? 0,
        electricityCostPerHour,
        machineWearCostPerHour,
        laborCostPerHour,
        wasteRate: cost.wasteRate ?? 0,
        packagingCost: packaging.total,
      });

      finalCost = {
        ...cost,
        materialCost: calc.filamentCost,
        electricityCost: calc.electricityCost,
        machineWearCost: calc.machineWearCost,
        laborCost: calc.laborCost,
        packagingCost: calc.packagingCost,
        otherCost: calc.wasteCost,
        totalCost: calc.totalCost,
      };
    }

    await prisma.productCost.upsert({
      where: { productId: id },
      create: { productId: id, ...finalCost },
      update: finalCost,
    });
  }

  return NextResponse.json(product);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureRuntimeSchema();

  const { id } = await params;
  // Silmeden önce grup bilgisini al — silince grup boş kalırsa grubu da temizle.
  const existing = await prisma.product.findUnique({
    where: { id },
    select: { variantGroupId: true },
  });
  await prisma.product.delete({ where: { id } });

  if (existing?.variantGroupId) {
    const remaining = await prisma.product.count({
      where: { variantGroupId: existing.variantGroupId },
    });
    if (remaining === 0) {
      await prisma.variantGroup.delete({ where: { id: existing.variantGroupId } }).catch(() => {});
    }
  }
  return NextResponse.json({ ok: true });
}
