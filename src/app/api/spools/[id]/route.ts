import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

const UpdateSchema = z.object({
  name: z.string().min(1).optional(),
  material: z.string().optional(),
  colorName: z.string().nullable().optional(),
  colorHex: z.string().optional(),
  brand: z.string().nullable().optional(),
  totalGrams: z.coerce.number().positive().optional(),
  remainingGrams: z.coerce.number().min(0).optional(),
  spoolCost: z.coerce.number().min(0).nullable().optional(),
  reorderGrams: z.coerce.number().min(0).optional(),
  vendorUrl: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const data = UpdateSchema.parse(await req.json());
    const updated = await prisma.filamentSpool.update({ where: { id }, data });
    return NextResponse.json(updated);
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    await prisma.filamentSpool.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
