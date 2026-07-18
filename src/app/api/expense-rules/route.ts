import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { invalidateOrdersCache } from "@/lib/orders-cache";

const Schema = z.object({
  name: z.string().min(1),
  platform: z.enum(["trendyol", "shopify", "hepsiburada"]).nullable().optional(),
  type: z.enum(["fixed", "percentage", "per_order"]),
  value: z.number().min(0),
  categoryName: z.string().nullable().optional(),
  minPrice: z.number().min(0).default(0),
  maxPrice: z.number().min(0).default(999999),
  priority: z.number().int().default(10),
  isActive: z.boolean().default(true),
});

export async function GET() {
  const rules = await prisma.expenseRule.findMany({
    orderBy: [{ isActive: "desc" }, { priority: "desc" }, { name: "asc" }],
  });
  return NextResponse.json(rules);
}

export async function POST(req: NextRequest) {
  const data = Schema.parse(await req.json());
  const rule = await prisma.expenseRule.create({ data });
  invalidateOrdersCache(); // komisyon/gider değişti → sipariş kârı taze hesaplansın
  return NextResponse.json(rule, { status: 201 });
}
