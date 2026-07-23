import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { invalidateOrdersCache } from "@/lib/orders-cache";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

const Schema = z.object({
  name: z.string().min(1).optional(),
  platform: z.enum(["trendyol", "shopify", "hepsiburada"]).nullable().optional(),
  cargoProvider: z.string().nullable().optional(),
  categoryName: z.string().nullable().optional(),
  minPrice: z.number().min(0).optional(),
  maxPrice: z.number().min(0).optional(),
  minDesi: z.number().min(0).optional(),
  maxDesi: z.number().min(0).optional(),
  cargoCost: z.number().min(0).optional(),
  vatIncluded: z.boolean().optional(),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureRuntimeSchema();
  const { id } = await params;
  const data = Schema.parse(await req.json());
  const rule = await prisma.cargoRule.update({ where: { id }, data });
  invalidateOrdersCache();
  return NextResponse.json(rule);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureRuntimeSchema();
  const { id } = await params;
  await prisma.cargoRule.delete({ where: { id } });
  invalidateOrdersCache();
  return NextResponse.json({ ok: true });
}
