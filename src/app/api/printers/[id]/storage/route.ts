import { NextRequest, NextResponse } from "next/server";
import { printerCfgCached } from "@/core/printers/config-cache";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { moonrakerStorage, moonrakerDeleteFiles, fetchMoonrakerStatus } from "@/core/printers/moonraker";
import {
  bambuStorageSummary,
  bambuDeleteFiles,
  bambuDeleteIpcam,
  getBambuStatus,
  mapBambuState,
  type BambuStorageSummary,
} from "@/core/printers/bambu";
import { processSingleton } from "@/core/printers/process-singleton";

export const dynamic = "force-dynamic";

/** Basılan dosyayı silme listesindeki adla TOLERANSLI kıyasla: yol, içerik-hash eki (-<10hex>),
 *  dilimleyici plate eki (_plate_N), bilinen uzantı(lar) atılır. Bambu /cache'te dosyalar
 *  "Ad_plate_1.gcode" gibi işlenmiş adla durur; basılan işin subtask_name'i eksiz "Ad"dır. */
function norm(s: string): string {
  let x = s.replace(/^.*[/\\]/, "").toLowerCase().trim();
  x = x.replace(/-[0-9a-f]{10}(?=(\.(gcode|gco|g|3mf))*$)/i, ""); // içerik-hash eki
  x = x.replace(/(\.(gcode|gco|g|3mf))+$/i, "");                   // uzantı(lar)
  x = x.replace(/_plate_\d+$/i, "");                               // dilimleyici plate eki
  return x.trim();
}

/** Kart boyutu (GB) — kullanıcı girer; yazıcı bunu hiçbir yoldan bildirmiyor. */
const kapasiteAnahtari = (id: string) => `printerStorageCapacity:${id}`;

async function kapasiteGb(id: string): Promise<number | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: kapasiteAnahtari(id) } });
  const gb = row ? Number(row.value) : NaN;
  return Number.isFinite(gb) && gb > 0 ? gb : null;
}

/**
 * Bambu kart dökümü 5 dakika önbellekte: tüm klasörleri listelemek ~5 sn sürüyor ve kart
 * içeriği dakikalar içinde değişmiyor. Silme sonrası düşürülür. (Süreç geneli — iki paket tek kopya.)
 */
const DOKUM_TTL_MS = 5 * 60_000;
const dokumOnbellek = processSingleton("bambuDepoDokumu", () => new Map<string, { at: number; veri: BambuStorageSummary }>());

async function bambuDokum(host: string, kod: string, taze = false): Promise<BambuStorageSummary> {
  const hit = dokumOnbellek.get(host);
  if (!taze && hit && Date.now() - hit.at < DOKUM_TTL_MS) return hit.veri;
  const veri = await bambuStorageSummary(host, kod);
  dokumOnbellek.set(host, { at: Date.now(), veri });
  return veri;
}

/** Klasörleri kullanıcının anlayacağı gruplara topla. */
function bambuBolumleri(veri: BambuStorageSummary) {
  const toplam = (adlar: string[]) =>
    veri.folders.filter((f) => adlar.includes(f.name)).reduce((s, f) => s + f.bytes, 0);
  const bilinen = ["/", "cache", "ipcam", "timelapse", "logger", "corelogger", "recorder"];
  const diger = veri.folders.filter((f) => !bilinen.includes(f.name)).reduce((s, f) => s + f.bytes, 0);
  return [
    { key: "files", label: "Baskı dosyaları", bytes: toplam(["/", "cache"]) },
    { key: "ipcam", label: "Kamera kayıtları", bytes: toplam(["ipcam"]) },
    { key: "timelapse", label: "Timelapse videoları", bytes: toplam(["timelapse"]) },
    { key: "system", label: "Yazıcının kendi kayıtları", bytes: toplam(["logger", "corelogger", "recorder"]) },
    { key: "other", label: "Diğer", bytes: diger },
  ].filter((b) => b.bytes > 0);
}

