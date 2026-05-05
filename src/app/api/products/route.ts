import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const CreateProductSchema = z.object({
  barcode: z.string().min(1),
  sku: z.string().min(1),
  name: z.string().min(1),
  categoryName: z.string().min(1),
  currentSalePrice: z.number().positive(),
  listPrice: z.number().positive().optional(),
  stock: z.number().int().min(0).default(0),
  desi: z.number().positive().optional(),
  weight: z.number().positive().optional(),
  isActive: z.boolean().default(true),
});

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const filter = searchParams.get("filter");
  const search = searchParams.get("search");

  const where: Record<string, unknown> = {};

  if (filter === "active") where.isActive = true;
  if (filter === "negative-profit") {
    // We'll compute this in-memory after fetching with costs
  }

  if (search) {
    where.OR = [
      { name: { contains: search } },
      { barcode: { contains: search } },
      { sku: { contains: search } },
      { categoryName: { contains: search } },
    ];
  }

  const products = await prisma.product.findMany({
    where,
    include: {
      cost: true,
      recommendations: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json(products);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const data = CreateProductSchema.parse(body);

  const product = await prisma.product.create({ data });
  return NextResponse.json(product, { status: 201 });
}
