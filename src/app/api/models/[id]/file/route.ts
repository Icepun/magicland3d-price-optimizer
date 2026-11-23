import { NextResponse } from "next/server";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { getR2Config, getObjectBytes } from "@/lib/r2";

export const dynamic = "force-dynamic";

/**
 * Model dosyasının ham baytları — istemcideki gcode görselleştirici (Web Worker parser) için.
 * Yerel dosya varsa diskten, yoksa R2'den okunur. Yanıt localhost içinde kalır.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const mf = await prisma.productModelFile.findUnique({ where: { id } });
    if (!mf) return NextResponse.json({ error: "Model dosyası bulunamadı" }, { status: 404 });

    let buf: Buffer | null = null;
    if (!mf.r2Key && fs.existsSync(mf.storedPath)) {
      buf = await fs.promises.readFile(mf.storedPath);
    } else if (mf.r2Key) {
      const cfg = await getR2Config();
      if (!cfg) return NextResponse.json({ error: "Bulut depolama ayarlı değil" }, { status: 400 });
      buf = await getObjectBytes(mf.r2Key, cfg);
    }
    if (!buf) return NextResponse.json({ error: "Dosya bu cihazda yok" }, { status: 404 });

    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(buf.length),
        "Cache-Control": "no-store",
        "X-File-Name": encodeURIComponent(mf.originalName),
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
