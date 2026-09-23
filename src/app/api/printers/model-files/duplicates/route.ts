import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { findDuplicateFiles } from "@/core/printers/printer-family";
import { modelSatirlariniSil } from "@/lib/model-file-cleanup";
import { bustModelCaches } from "@/lib/cache-busting";

export const dynamic = "force-dynamic";

/**
 * KOPYA DOSYALAR — aynı yazıcı ailesinde aynı içeriği taşıyan fazladan model dosyaları.
 *
 * Aile kavramı gelmeden (23 Eyl 2026) ikinci U1'de basabilmek için aynı dosyalar tekrar
 * yüklendi; ölçüldü: 22 kopya, 834 MB bulut alanı. GET ne kadar olduğunu söyler, POST
 * temizler. Hesap her iki uçta da SUNUCUDA yeniden yapılır — istemcinin gönderdiği bir kimlik
 * listesine güvenilmez. Silme `modelSatirlariniSil` ile: başka satırın hâlâ kullandığı bulut
 * nesnesi silinmez.
 */
async function hesapla() {
  const [satirlar, yazicilar] = await Promise.all([
    prisma.productModelFile.findMany({
      select: {
        id: true, productId: true, printerConfigId: true, label: true, originalName: true,
        sizeBytes: true, contentMd5: true, createdAt: true, r2Key: true, meshR2Key: true,
        storedPath: true, meshSizeBytes: true,
      },
    }),
    prisma.printerConfig.findMany({ select: { id: true, type: true, brand: true, model: true } }),
  ]);
  return findDuplicateFiles(satirlar, yazicilar).fazla;
}

export async function GET() {
  try {
    await ensureRuntimeSchema();
    const fazla = await hesapla();
    return NextResponse.json({
      count: fazla.length,
      bytes: fazla.reduce((s, f) => s + (f.sizeBytes || 0), 0),
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST() {
  try {
    await ensureRuntimeSchema();
    const fazla = await hesapla();
    const bytes = fazla.reduce((s, f) => s + (f.sizeBytes || 0), 0);
    const sonuc = await modelSatirlariniSil(fazla);
    bustModelCaches();
    return NextResponse.json({ ok: true, deleted: sonuc.satir, files: sonuc.dosya, bytes });
  } catch (error) {
    return jsonError(error);
  }
}
