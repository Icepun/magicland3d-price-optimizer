import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { moonrakerStorage, moonrakerDeleteFiles } from "@/core/printers/moonraker";
import { bambuStorageList, bambuDeleteFiles } from "@/core/printers/bambu";

export const dynamic = "force-dynamic";

/**
 * Yazıcının YEREL depolaması: dosya listesi + kullanım.
 *  - Moonraker (Elegoo/Snapmaker): gcodes kökü + gerçek disk_usage (toplam/boş).
 *  - Bambu (FTP kökü = dahili eMMC): dosya listesi + toplam dosya boyutu (kapasite FTP'den okunamaz).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const cfg = await prisma.printerConfig.findUnique({ where: { id } });
    if (!cfg) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });

    if (cfg.type === "bambu") {
      if (!cfg.accessCode) return NextResponse.json({ error: "Access code eksik" }, { status: 400 });
      const files = await bambuStorageList(cfg.host, cfg.accessCode);
      const used = files.reduce((s, f) => s + f.size, 0);
      return NextResponse.json({ kind: "bambu", total: null, free: null, used, files });
    }

    const st = await moonrakerStorage(cfg.host, cfg.port);
    // used: disk_usage.used TÜM diski kapsar (sistem dahil) — bar için onu kullan; dosya listesi gcodes'tur.
    return NextResponse.json({ kind: "moonraker", total: st.total, free: st.free, used: st.used, files: st.files });
  } catch (error) {
    return jsonError(error);
  }
}

/** Seçilen dosyaları yazıcı depolamasından sil: body { files: string[] }. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const cfg = await prisma.printerConfig.findUnique({ where: { id } });
    if (!cfg) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as { files?: unknown };
    const names = Array.isArray(body.files)
      ? body.files.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, 200)
      : [];
    if (!names.length) return NextResponse.json({ error: "Silinecek dosya seçilmedi" }, { status: 400 });

    let deleted = 0;
    if (cfg.type === "bambu") {
      if (!cfg.accessCode) return NextResponse.json({ error: "Access code eksik" }, { status: 400 });
      deleted = await bambuDeleteFiles(cfg.host, cfg.accessCode, names);
    } else {
      deleted = await moonrakerDeleteFiles(cfg.host, cfg.port, names);
    }
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    return jsonError(error);
  }
}
