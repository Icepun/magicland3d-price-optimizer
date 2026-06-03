import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

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

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const mf = await prisma.productModelFile.findUnique({ where: { id } });
    await prisma.productModelFile.delete({ where: { id } });
    // Disk dosyasını YALNIZCA son referans gidince sil. "Tüm varyantlara uygula" ile aynı
    // storedPath birden çok satırda paylaşılıyor olabilir → bir varyantın satırını silmek
    // ortak dosyayı silmemeli (diğer varyantlar hâlâ basabilmeli).
    if (mf?.storedPath) {
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
