import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { getModelsDir } from "@/lib/storage";
import { createModelRows } from "@/lib/model-files";

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
      const mine = await createModelRows({
        productId: id,
        applyToVariants: b.applyToVariants === true,
        printerConfigId,
        originalName,
        fileType: ext,
        sizeBytes: Number(b.sizeBytes) || 0,
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
    fs.writeFileSync(storedPath, buf);

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
    });
    return NextResponse.json(mine, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
