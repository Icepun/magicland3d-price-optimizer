import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { invalidatePrintFileMatches } from "@/core/printers/status-cache";

const Schema = z.object({
  filename: z.string().min(1, "Dosya adı gerekli"),
  productId: z.string().nullable(),
});

/** Çalışan baskının (printerId + filename) hangi katalog ürününe karşılık geldiğini kaydet/sil. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const { filename, productId } = Schema.parse(await req.json());

    if (!productId) {
      await prisma.printFileProduct.deleteMany({ where: { printerConfigId: id, filename } });
      invalidatePrintFileMatches(); // panel değişikliği 30sn TTL beklemeden görsün
      return NextResponse.json({ ok: true, cleared: true });
    }

    const saved = await prisma.printFileProduct.upsert({
      where: { printerConfigId_filename: { printerConfigId: id, filename } },
      create: { printerConfigId: id, filename, productId },
      update: { productId },
    });
    invalidatePrintFileMatches(); // panel yeni eşleşmeyi 30sn TTL beklemeden görsün
    return NextResponse.json(saved);
  } catch (error) {
    return jsonError(error);
  }
}
