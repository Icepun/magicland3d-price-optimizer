import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

/** Özel baskılar ürüne bağlı değil — bu sentinel productId ile saklanır (Modeller listesinde çıkmaz). */
const CUSTOM_PID = "__custom__";

/**
 * Yüklenmiş özel baskıları (ürüne bağlı olmayan ad-hoc gcode/3mf) listeler — Yazıcılar sayfasındaki
 * "Özel Baskılar" arşiv ekranı için. Her dosyaya yazıcı bilgisi + önizleme görseli (varsa) iliştirir,
 * ayrıca DEPOLAMA ÖZETİ döndürür: özel baskıların toplamı + TÜM model dosyalarının bulut kullanımı
 * (kullanıcı R2'de ne kadar yer tuttuğunu görebilsin).
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

    // Depolama özeti — sizeBytes v0.19.93'ten beri R2 HeadObject doğrulamalı (gerçek boyut).
    const customCloudBytes = files.reduce((s, f) => s + (f.r2Key ? f.sizeBytes : 0), 0);
    const customLocalBytes = files.reduce((s, f) => s + (!f.r2Key ? f.sizeBytes : 0), 0);
    const cloudAll = await prisma.productModelFile.aggregate({
      where: { r2Key: { not: null } },
      _sum: { sizeBytes: true },
      _count: { _all: true },
    });

    return NextResponse.json({
      items: files.map((f) => ({
        id: f.id,
        printerConfigId: f.printerConfigId,
        originalName: f.originalName,
        fileType: f.fileType,
        sizeBytes: f.sizeBytes,
        gramaj: f.gramaj,
        estPrintMin: f.estPrintMin,
        isCloud: !!f.r2Key,
        thumbnail: f.thumbnail ?? null,
        createdAt: f.createdAt,
        printer: pmap.get(f.printerConfigId) ?? null,
      })),
      summary: {
        count: files.length,
        customCloudBytes,
        customLocalBytes,
        /** TÜM model dosyalarının (ürün + özel) buluttaki toplamı. */
        cloudTotalBytes: cloudAll._sum.sizeBytes ?? 0,
        cloudTotalCount: cloudAll._count._all,
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
