import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { moonrakerFiles } from "@/core/printers/moonraker";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const cfg = await prisma.printerConfig.findUnique({ where: { id } });
    if (!cfg) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });
    if (cfg.type !== "moonraker") {
      return NextResponse.json({ error: "Bu yazıcı tipi için dosya listesi yok" }, { status: 400 });
    }
    const files = await moonrakerFiles(cfg.host, cfg.port);
    files.sort((a, b) => b.modified - a.modified);
    return NextResponse.json({ files });
  } catch (error) {
    return jsonError(error);
  }
}
