import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { getModelsDir } from "@/lib/storage";
import { readModelColors, readModelMeta } from "@/core/printers/model-colors";

export const dynamic = "force-dynamic";

const ALLOWED = ["gcode", "gco", "g", "3mf"];
/** Özel baskı dosyaları ürüne bağlı değil — bu sentinel productId ile işaretlenir (listede çıkmaz). */
const CUSTOM_PID = "__custom__";

/**
 * Özel baskı: ürüne bağlı OLMAYAN bir gcode/3mf yükle (özel sipariş vb.). Dosya kaydedilir,
 * meta (süre/gramaj/önizleme) + renkler okunur, ProductModelFile olarak (sentinel productId)
 * oluşturulur → mevcut /api/models/[id]/{colors,print} akışı aynen kullanılır.
 */
export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const form = await req.formData();
    const file = form.get("file");
    const printerConfigId = String(form.get("printerConfigId") || "");

    if (!(file instanceof File)) return NextResponse.json({ error: "Dosya gerekli" }, { status: 400 });
    if (!printerConfigId) return NextResponse.json({ error: "Yazıcı seçilmedi" }, { status: 400 });

    const printer = await prisma.printerConfig.findUnique({ where: { id: printerConfigId } });
    if (!printer) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });

    const ext = (file.name.split(".").pop() || "gcode").toLowerCase();
    if (!ALLOWED.includes(ext)) {
      return NextResponse.json({ error: `Desteklenmeyen tür: .${ext} (gcode / 3mf)` }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const dir = getModelsDir();
    const storedPath = path.join(dir, `${crypto.randomUUID()}.${ext}`);
    fs.writeFileSync(storedPath, buf);

    const meta = readModelMeta(storedPath);
    const colors = readModelColors(storedPath);

    const saved = await prisma.productModelFile.create({
      data: {
        productId: CUSTOM_PID,
        printerConfigId,
        label: null,
        originalName: file.name,
        storedPath,
        fileType: ext,
        sizeBytes: buf.length,
        gramaj: meta.grams,
        estPrintMin: meta.estPrintMin,
        sortOrder: 0,
      },
    });

    return NextResponse.json({
      fileId: saved.id,
      originalName: file.name,
      fileKind: colors.fileKind,
      sizeBytes: buf.length,
      grams: meta.grams,
      estPrintMin: meta.estPrintMin,
      thumbnail: meta.thumbnail,
      colorCount: colors.colors.length,
    });
  } catch (error) {
    return jsonError(error);
  }
}