/**
 * Yazıcının YEREL depolaması: dosya listesi + kullanım.
 *  - Moonraker (Elegoo/Snapmaker): gcodes kökü + gerçek disk_usage (toplam/boş).
 *  - Bambu: kartın TAMAMI klasör klasör (baskı dosyaları, kamera kayıtları, timelapse, yazıcı
 *    günlükleri). Kapasite yazıcıdan okunamıyor → kullanıcının girdiği kart boyutu.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    // Panel bu ucu 5 sn'de bir çağırıyor; yapılandırma neredeyse hiç değişmiyor →
    // kısa ömürlü önbellek (ayar kaydedilince temizlenir).
    const cfg = await printerCfgCached<NonNullable<Awaited<ReturnType<typeof prisma.printerConfig.findUnique>>>>(id);
    if (!cfg) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });

    if (cfg.type === "bambu") {
      if (!cfg.accessCode) return NextResponse.json({ error: "Erişim kodu eksik" }, { status: 400 });
      const taze = req.nextUrl.searchParams.get("fresh") === "1";
      const [veri, gb] = await Promise.all([bambuDokum(cfg.host, cfg.accessCode, taze), kapasiteGb(id)]);
      const used = veri.folders.reduce((s, f) => s + f.bytes, 0);
      const total = gb ? Math.round(gb * 1e9) : null;
      return NextResponse.json({
        kind: "bambu",
        total,
        free: total != null ? Math.max(0, total - used) : null,
        used,
        files: veri.files,
        parts: bambuBolumleri(veri),
        capacityGb: gb,
        ipcam: {
          count: veri.ipcamFiles.length,
          bytes: veri.ipcamFiles.reduce((s, f) => s + f.size, 0),
        },
      });
    }

    const st = await moonrakerStorage(cfg.host, cfg.port);
    // used: disk_usage.used TÜM diski kapsar (sistem dahil) — bar için onu kullan; dosya listesi gcodes'tur.
    return NextResponse.json({ kind: "moonraker", total: st.total, free: st.free, used: st.used, files: st.files });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Kart boyutunu kaydet (yalnız Bambu): body { capacityGb: number | null }.
 * null/0 → ayar silinir (gösterge yine "kullanılan"a döner).
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { capacityGb?: unknown };
    const gb = Number(body.capacityGb);
    if (!Number.isFinite(gb) || gb <= 0) {
      await prisma.appSetting.deleteMany({ where: { key: kapasiteAnahtari(id) } });
      return NextResponse.json({ ok: true, capacityGb: null });
    }
    if (gb > 4096) return NextResponse.json({ error: "Kart boyutu çok büyük görünüyor." }, { status: 400 });
    await prisma.appSetting.upsert({
      where: { key: kapasiteAnahtari(id) },
      create: { key: kapasiteAnahtari(id), value: String(gb) },
      update: { value: String(gb) },
    });
    return NextResponse.json({ ok: true, capacityGb: gb });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Seçilen dosyaları yazıcı depolamasından sil: body { files: string[] }.
 * Bambu'da kamera kayıtları: body { ipcam: "all" } — sürmekte olan baskının kaydı korunur.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const cfg = await prisma.printerConfig.findUnique({ where: { id } });
    if (!cfg) return NextResponse.json({ error: "Yazıcı bulunamadı" }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as { files?: unknown; ipcam?: unknown };

    // ── Bambu kamera kayıtları (/ipcam) ──
    if (body.ipcam === "all") {
      if (cfg.type !== "bambu" || !cfg.accessCode) {
        return NextResponse.json({ error: "Bu yazıcıda kamera kaydı yok." }, { status: 400 });
      }
      const veri = await bambuDokum(cfg.host, cfg.accessCode, true);
      const s = await getBambuStatus(cfg.host, cfg.accessCode, cfg.serial ?? "").catch(() => null);
      const basiyor = !!s && ["printing", "paused"].includes(mapBambuState(s.gcodeState));
      // Baskı sürerken EN YENİ kayıt yazılıyor olabilir — ona dokunma.
      const silinecek = (basiyor ? veri.ipcamFiles.slice(1) : veri.ipcamFiles).map((f) => f.name);
      const deleted = await bambuDeleteIpcam(cfg.host, cfg.accessCode, silinecek);
      dokumOnbellek.delete(cfg.host);
      return NextResponse.json({ ok: true, deleted, keptActive: basiyor && veri.ipcamFiles.length > 0 });
    }

    const names = Array.isArray(body.files)
      ? body.files.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, 200)
      : [];
    if (!names.length) return NextResponse.json({ error: "Silinecek dosya seçilmedi" }, { status: 400 });

    // GÜVENLİK: basılmakta olan dosya ASLA silinmez (UI atlansa/eski istemci olsa bile) — silmek
    // baskıyı yarıda kesebilir. Aktif işi yazıcıdan sorup silme listesinden düş.
    let deleted = 0;
    let blockedActive = false;
    if (cfg.type === "bambu") {
      if (!cfg.accessCode) return NextResponse.json({ error: "Erişim kodu eksik" }, { status: 400 });
      const s = await getBambuStatus(cfg.host, cfg.accessCode, cfg.serial ?? "").catch(() => null);
      const st = s ? mapBambuState(s.gcodeState) : null;
      const active = s && (st === "printing" || st === "paused") ? norm(s.filename ?? "") : "";
      const safe = active ? names.filter((n) => norm(n) !== active) : names;
      blockedActive = safe.length !== names.length;
      deleted = safe.length ? await bambuDeleteFiles(cfg.host, cfg.accessCode, safe) : 0;
      dokumOnbellek.delete(cfg.host);
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
