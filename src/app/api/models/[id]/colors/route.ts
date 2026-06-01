import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { readModelColors } from "@/core/printers/model-colors";

export const dynamic = "force-dynamic";

/**
 * Bir model dosyasının (gcode/3mf) baskıda kullandığı filament renkleri.
 * Çok renkli baskı öncesi "hangi renk hangi slota" eşlemesi için — renkler
 * DOSYADAN okunur (kullanıcı elle renk sayısı girmez).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params; // ProductModelFile id
    const mf = await prisma.productModelFile.findUnique({ where: { id } });
    if (!mf) return NextResponse.json({ error: "Model dosyası bulunamadı" }, { status: 404 });

    if (!fs.existsSync(mf.storedPath)) {
      return NextResponse.json({
        colors: [], source: "none", fileKind: "other", missing: true, originalName: mf.originalName,
      });
    }

    const info = readModelColors(mf.storedPath);
    return NextResponse.json({ ...info, originalName: mf.originalName });
  } catch (error) {
    return jsonError(error);
  }
}
