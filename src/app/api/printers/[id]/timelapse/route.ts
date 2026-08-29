import { NextRequest, NextResponse } from "next/server";
import { printerCfgCached } from "@/core/printers/config-cache";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { moonrakerTimelapseList, moonrakerTimelapseSil } from "@/core/printers/moonraker";
import { bambuTimelapseList, bambuTimelapseSil } from "@/core/printers/bambu";
import { getBambuStatusCached, getMoonrakerStatusCached } from "@/core/printers/status-cache";
import { gizlenenAdlar, gizliligiDegistir } from "@/core/printers/timelapse-hidden";

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
  /** Bu video yazıcıdan silinebilir mi? Snapmaker U1'in video klasörü salt-okunur → false. */
  canDelete: boolean;
  /** Kullanıcı listeden kaldırmış mı? Dosya yazıcıda durur, yalnız galeride gizlenir. */
  hidden?: boolean;
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
    // Kardeş uçların hepsi böyle okuyor (slots/storage/parts/plate-thumbnail/files).
    // Bu rota salt-okuma → kısa ömürlü önbellek güvenli.
    const cfg = await printerCfgCached<NonNullable<Awaited<ReturnType<typeof prisma.printerConfig.findUnique>>>>(id);
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
        playable: false, // .avi — tarayıcı AVI konteynerini oynatamaz (codec MJPG, ses yok)
        url: `/api/printers/${id}/timelapse/download?name=${encodeURIComponent(r.name)}`,
        // Bambu her videonun yanına /timelapse/thumbnail/<ad>.jpg yazıyor → indirmeden önizleme.
        thumbUrl: `/api/printers/${id}/timelapse/download?kind=thumb&name=${encodeURIComponent(r.name)}`,
        canDelete: true, // FTPS ile siliniyor
      }));
      return NextResponse.json({ items, offline: false });
    }

    const st = await getMoonrakerStatusCached(cfg.host, cfg.port);
    if (!st.online) return NextResponse.json({ items: [], offline: true });
    const rows = await moonrakerTimelapseList(cfg.host, cfg.port);
    // Gizlenenler yalnız video varsa okunuyor — videosuz yazıcı için boşuna sorgu atmayalım.
    const gizli = rows.length ? await gizlenenAdlar(id) : new Set<string>();
    const items: TimelapseItem[] = rows.map((r) => ({
      name: r.name,
      size: r.size,
      modified: r.modified != null ? r.modified * 1000 : parseNameTimestamp(r.name),
      playable: /\.(mp4|webm)$/i.test(r.name),
      url: r.url, // doğrudan yazıcıdan — Range destekli, seek çalışır
      thumbUrl: r.thumbUrl,
      canDelete: r.deletable,
      hidden: gizli.has(r.name),
    }));
    return NextResponse.json({ items, offline: false });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Timelapse videosunu sil.
 *
 * GERİ ALINAMAZ: dosya yazıcının kendi deposundan silinir, çöp kutusu yok. Bu yüzden
 * arayüzde tek tıkla değil onayla siliniyor.
 *
 * Video adı gövdede gelir; yol geçişine izin verilmez (yalnız düz dosya adı).
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const cfg = await printerCfgCached<NonNullable<Awaited<ReturnType<typeof prisma.printerConfig.findUnique>>>>(id);
    if (!cfg) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });

    const govde = (await req.json().catch(() => ({}))) as { name?: unknown };
    const name = typeof govde.name === "string" ? govde.name.trim() : "";
    if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
      return NextResponse.json({ error: "Geçersiz dosya adı" }, { status: 400 });
    }

    if (cfg.type === "bambu") {
      if (!cfg.accessCode) return NextResponse.json({ error: "Erişim kodu girilmemiş" }, { status: 400 });
      const ok = await bambuTimelapseSil(cfg.host, cfg.accessCode, name);
      if (!ok) return NextResponse.json({ error: "Video silinemedi — yazıcı meşgul olabilir." }, { status: 502 });
      return NextResponse.json({ ok: true });
    }

    const r = await moonrakerTimelapseSil(cfg.host, cfg.port, name);
    if (!r.ok) return NextResponse.json({ error: r.neden ?? "Video silinemedi" }, { status: 502 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Videoyu listeden kaldır / geri getir.
 *
 * Snapmaker U1 videoların silinmesine izin vermiyor (video klasörü salt-okunur). Kullanıcı
 * yine de gereksiz videoları gözünün önünden kaldırabilsin diye galeride gizleniyor —
 * dosya yazıcıda kalır, işlem her zaman geri alınabilir.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const govde = (await req.json().catch(() => ({}))) as { name?: unknown; hidden?: unknown };
    const name = typeof govde.name === "string" ? govde.name.trim() : "";
    if (!name) return NextResponse.json({ error: "Geçersiz dosya adı" }, { status: 400 });
    await gizliligiDegistir(id, name, govde.hidden !== false);
    return NextResponse.json({ ok: true });
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
