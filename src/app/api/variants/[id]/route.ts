import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

const UpdateSchema = z.object({
  name: z.string().min(1).optional(),
  sku: z.string().nullable().optional(),
  barcode: z.string().nullable().optional(),
  colorHex: z.string().nullable().optional(),
  stock: z.coerce.number().int().min(0).optional(),
  priceOverride: z.coerce.number().min(0).nullable().optional(),
  filamentWeightOverride: z.coerce.number().min(0).nullable().optional(),
  sortOrder: z.coerce.number().int().optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const data = UpdateSchema.parse(await req.json());
    const updated = await prisma.productVariant.update({ where: { id }, data });
    return NextResponse.json(updated);
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    await prisma.productVariant.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
