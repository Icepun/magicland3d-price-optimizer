import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const Schema = z.object({
  name: z.string().min(1),
  materialCostPerGram: z.number().min(0).default(0),
  electricityCostPerHour: z.number().min(0).default(0),
  machineWearCostPerHour: z.number().min(0).default(0),
  defaultPackagingCost: z.number().min(0).default(0),
  defaultLaborCost: z.number().min(0).default(0),
  defaultOtherCost: z.number().min(0).default(0),
  defaultWasteRate: z.number().min(0).max(1).default(0),
  isActive: z.boolean().default(true),
});

export async function GET() {
  const templates = await prisma.costTemplate.findMany({
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });
  return NextResponse.json(templates);
}

export async function POST(req: NextRequest) {
  const data = Schema.parse(await req.json());
  const template = await prisma.costTemplate.create({ data });
  return NextResponse.json(template, { status: 201 });
}
