import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const Schema = z.object({
  name: z.string().min(1).optional(),
  materialCostPerGram: z.number().min(0).optional(),
  electricityCostPerHour: z.number().min(0).optional(),
  machineWearCostPerHour: z.number().min(0).optional(),
  defaultPackagingCost: z.number().min(0).optional(),
  defaultLaborCost: z.number().min(0).optional(),
  defaultOtherCost: z.number().min(0).optional(),
  defaultWasteRate: z.number().min(0).max(1).optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const data = Schema.parse(await req.json());
  const template = await prisma.costTemplate.update({ where: { id }, data });
  return NextResponse.json(template);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await prisma.costTemplate.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
