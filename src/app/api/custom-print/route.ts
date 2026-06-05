import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

/** Özel baskılar ürüne bağlı değil — bu sentinel productId ile saklanır (Modeller listesinde çıkmaz). */
const CUSTOM_PID = "__custom__";

/**
 * Yüklenmiş özel baskıları (ürüne bağlı olmayan ad-hoc gcode/3mf) listeler — Yazıcılar sayfasındaki
 * "Özel Baskılar" arşiv ekranı için. Her dosyaya ait yazıcı bilgisini (ad/marka) iliştirir + buluta mı
 * (R2) yoksa yerele mi yüklendiğini işaretler → kullanıcı görüp tekrar basabilir / temizleyebilir.
 */
export async function GET() {
  try {
    await ensureRuntimeSchema();
    const files = await prisma.productModelFile.findMany({
      where: { productId: CUSTOM_PID },
      orderBy: { createdAt: "desc" },
    });

    const printerIds = [...new Set(files.map((f) => f.printerConfigId))];
    const printers = printerIds.length
      ? await prisma.printerConfig.findMany({
          where: { id: { in: printerIds } },
          select: { id: true, name: true, brand: true, model: true, accent: true, enabled: true },
        })
      : [];
    const pmap = new Map(printers.map((p) => [p.id, p]));

    return NextResponse.json(
      files.map((f) => ({
        id: f.id,
        printerConfigId: f.printerConfigId,
        originalName: f.originalName,
        fileType: f.fileType,
        sizeBytes: f.sizeBytes,
        gramaj: f.gramaj,
        estPrintMin: f.estPrintMin,
        isCloud: !!f.r2Key,
        createdAt: f.createdAt,
        printer: pmap.get(f.printerConfigId) ?? null,
      })),
    );
  } catch (error) {
    return jsonError(error);
  }
}
