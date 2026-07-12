import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

/**
 * İstemcide üretilen (gcode-render) önizleme görselini kaydet — yalnız kayıtta görsel YOKSA.
 * Dilimleyicinin gömdüğü görsel varsa o korunur (daha zengin gölgeli); bu rota dilimleyicisi
 * görsel gömmeyen dosyaların (örn. bazı profiller) boşluğunu doldurur.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { thumbnail?: unknown };
    const thumb = typeof body.thumbnail === "string" ? body.thumbnail : "";
    if (!/^data:image\/(png|webp|jpeg);base64,/.test(thumb) || thumb.length > 1_000_000) {
      return NextResponse.json({ error: "Geçersiz görsel" }, { status: 400 });
    }
    const mf = await prisma.productModelFile.findUnique({ where: { id }, select: { id: true, thumbnail: true } });
    if (!mf) return NextResponse.json({ error: "Model dosyası bulunamadı" }, { status: 404 });
    if (mf.thumbnail) return NextResponse.json({ ok: true, kept: true }); // mevcut görsel korunur

    await prisma.productModelFile.update({ where: { id }, data: { thumbnail: thumb } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
