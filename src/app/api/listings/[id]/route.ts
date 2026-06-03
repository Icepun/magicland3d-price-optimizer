import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

const UpdateSchema = z.object({
  salePrice: z.number().min(0).optional(),
  barcode: z.string().trim().nullable().optional(),
  listPrice: z.number().min(0).nullable().optional(),
  stock: z.number().int().min(0).optional(),
  commissionRate: z.number().min(0).max(1).nullable().optional(),
  commissionFixed: z.number().min(0).nullable().optional(),
  cargoCost: z.number().min(0).nullable().optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureRuntimeSchema();
  const { id } = await params;
  const data = UpdateSchema.parse(await req.json());

  // Manuel fiyat değişikliğini fiyat geçmişine yaz (yalnızca salePrice gerçekten değişince).
  let before: { productId: string; salePrice: number } | null = null;
  if (data.salePrice !== undefined) {
    before = await prisma.listing.findUnique({
      where: { id },
      select: { productId: true, salePrice: true },
    });
  }

  const updated = await prisma.listing.update({ where: { id }, data });

  if (
    before &&
    data.salePrice !== undefined &&
    Math.abs(before.salePrice - data.salePrice) > 0.001
  ) {
    await prisma.priceHistory.create({
      data: {
        productId: before.productId,
        oldPrice: before.salePrice,
        newPrice: data.salePrice,
        changeSource: "manual",
      },
    });
  }

  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureRuntimeSchema();
  const { id } = await params;
  await prisma.listing.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
