import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

const UpdateSchema = z.object({
  salePrice: z.number().min(0).optional(),
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
  const updated = await prisma.listing.update({ where: { id }, data });
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
