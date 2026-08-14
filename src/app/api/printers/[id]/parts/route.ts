import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { fetchMoonrakerObjects } from "@/core/printers/moonraker";

export const dynamic = "force-dynamic";

/**
 * Tabladaki parçalar — ad, merkez ve tepeden görünüş poligonu (tabla mm).
 *
 * AYRI bir uçtur çünkü yanıt ~3,8 KB ve %96'sı poligonlardan ibaret; 5 saniyelik panel
 * yoklamasına bindirilemez. Baskı boyunca değişmediği için yalnız seçici diyalog açılırken
 * bir kez çekilir.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const cfg = await prisma.printerConfig.findUnique({
      where: { id },
      select: { host: true, port: true, type: true, brand: true },
    });
    if (!cfg?.host) return NextResponse.json({ parts: [] });
    // Parça iptali YALNIZ Klipper/Moonraker yazıcılarda var; Bambu kapsam dışı.
    if (cfg.type === "bambu" || cfg.brand === "bambu") return NextResponse.json({ parts: [] });

    return NextResponse.json({ parts: await fetchMoonrakerObjects(cfg.host, cfg.port ?? 7125) });
  } catch (error) {
    return jsonError(error);
  }
}
