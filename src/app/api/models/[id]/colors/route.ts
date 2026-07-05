import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { readModelColors } from "@/core/printers/model-colors";
import { resolveModelFileLocal } from "@/lib/model-files";

export const dynamic = "force-dynamic";

/**
 * Bir model dosyasının (gcode/3mf) baskıda kullandığı filament renkleri.
 * ÖNCE kalıcı meta (colorsJson — yüklemede parse edildi) → ANINDA döner; yoksa dosya BİR KEZ
 * açılır (R2'deyse indirilir), parse edilir ve sonuç kalıcılaştırılır → sonraki açılışlar anında.
 * (Eski davranış: SlotStep'in HER açılışı R2'den tüm dosyayı indirip yeniden parse ediyordu.)
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params; // ProductModelFile id
    const mf = await prisma.productModelFile.findUnique({ where: { id } });
    if (!mf) return NextResponse.json({ error: "Model dosyası bulunamadı" }, { status: 404 });

    // Hızlı yol: yüklemede/ilk açılışta saklanan sonuç.
    if (mf.colorsJson) {
      try {
        return NextResponse.json({ ...JSON.parse(mf.colorsJson), originalName: mf.originalName });
      } catch { /* bozuk JSON → dosyadan yeniden parse */ }
    }

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
      // Kalıcılaştır (fire-and-forget) → bir dahaki açılış dosyaya hiç dokunmaz.
      void prisma.productModelFile.update({ where: { id }, data: { colorsJson: JSON.stringify(info) } }).catch(() => {});
      return NextResponse.json({ ...info, originalName: mf.originalName });
    } finally {
      local.cleanup();
    }
  } catch (error) {
    return jsonError(error);
  }
}
