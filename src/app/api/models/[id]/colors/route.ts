import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { readModelColors } from "@/core/printers/model-colors";
import { resolveModelFileLocal } from "@/lib/model-files";

export const dynamic = "force-dynamic";

/**
 * Bir model dosyasının (gcode/3mf) baskıda kullandığı filament renkleri.
 * Çok renkli baskı öncesi "hangi renk hangi slota" eşlemesi için — renkler DOSYADAN okunur.
 * R2'deki dosya buluttan geçici dosyaya çekilip okunur (resolveModelFileLocal).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params; // ProductModelFile id
    const mf = await prisma.productModelFile.findUnique({ where: { id } });
    if (!mf) return NextResponse.json({ error: "Model dosyası bulunamadı" }, { status: 404 });

    let local;
    try {
      local = await resolveModelFileLocal(mf);
    } catch {
      return NextResponse.json({
        colors: [], source: "none", fileKind: "other", missing: true, originalName: mf.originalName,
      });
    }
    try {
      const info = readModelColors(local.path);
      return NextResponse.json({ ...info, originalName: mf.originalName });
    } finally {
      local.cleanup();
    }
  } catch (error) {
    return jsonError(error);
  }
}
