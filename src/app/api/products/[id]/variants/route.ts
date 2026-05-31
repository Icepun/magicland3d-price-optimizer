import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const variants = await prisma.productVariant.findMany({
      where: { productId: id },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    return NextResponse.json(variants);
  } catch (error) {
    return jsonError(error);
  }
}

const CreateSchema = z.object({
  name: z.string().min(1),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  colorHex: z.string().optional(),
  stock: z.coerce.number().int().min(0).default(0),
  priceOverride: z.coerce.number().min(0).nullable().optional(),
  filamentWeightOverride: z.coerce.number().min(0).nullable().optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const input = CreateSchema.parse(await req.json());
    const count = await prisma.productVariant.count({ where: { productId: id } });
    const variant = await prisma.productVariant.create({
      data: {
        productId: id,
        name: input.name.trim(),
        sku: input.sku?.trim() || null,
        barcode: input.barcode?.trim() || null,
        colorHex: input.colorHex || null,
        stock: input.stock,
        priceOverride: input.priceOverride ?? null,
        filamentWeightOverride: input.filamentWeightOverride ?? null,
        sortOrder: count,
      },
    });
    return NextResponse.json(variant, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
