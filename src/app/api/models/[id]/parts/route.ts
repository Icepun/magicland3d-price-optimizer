import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { modelDosyaParcalari } from "@/lib/model-parts";
import { bedFrameFor } from "@/app/printers/panel-view";
import { vizKeyForModel } from "@/lib/gcode-viz/viz-anahtar";

export const dynamic = "force-dynamic";

/**
 * Baskı BAŞLAMADAN dosyanın parçaları — başlatma penceresindeki "hangi parçalar basılsın?" seçimi.
 *
 * `?printerId=` hedef yazıcıdır: parça kimlikleri yazıcı türüne göre değişir (Bambu identify_id,
 * Klipper nesne adı) ve tepeden görünüşün ölçeği o yazıcının tablasıdır. Yanıt:
 *   { parts, neden?, frame, model3d }  — `model3d` 3B seçicinin önbellek anahtarıdır.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const printerId = req.nextUrl.searchParams.get("printerId");
    const mf = await prisma.productModelFile.findUnique({
      where: { id },
      select: {
        id: true, originalName: true, fileType: true, sizeBytes: true, contentMd5: true,
        r2Key: true, storedPath: true, printerConfigId: true,
      },
    });
    if (!mf) return NextResponse.json({ error: "Model dosyası bulunamadı" }, { status: 404 });
    const printer = await prisma.printerConfig.findUnique({
      where: { id: printerId || mf.printerConfigId },
      select: { type: true, brand: true, model: true },
    });
    if (!printer) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });

    const bambu = printer.type === "bambu" || printer.brand === "bambu";
    const sonuc = await modelDosyaParcalari(mf, bambu);
    return NextResponse.json({
      ...sonuc,
      frame: bedFrameFor(printer.brand ?? "", printer.model ?? ""),
      model3d: { fileId: mf.id, cacheKey: vizKeyForModel(mf) },
    });
  } catch (error) {
    return jsonError(error);
  }
}
