import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { getModelsDir } from "@/lib/storage";
import { readModelColors, readModelMeta, is3mfSliced } from "@/core/printers/model-colors";
import { resolveModelFileLocal } from "@/lib/model-files";
import { getR2Config, isValidModelKey, headObjectSize } from "@/lib/r2";

export const dynamic = "force-dynamic";

const ALLOWED = ["gcode", "gco", "g", "3mf"];
/** Özel baskı dosyaları ürüne bağlı değil — bu sentinel productId ile işaretlenir (listede çıkmaz). */
const CUSTOM_PID = "__custom__";

/**
 * Özel baskı: ürüne bağlı OLMAYAN bir gcode/3mf (özel sipariş vb.). R2 açıksa dosya tarayıcıdan
 * R2'ye yüklenir, burada JSON confirm gelir (r2Key); değilse multipart yerel yükleme. Her iki halde
 * meta (süre/gramaj/önizleme) + renkler dosyadan okunur → ProductModelFile (sentinel productId)
 * oluşturulur → mevcut /api/models/[id]/{colors,print} akışı aynen kullanılır.
 */
export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const ct = req.headers.get("content-type") || "";

    let r2Key: string | null = null;
    let storedPath = "";
    let originalName = "";
    let printerConfigId = "";
    let sizeBytes = 0;
    let fileType = "gcode";
    let readPath = "";
    let cleanup: () => void = () => {};

    if (ct.includes("application/json")) {
      // ── R2 CONFIRM ──
      const b = (await req.json()) as {
        r2Key?: string;
        originalName?: string;
        printerConfigId?: string;
        sizeBytes?: number;
      };
      r2Key = String(b.r2Key || "");
      originalName = String(b.originalName || "");
      printerConfigId = String(b.printerConfigId || "");
      sizeBytes = Number(b.sizeBytes) || 0;
      if (!r2Key) return NextResponse.json({ error: "r2Key gerekli" }, { status: 400 });
      if (!printerConfigId) return NextResponse.json({ error: "Yazıcı seçilmedi" }, { status: 400 });
      // CONFIRM DOĞRULAMASI: key şekli + nesnenin R2'de gerçekten var olduğu (gerçek boyutla).
      if (!isValidModelKey(r2Key)) return NextResponse.json({ error: "Geçersiz dosya anahtarı" }, { status: 400 });
      const r2cfgCheck = await getR2Config();
      if (r2cfgCheck) {
        const realSize = await headObjectSize(r2Key, r2cfgCheck);
        if (realSize == null) return NextResponse.json({ error: "Dosya buluta ulaşmamış — yüklemeyi tekrar dene" }, { status: 400 });
        sizeBytes = realSize;
      }
      const printer = await prisma.printerConfig.findUnique({ where: { id: printerConfigId } });
      if (!printer) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });
      fileType = (originalName.split(".").pop() || "gcode").toLowerCase();
      if (!ALLOWED.includes(fileType)) {
        return NextResponse.json({ error: `Desteklenmeyen tür: .${fileType} (gcode / 3mf)` }, { status: 400 });
      }
      const local = await resolveModelFileLocal({ r2Key, storedPath: "", fileType });
      readPath = local.path;
      cleanup = local.cleanup;
    } else {
      // ── YEREL (R2 kapalı / fallback) ──
      const form = await req.formData();
      const file = form.get("file");
      printerConfigId = String(form.get("printerConfigId") || "");
      if (!(file instanceof File)) return NextResponse.json({ error: "Dosya gerekli" }, { status: 400 });
      if (!printerConfigId) return NextResponse.json({ error: "Yazıcı seçilmedi" }, { status: 400 });
      const printer = await prisma.printerConfig.findUnique({ where: { id: printerConfigId } });
      if (!printer) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });
      fileType = (file.name.split(".").pop() || "gcode").toLowerCase();
      if (!ALLOWED.includes(fileType)) {
        return NextResponse.json({ error: `Desteklenmeyen tür: .${fileType} (gcode / 3mf)` }, { status: 400 });
      }
      const buf = Buffer.from(await file.arrayBuffer());
      storedPath = path.join(getModelsDir(), `${crypto.randomUUID()}.${fileType}`);
      await fs.promises.writeFile(storedPath, buf); // sync yazma büyük dosyada ana süreci donduruyordu
      readPath = storedPath;
      originalName = file.name;
      sizeBytes = buf.length;
    }

    try {
      const meta = readModelMeta(readPath);
      const colors = readModelColors(readPath);
      // Meta yüklemede zaten parse ediliyordu ama SAKLANMIYORDU → renk-eşleme/baskı dosyayı
      // (R2'den indirip) yeniden açıyordu. Artık bir kez parse edilir, kalıcı olur.
      let sliced: boolean | null = null;
      try { sliced = fileType === "3mf" ? is3mfSliced(readPath) : true; } catch { /* lazy yol devrede */ }
      const saved = await prisma.productModelFile.create({
        data: {
          productId: CUSTOM_PID,
          printerConfigId,
          label: null,
          originalName,
          storedPath,
          r2Key,
          fileType,
          sizeBytes,
          gramaj: meta.grams,
          estPrintMin: meta.estPrintMin,
          colorsJson: JSON.stringify(colors),
          sliced,
          thumbnail: meta.thumbnail ?? null, // arşivde küçük görsel — zaten çıkarılıyordu, artık saklanıyor
          sortOrder: 0,
        },
      });
      return NextResponse.json({
        fileId: saved.id,
        originalName,
        fileKind: colors.fileKind,
        sizeBytes,
        grams: meta.grams,
        estPrintMin: meta.estPrintMin,
        thumbnail: meta.thumbnail,
        colorCount: colors.colors.length,
      });
    } finally {
      cleanup();
    }
  } catch (error) {
    return jsonError(error);
  }
}
