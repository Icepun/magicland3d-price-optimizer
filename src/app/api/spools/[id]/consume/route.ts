import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

/**
 * Makaradan filament düş — baskı/manuel. Basılan modelin gramajı (× adet) kadar
 * remainingGrams azalır, FilamentUsage kaydı oluşur. Negatife düşmez.
 */
const ConsumeSchema = z.object({
  grams: z.coerce.number().positive(),
  productId: z.string().nullable().optional(),
  productName: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const input = ConsumeSchema.parse(await req.json());

    const spool = await prisma.filamentSpool.findUnique({ where: { id } });
    if (!spool) {
      return NextResponse.json({ error: "Makara bulunamadı" }, { status: 404 });
    }

    const remaining = Math.max(0, spool.remainingGrams - input.grams);

    const [updated] = await prisma.$transaction([
      prisma.filamentSpool.update({ where: { id }, data: { remainingGrams: remaining } }),
      prisma.filamentUsage.create({
        data: {
          spoolId: id,
          productId: input.productId ?? null,
          productName: input.productName ?? null,
          grams: input.grams,
          note: input.note ?? null,
        },
      }),
    ]);

    return NextResponse.json(updated);
  } catch (error) {
    return jsonError(error);
  }
}
