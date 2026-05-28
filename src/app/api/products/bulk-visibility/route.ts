import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { z } from "zod";

const Schema = z.object({
  ids: z.array(z.string().min(1)).min(1),
  hidden: z.boolean(),
});

/**
 * Birden fazla ürünü topluca gizle / geri getir (silmeden).
 */
export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const { ids, hidden } = Schema.parse(await req.json());
    const result = await prisma.product.updateMany({
      where: { id: { in: ids } },
      data: { hidden },
    });
    return NextResponse.json({ updated: result.count });
  } catch (error) {
    return jsonError(error);
  }
}
