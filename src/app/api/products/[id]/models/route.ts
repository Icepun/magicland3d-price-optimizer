import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { getModelsDir } from "@/lib/storage";

export const dynamic = "force-dynamic";

const ALLOWED = ["gcode", "gco", "g", "3mf"];

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const files = await prisma.productModelFile.findMany({
      where: { productId: id },
      orderBy: { createdAt: "asc" },
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
    const form = await req.formData();
    const file = form.get("file");
    const printerConfigId = String(form.get("printerConfigId") || "");
    const gramajRaw = form.get("gramaj");
    const estRaw = form.get("estPrintMin");

    if (!(file instanceof File)) return NextResponse.json({ error: "Dosya gerekli" }, { status: 400 });
    if (!printerConfigId) return NextResponse.json({ error: "Yazıcı seçilmedi" }, { status: 400 });

    const ext = (file.name.split(".").pop() || "gcode").toLowerCase();
    if (!ALLOWED.includes(ext)) {
      return NextResponse.json({ error: `Desteklenmeyen tür: .${ext} (gcode / 3mf)` }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const dir = getModelsDir();

    // Aynı ürün+yazıcı için eski dosya varsa diskten temizle
    const existing = await prisma.productModelFile.findUnique({
      where: { productId_printerConfigId: { productId: id, printerConfigId } },
    });
    if (existing?.storedPath) {
      try { fs.unlinkSync(existing.storedPath); } catch { /* yoksa boşver */ }
    }

    const storedPath = path.join(dir, `${id}__${printerConfigId}.${ext}`);
    fs.writeFileSync(storedPath, buf);

    const gramaj = gramajRaw != null && String(gramajRaw).trim() !== "" ? Number(gramajRaw) : null;
    const estPrintMin = estRaw != null && String(estRaw).trim() !== "" ? Math.round(Number(estRaw)) : null;

    const saved = await prisma.productModelFile.upsert({
      where: { productId_printerConfigId: { productId: id, printerConfigId } },
      create: { productId: id, printerConfigId, originalName: file.name, storedPath, fileType: ext, sizeBytes: buf.length, gramaj, estPrintMin },
      update: { originalName: file.name, storedPath, fileType: ext, sizeBytes: buf.length, gramaj, estPrintMin },
    });
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
