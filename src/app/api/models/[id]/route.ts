import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

const PatchSchema = z.object({
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
    if (mf?.storedPath) {
      try { fs.unlinkSync(mf.storedPath); } catch { /* yoksa boşver */ }
    }
    await prisma.productModelFile.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
