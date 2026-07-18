import { NextRequest, NextResponse } from "next/server";
import { invalidateOrdersCache } from "@/lib/orders-cache";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

const CreateSchema = z.object({
  productId: z.string().min(1),
  platform: z.enum(["shopify", "trendyol", "hepsiburada"]),
  externalId: z.string().nullable().optional(),
  externalSku: z.string().nullable().optional(),
  barcode: z.string().trim().nullable().optional(),
  salePrice: z.number().min(0),
  listPrice: z.number().min(0).nullable().optional(),
  stock: z.number().int().min(0).default(0),
  commissionRate: z.number().min(0).max(1).nullable().optional(),
  commissionFixed: z.number().min(0).nullable().optional(),
  cargoCost: z.number().min(0).nullable().optional(),
  isActive: z.boolean().default(true),
});

export async function GET(req: NextRequest) {
  await ensureRuntimeSchema();
  const { searchParams } = new URL(req.url);
  const productId = searchParams.get("productId");
  const platform = searchParams.get("platform");

  const where: Record<string, unknown> = {};
  if (productId) where.productId = productId;
  if (platform) where.platform = platform;

  const listings = await prisma.listing.findMany({
    where,
    orderBy: [{ platform: "asc" }, { updatedAt: "desc" }],
  });
  return NextResponse.json(listings);
}

export async function POST(req: NextRequest) {
  await ensureRuntimeSchema();
  const body = await req.json();
  const data = CreateSchema.parse(body);

  // Upsert: aynı productId+platform varsa update
  const existing = await prisma.listing.findFirst({
    where: { productId: data.productId, platform: data.platform },
  });

  if (existing) {
    const updated = await prisma.listing.update({
      where: { id: existing.id },
      data,
    });
    invalidateOrdersCache(); // listing komisyonu/fiyatı kârı etkiler → sipariş önbelleği düşsün
    return NextResponse.json(updated);
  }

  const created = await prisma.listing.create({ data });
  invalidateOrdersCache();
  return NextResponse.json(created, { status: 201 });
}
