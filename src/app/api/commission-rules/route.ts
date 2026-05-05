import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const Schema = z.object({
  name: z.string().min(1),
  categoryName: z.string().nullable().optional(),
  minPrice: z.number().min(0).default(0),
  maxPrice: z.number().min(0).default(999999),
  commissionRate: z.number().min(0).max(1),
  fixedCommission: z.number().min(0).default(0),
  validFrom: z.string().datetime().nullable().optional(),
  validTo: z.string().datetime().nullable().optional(),
  priority: z.number().int().default(10),
  isActive: z.boolean().default(true),
});

export async function GET() {
  const rules = await prisma.commissionRule.findMany({
    orderBy: [{ isActive: "desc" }, { priority: "desc" }, { name: "asc" }],
  });
  return NextResponse.json(rules);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const data = Schema.parse(body);
  const rule = await prisma.commissionRule.create({ data });
  return NextResponse.json(rule, { status: 201 });
}
