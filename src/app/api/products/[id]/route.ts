import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
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
      costMode: z.enum(["manual", "template"]).optional(),
      templateId: z.string().nullable().optional(),
      manualCost: z.number().min(0).nullable().optional(),
      materialWeight: z.number().min(0).nullable().optional(),
      printTimeHours: z.number().min(0).nullable().optional(),
      materialCost: z.number().min(0).nullable().optional(),
      electricityCost: z.number().min(0).nullable().optional(),
      machineWearCost: z.number().min(0).nullable().optional(),
      packagingCost: z.number().min(0).nullable().optional(),
      laborCost: z.number().min(0).nullable().optional(),
      otherCost: z.number().min(0).nullable().optional(),
      wasteRate: z.number().min(0).max(1).nullable().optional(),
      totalCost: z.number().min(0).nullable().optional(),
    })
    .optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      cost: true,
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
    await prisma.productCost.upsert({
      where: { productId: id },
      create: { productId: id, ...cost },
      update: cost,
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
