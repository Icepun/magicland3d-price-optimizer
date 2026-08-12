import { NextResponse } from "next/server";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { getVizPack } from "@/lib/gcode-viz/pack-server";

export const dynamic = "force-dynamic";

/**
 * Model dosyasının kompakt görselleştirme paketi (viz-pack).
 * Ham gcode (178 MB'a kadar) yerine birkaç MB'lık ikili paket döner; paket bir kez üretilip
 * diske yazılır. İstemci bunu çözüp 3B görünümü kurar.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const pack = await getVizPack(id);
    return new Response(new Uint8Array(pack.bytes), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(pack.bytes.byteLength),
        "Cache-Control": "no-store",
        "X-Viz-Cache": pack.fromCache ? "hit" : "miss",
      },
    });
  } catch (error) {
    if (error instanceof Error && /bulunamadı|bu cihazda yok/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return jsonError(error);
  }
}
