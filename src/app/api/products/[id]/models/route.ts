import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { getModelsDir } from "@/lib/storage";
import { createModelRows } from "@/lib/model-files";
import { getR2Config, isValidModelKey, headObjectSize } from "@/lib/r2";
import { readModelColors, is3mfSliced } from "@/core/printers/model-colors";

export const dynamic = "force-dynamic";

const ALLOWED = ["gcode", "gco", "g", "3mf"];

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const files = await prisma.productModelFile.findMany({
      where: { productId: id },
      orderBy: [{ printerConfigId: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    });
    return NextResponse.json(files);
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const ct = req.headers.get("content-type") || "";

    // ── R2 CONFIRM: dosya tarayıcıdan zaten R2'ye yüklendi → sadece metadata satırı oluştur ──
    if (ct.includes("application/json")) {
      const b = (await req.json()) as {
        r2Key?: string;
        originalName?: string;
        printerConfigId?: string;
        sizeBytes?: number;
        applyToVariants?: boolean;
        label?: string | null;
        gramaj?: number | null;
        estPrintMin?: number | null;
      };
      const r2Key = String(b.r2Key || "");
      const printerConfigId = String(b.printerConfigId || "");
      const originalName = String(b.originalName || "");
      if (!r2Key) return NextResponse.json({ error: "r2Key gerekli" }, { status: 400 });
      if (!printerConfigId) return NextResponse.json({ error: "Yazıcı seçilmedi" }, { status: 400 });
      const ext = (originalName.split(".").pop() || "gcode").toLowerCase();
      if (!ALLOWED.includes(ext)) {
        return NextResponse.json({ error: `Desteklenmeyen tür: .${ext} (gcode / 3mf)` }, { status: 400 });
      }
      // CONFIRM DOĞRULAMASI: key bizim ürettiğimiz şekilde mi + nesne GERÇEKTEN R2'de mi?
      // Eskiden keyfi bir key kabul edilip hayalet satır oluşabiliyor (baskı anında 502) ve
      // sizeBytes istemci beyanına kalıyordu.
      if (!isValidModelKey(r2Key)) return NextResponse.json({ error: "Geçersiz dosya anahtarı" }, { status: 400 });
      const r2cfg = await getR2Config();
      if (!r2cfg) return NextResponse.json({ error: "Bulut depolama ayarlı değil" }, { status: 400 });
      const realSize = await headObjectSize(r2Key, r2cfg);
      if (realSize == null) return NextResponse.json({ error: "Dosya buluta ulaşmamış — yüklemeyi tekrar dene" }, { status: 400 });
      const mine = await createModelRows({
        productId: id,
        applyToVariants: b.applyToVariants === true,
        printerConfigId,
        originalName,
        fileType: ext,
        sizeBytes: realSize, // istemci beyanı değil, R2'nin doğruladığı gerçek boyut
        label: b.label != null && String(b.label).trim() !== "" ? String(b.label).trim() : null,
        gramaj: b.gramaj != null ? Number(b.gramaj) : null,
        estPrintMin: b.estPrintMin != null ? Math.round(Number(b.estPrintMin)) : null,
        r2Key,
        storedPath: "",
      });
      return NextResponse.json(mine, { status: 201 });
    }

    // ── YEREL (R2 kapalı / fallback): multipart upload → diske yaz ──
    const form = await req.formData();
    const file = form.get("file");
    const printerConfigId = String(form.get("printerConfigId") || "");
    const labelRaw = form.get("label");
    const gramajRaw = form.get("gramaj");
    const estRaw = form.get("estPrintMin");
    const applyToVariants = String(form.get("applyToVariants") || "") === "true";

    if (!(file instanceof File)) return NextResponse.json({ error: "Dosya gerekli" }, { status: 400 });
    if (!printerConfigId) return NextResponse.json({ error: "Yazıcı seçilmedi" }, { status: 400 });

    const ext = (file.name.split(".").pop() || "gcode").toLowerCase();
    if (!ALLOWED.includes(ext)) {
      return NextResponse.json({ error: `Desteklenmeyen tür: .${ext} (gcode / 3mf)` }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const dir = getModelsDir();
    const storedPath = path.join(dir, `${crypto.randomUUID()}.${ext}`);
    await fs.promises.writeFile(storedPath, buf); // sync yazma büyük dosyada ana süreci donduruyordu

    // Meta'yı YÜKLEMEDE bir kez parse et + sakla → renk-eşleme/baskı dosyayı yeniden açmaz.
    let colorsJson: string | null = null;
    let sliced: boolean | null = null;
    try {
      colorsJson = JSON.stringify(readModelColors(storedPath));
      sliced = ext === "3mf" ? is3mfSliced(storedPath) : true;
    } catch { /* parse edilemezse eski (lazy) yol devrede kalır */ }

    const mine = await createModelRows({
      productId: id,
      applyToVariants,
      printerConfigId,
      originalName: file.name,
      fileType: ext,
      sizeBytes: buf.length,
      label: labelRaw != null && String(labelRaw).trim() !== "" ? String(labelRaw).trim() : null,
      gramaj: gramajRaw != null && String(gramajRaw).trim() !== "" ? Number(gramajRaw) : null,
      estPrintMin: estRaw != null && String(estRaw).trim() !== "" ? Math.round(Number(estRaw)) : null,
      storedPath,
      colorsJson,
      sliced,
    });
    return NextResponse.json(mine, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
