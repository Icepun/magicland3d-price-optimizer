import { NextRequest, NextResponse } from "next/server";
import { printerCfgCached } from "@/core/printers/config-cache";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { moonrakerFiles } from "@/core/printers/moonraker";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    // Panel bu ucu 5 sn'de bir çağırıyor; yapılandırma neredeyse hiç değişmiyor →
    // kısa ömürlü önbellek (ayar kaydedilince temizlenir).
    const cfg = await printerCfgCached<NonNullable<Awaited<ReturnType<typeof prisma.printerConfig.findUnique>>>>(id);
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
