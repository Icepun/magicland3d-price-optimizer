import { NextRequest, NextResponse } from "next/server";
import { bustInventoryAlertCaches } from "@/lib/cache-busting";
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

    const updated = await prisma.$transaction(async (tx) => {
      // İlk ifade doğrudan relative WRITE'tır. Önce okuyup sonra absolute değer yazmak
      // lost-update üretirdi; transaction'ı read ile başlatmak da SQLite'ta eşzamanlı
      // yazma sırasında lock upgrade yarışına yol açabilirdi.
      const decremented = await tx.filamentSpool.updateMany({
        where: { id },
        data: { remainingGrams: { decrement: input.grams } },
      });
      if (decremented.count === 0) return null;

      await tx.filamentSpool.updateMany({
        where: { id, remainingGrams: { lt: 0 } },
        data: { remainingGrams: 0 },
      });
      // v37: makaradan gram düşüldüyse artık AÇIKTIR. Yalnız henüz damgalanmamışsa yaz
      // (updateMany + where openedAt:null → ilk tüketimin tarihi korunur, sıra bozulmaz).
      await tx.filamentSpool.updateMany({
        where: { id, openedAt: null },
        data: { openedAt: new Date() },
      });
      const next = await tx.filamentSpool.findUnique({ where: { id } });
      if (!next) {
        // Silme endpoint'i aynı satırı arada kaldırırsa usage oluşturmadan rollback et.
        throw new Error("Makara tüketim sırasında silindi");
      }

      await tx.filamentUsage.create({
        data: {
          spoolId: id,
          productId: input.productId ?? null,
          productName: input.productName ?? null,
          grams: input.grams,
          note: input.note ?? null,
        },
      });

      return next;
    });

    if (!updated) {
      return NextResponse.json({ error: "Makara bulunamadı" }, { status: 404 });
    }

    bustInventoryAlertCaches(); // filament düşümü eşiği geçmiş olabilir → uyarı tazelensin
    return NextResponse.json(updated);
  } catch (error) {
    return jsonError(error);
  }
}
