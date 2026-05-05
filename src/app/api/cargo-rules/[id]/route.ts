import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const Schema = z.object({
  name: z.string().min(1).optional(),
  cargoProvider: z.string().nullable().optional(),
  categoryName: z.string().nullable().optional(),
  minPrice: z.number().min(0).optional(),
  maxPrice: z.number().min(0).optional(),
  minDesi: z.number().min(0).optional(),
  maxDesi: z.number().min(0).optional(),
  cargoCost: z.number().min(0).optional(),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const data = Schema.parse(await req.json());
  const rule = await prisma.cargoRule.update({ where: { id }, data });
  return NextResponse.json(rule);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await prisma.cargoRule.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
