import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { moonrakerStorage, moonrakerDeleteFiles, fetchMoonrakerStatus } from "@/core/printers/moonraker";
import { bambuStorageList, bambuDeleteFiles, getBambuStatus, mapBambuState } from "@/core/printers/bambu";

export const dynamic = "force-dynamic";

/** Yol/uzantı at, küçült — basılan dosyayı silme listesiyle birebir kıyaslamak için. */
function norm(s: string): string {
  return s.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "").toLowerCase().trim();
}

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

    // GÜVENLİK: basılmakta olan dosya ASLA silinmez (UI atlansa/eski istemci olsa bile) — silmek
    // baskıyı yarıda kesebilir. Aktif işi yazıcıdan sorup silme listesinden düş.
    let deleted = 0;
    let blockedActive = false;
    if (cfg.type === "bambu") {
      if (!cfg.accessCode) return NextResponse.json({ error: "Access code eksik" }, { status: 400 });
      const s = await getBambuStatus(cfg.host, cfg.accessCode, cfg.serial ?? "").catch(() => null);
      const st = s ? mapBambuState(s.gcodeState) : null;
      const active = s && (st === "printing" || st === "paused") ? norm(s.filename ?? "") : "";
      const safe = active ? names.filter((n) => norm(n) !== active) : names;
      blockedActive = safe.length !== names.length;
      deleted = safe.length ? await bambuDeleteFiles(cfg.host, cfg.accessCode, safe) : 0;
    } else {
      const s = await fetchMoonrakerStatus(cfg.host, cfg.port).catch(() => null);
      const active = s && (s.state === "printing" || s.state === "paused") ? norm(s.filename ?? "") : "";
      const safe = active ? names.filter((n) => norm(n) !== active) : names;
      blockedActive = safe.length !== names.length;
      deleted = safe.length ? await moonrakerDeleteFiles(cfg.host, cfg.port, safe) : 0;
    }
    return NextResponse.json({ ok: true, deleted, blockedActive });
  } catch (error) {
    return jsonError(error);
  }
}
