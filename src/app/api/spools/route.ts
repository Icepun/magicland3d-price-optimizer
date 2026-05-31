import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

export async function GET() {
  try {
    await ensureRuntimeSchema();
    const spools = await prisma.filamentSpool.findMany({
      where: { isActive: true },
      orderBy: [{ remainingGrams: "asc" }, { name: "asc" }],
    });
    return NextResponse.json(spools);
  } catch (error) {
    return jsonError(error);
  }
}

const CreateSchema = z.object({
  name: z.string().min(1),
  material: z.string().default("PLA"),
  colorName: z.string().optional(),
  colorHex: z.string().default("#9ca3af"),
  brand: z.string().optional(),
  totalGrams: z.coerce.number().positive().default(1000),
  remainingGrams: z.coerce.number().min(0).optional(),
  spoolCost: z.coerce.number().min(0).optional(),
  reorderGrams: z.coerce.number().min(0).default(200),
  vendorUrl: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const input = CreateSchema.parse(await req.json());
    const spool = await prisma.filamentSpool.create({
      data: {
        name: input.name.trim(),
        material: input.material,
        colorName: input.colorName?.trim() || null,
        colorHex: input.colorHex,
        brand: input.brand?.trim() || null,
        totalGrams: input.totalGrams,
        remainingGrams: input.remainingGrams ?? input.totalGrams,
        spoolCost: input.spoolCost ?? null,
        reorderGrams: input.reorderGrams,
        vendorUrl: input.vendorUrl?.trim() || null,
      },
    });
    return NextResponse.json(spool, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
