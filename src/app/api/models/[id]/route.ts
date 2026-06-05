import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { getR2Config, deleteObject } from "@/lib/r2";

const PatchSchema = z.object({
  label: z.string().trim().max(80).nullable().optional(),
  gramaj: z.coerce.number().min(0).nullable().optional(),
  estPrintMin: z.coerce.number().int().min(0).nullable().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const data = PatchSchema.parse(await req.json());
    const updated = await prisma.productModelFile.update({ where: { id }, data });
    return NextResponse.json(updated);
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    // ?allVariants=1 → "Tüm varyantlara uygula" AÇIKKEN silme: aynı dosyayı (ortak r2Key/storedPath)
    // paylaşan TÜM varyant satırlarını sil (kullanıcı kutucuk seçiliyken hepsinden gitsin bekliyor).
    const allVariants = new URL(req.url).searchParams.get("allVariants") === "1";
    const mf = await prisma.productModelFile.findUnique({ where: { id } });
    if (!mf) return NextResponse.json({ ok: true });

    if (allVariants && mf.r2Key) {
      await prisma.productModelFile.deleteMany({ where: { r2Key: mf.r2Key } });
    } else if (allVariants && mf.storedPath) {
      // storedPath="" R2 satırlarının ortak değeri → onunla deleteMany YAPMA (yalnız gerçek yerel yol).
      await prisma.productModelFile.deleteMany({ where: { storedPath: mf.storedPath } });
    } else {
      await prisma.productModelFile.delete({ where: { id } });
    }

    // Dosyayı (R2 objesi / disk) YALNIZCA hiç referans kalmayınca sil.
    if (mf.r2Key) {
      const stillUsed = await prisma.productModelFile.count({ where: { r2Key: mf.r2Key } });
      if (stillUsed === 0) {
        const cfg = await getR2Config();
        if (cfg) {
          try { await deleteObject(mf.r2Key, cfg); } catch { /* R2 silme kritik değil */ }
        }
      }
    } else if (mf.storedPath) {
      const stillUsed = await prisma.productModelFile.count({ where: { storedPath: mf.storedPath } });
      if (stillUsed === 0) {
        try { fs.unlinkSync(mf.storedPath); } catch { /* yoksa boşver */ }
      }
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
