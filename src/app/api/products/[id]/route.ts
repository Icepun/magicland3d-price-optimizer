import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { calculateDetailedCost } from "@/core/cost-calculator";
import { z } from "zod";

const UpdateProductSchema = z.object({
  name: z.string().min(1).optional(),
  categoryName: z.string().min(1).optional(),
  currentSalePrice: z.number().positive().optional(),
  listPrice: z.number().positive().nullable().optional(),
  stock: z.number().int().min(0).optional(),
  desi: z.number().positive().nullable().optional(),
  weight: z.number().positive().nullable().optional(),
  isActive: z.boolean().optional(),
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
  const { id } = await params;
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      cost: {
        include: {
          filamentType: true,
        }
      },
      recommendations: { orderBy: { createdAt: "desc" }, take: 5 },
      priceHistory: { orderBy: { changedAt: "desc" }, take: 20 },
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
  const { id } = await params;
  const body = await req.json();
  const { cost, ...productData } = UpdateProductSchema.parse(body);

  const product = await prisma.product.update({
    where: { id },
    data: productData,
  });

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

      const calc = calculateDetailedCost({
        filamentWeight: cost.filamentWeight ?? 0,
        costPerGram,
        printTimeHours: cost.printTimeHours ?? 0,
        electricityCostPerHour,
        machineWearCostPerHour,
        laborCostPerHour,
        packagingPoset: cost.packagingPoset ?? 0,
        packagingNaylon: cost.packagingNaylon ?? 0,
        packagingBant: cost.packagingBant ?? 0,
        packagingKart: cost.packagingKart ?? 0,
        wasteRate: cost.wasteRate ?? 0,
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
  const { id } = await params;
  await prisma.product.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
