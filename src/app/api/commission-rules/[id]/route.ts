import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const Schema = z.object({
  name: z.string().min(1).optional(),
  categoryName: z.string().nullable().optional(),
  minPrice: z.number().min(0).optional(),
  maxPrice: z.number().min(0).optional(),
  commissionRate: z.number().min(0).max(1).optional(),
  fixedCommission: z.number().min(0).optional(),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const data = Schema.parse(await req.json());
  const rule = await prisma.commissionRule.update({ where: { id }, data });
  return NextResponse.json(rule);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await prisma.commissionRule.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
