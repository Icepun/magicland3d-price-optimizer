import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { moonrakerTimelapseList } from "@/core/printers/moonraker";
import { bambuTimelapseList } from "@/core/printers/bambu";
import { getBambuStatusCached, getMoonrakerStatusCached } from "@/core/printers/status-cache";

export const dynamic = "force-dynamic";

export interface TimelapseItem {
  name: string;
  size: number;
  /** epoch ms (bilinmiyorsa null). */
  modified: number | null;
  /** Tarayıcıda gömülü oynatılabilir mi? Bambu .avi üretir → tarayıcı oynatamaz, yalnız indirilir. */
  playable: boolean;
  /** Oynatma/indirme kaynağı. Moonraker: yazıcıya DOĞRUDAN URL (Range destekli → seek çalışır).
   *  Bambu: uygulamamız üzerinden proxy (FTPS ile çekilir). */
  url: string;
  thumbUrl: string | null;
}

/**
 * Yazıcıdaki timelapse videoları.
 *  - Moonraker (Snapmaker U1): `camera` kökü — U1'de standart timelapse bileşeni yok, Snapmaker
 *    videoyu oraya yazıyor (canlı olarak doğrulandı). .mp4 → gömülü oynatılır.
 *  - Bambu: FTP kökündeki `timelapse` klasörü. .avi → yalnız indirilir.
 * Yazıcı ÇEVRİMDIŞIYSA cihazı yoklamadan boş liste döner (panel beklemesin).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const cfg = await prisma.printerConfig.findUnique({ where: { id } });
    if (!cfg) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });

    if (cfg.type === "bambu") {
      if (!cfg.accessCode || !cfg.serial) return NextResponse.json({ items: [], offline: true });
      const st = await getBambuStatusCached(cfg.host, cfg.accessCode, cfg.serial);
      if (!st.online) return NextResponse.json({ items: [], offline: true });
      const rows = await bambuTimelapseList(cfg.host, cfg.accessCode);
      const items: TimelapseItem[] = rows.map((r) => ({
        name: r.name,
        size: r.size,
        // Ad zaman damgası taşıyor: video_2026-02-10_18-33-42.avi → güvenilir tarih kaynağı
        // (FTP LIST tarihi yıl içermiyor).
        modified: parseNameTimestamp(r.name),
        playable: false, // .avi — tarayıcı oynatamaz
        url: `/api/printers/${id}/timelapse/download?name=${encodeURIComponent(r.name)}`,
        thumbUrl: null,
      }));
      return NextResponse.json({ items, offline: false });
    }

    const st = await getMoonrakerStatusCached(cfg.host, cfg.port);
    if (!st.online) return NextResponse.json({ items: [], offline: true });
    const rows = await moonrakerTimelapseList(cfg.host, cfg.port);
    const items: TimelapseItem[] = rows.map((r) => ({
      name: r.name,
      size: r.size,
      modified: r.modified != null ? r.modified * 1000 : parseNameTimestamp(r.name),
      playable: /\.(mp4|webm)$/i.test(r.name),
      url: r.url, // doğrudan yazıcıdan — Range destekli, seek çalışır
      thumbUrl: r.thumbUrl,
    }));
    return NextResponse.json({ items, offline: false });
  } catch (error) {
    return jsonError(error);
  }
}

/** Dosya adındaki zaman damgasını epoch ms'ye çevir.
 *  Bambu: video_2026-02-10_18-33-42.avi · Snapmaker: ..._20260728040934.mp4 */
function parseNameTimestamp(name: string): number | null {
  const a = /(\d{4})-(\d{2})-(\d{2})[_-](\d{2})-(\d{2})-(\d{2})/.exec(name);
  if (a) {
    const t = Date.parse(`${a[1]}-${a[2]}-${a[3]}T${a[4]}:${a[5]}:${a[6]}`);
    return Number.isFinite(t) ? t : null;
  }
  const b = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name);
  if (b) {
    const t = Date.parse(`${b[1]}-${b[2]}-${b[3]}T${b[4]}:${b[5]}:${b[6]}`);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}
