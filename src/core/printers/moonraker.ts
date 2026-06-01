/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Moonraker (Klipper) HTTP adaptörü — Elegoo Neptune 4 Pro/Plus, Snapmaker U1.
 * Endpoint sözleşmesi Moonraker dokümanından doğrulandı:
 *   GET  /printer/info
 *   GET  /printer/objects/query?print_stats&virtual_sdcard=progress&display_status=progress&extruder=temperature,target&heater_bed=temperature,target
 *   POST /printer/print/{pause|resume|cancel}
 *   POST /printer/print/start?filename=...
 *   GET  /server/files/list?root=gcodes
 *   GET  /server/files/metadata?filename=...
 *   GET  /server/files/gcodes/<relative_path>   (thumbnail)
 * Yanıtlar { result: ... } ile sarılı gelir; defansif olarak result ?? gövde okunur.
 *
 * PORT FARKI (önemli): Elegoo Neptune 4 serisi Moonraker'ı nginx ARKASINDAN **port 80**'de
 * sunar (Fluidd de 80'de). Snapmaker U1 / standart Klipper ise **7125**'te. Bu yüzden
 * yapılandırılan port çalışmazsa otomatik olarak 80 ve 7125 denenir; çalışan port host
 * bazında önbelleğe alınır (sonraki isteklerde doğrudan kullanılır).
 */

export type MoonrakerState =
  | "standby"
  | "printing"
  | "paused"
  | "complete"
  | "cancelled"
  | "error";

export interface MoonrakerStatus {
  online: boolean;
  state: MoonrakerState;
  filename: string | null;
  progress: number; // 0..1
  printDurationSec: number;
  currentLayer: number | null;
  totalLayer: number | null;
  zHeight: number | null; // gcode_move.gcode_position[2] — layer tahmini için
  nozzle: number;
  nozzleTarget: number;
  bed: number;
  bedTarget: number;
}

export interface MoonrakerMeta {
  estimatedTimeSec: number | null;
  thumbnailRelPath: string | null;
  filamentType: string | null;
  totalLayer: number | null;
  layerHeight: number | null;
  firstLayerHeight: number | null;
}

export interface MoonrakerFile {
  path: string;
  modified: number;
  size: number;
}

const QUERY =
  "print_stats&virtual_sdcard=progress&display_status=progress&extruder=temperature,target&heater_bed=temperature,target&gcode_move=gcode_position";

/** host → çalışan Moonraker portu (runtime önbelleği). */
const portCache = new Map<string, number>();

function candidatePorts(configured: number): number[] {
  return [...new Set([configured, 80, 7125].filter((p) => Number.isFinite(p) && p > 0))];
}

/** Önbellekteki çalışan port (yoksa yapılandırılan) ile temel URL. */
export function moonrakerBase(host: string, port: number): string {
  const p = portCache.get(host) ?? port ?? 7125;
  return `http://${host}:${p}`;
}

async function mfetch(url: string, init: RequestInit | undefined, timeoutMs: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
  } finally {
    clearTimeout(t);
  }
}

function unwrap(json: any): any {
  return json && typeof json === "object" && "result" in json ? json.result : json;
}

function parseStatus(status: any): MoonrakerStatus {
  const ps = status.print_stats ?? {};
  const vs = status.virtual_sdcard ?? {};
  const ds = status.display_status ?? {};
  const ex = status.extruder ?? {};
  const hb = status.heater_bed ?? {};
  const gm = status.gcode_move ?? {};
  const progress = Math.min(1, Math.max(0,
    typeof vs.progress === "number" ? vs.progress
      : typeof ds.progress === "number" ? ds.progress
        : 0));
  const zPos = Array.isArray(gm.gcode_position) && typeof gm.gcode_position[2] === "number" ? gm.gcode_position[2] : null;
  return {
    online: true,
    state: (ps.state as MoonrakerState) || "standby",
    filename: ps.filename || null,
    progress,
    printDurationSec: typeof ps.print_duration === "number" ? ps.print_duration : 0,
    currentLayer: typeof ps.info?.current_layer === "number" ? ps.info.current_layer : null,
    totalLayer: typeof ps.info?.total_layer === "number" ? ps.info.total_layer : null,
    zHeight: zPos,
    nozzle: Math.round(ex.temperature ?? 0),
    nozzleTarget: Math.round(ex.target ?? 0),
    bed: Math.round(hb.temperature ?? 0),
    bedTarget: Math.round(hb.target ?? 0),
  };
}

async function tryStatusAt(host: string, port: number): Promise<MoonrakerStatus | null> {
  try {
    const res = await mfetch(`http://${host}:${port}/printer/objects/query?${QUERY}`, undefined, 3500);
    if (!res.ok) return null;
    const status = unwrap(await res.json())?.status;
    if (!status) return null;
    return parseStatus(status);
  } catch {
    return null;
  }
}

export async function fetchMoonrakerStatus(host: string, port: number): Promise<MoonrakerStatus> {
  const offline: MoonrakerStatus = {
    online: false, state: "standby", filename: null, progress: 0, printDurationSec: 0,
    currentLayer: null, totalLayer: null, zHeight: null, nozzle: 0, nozzleTarget: 0, bed: 0, bedTarget: 0,
  };
  const cached = portCache.get(host);
  const order = cached != null
    ? [cached, ...candidatePorts(port).filter((p) => p !== cached)]
    : candidatePorts(port);
  for (const p of order) {
    const st = await tryStatusAt(host, p);
    if (st) {
      portCache.set(host, p);
      return st;
    }
  }
  return offline;
}

export async function fetchMoonrakerMeta(host: string, port: number, filename: string): Promise<MoonrakerMeta | null> {
  try {
    const res = await mfetch(
      `${moonrakerBase(host, port)}/server/files/metadata?filename=${encodeURIComponent(filename)}`,
      undefined,
      3000
    );
    if (!res.ok) return null;
    const r = unwrap(await res.json());
    if (!r) return null;
    const thumbs = Array.isArray(r.thumbnails) ? [...r.thumbnails] : [];
    thumbs.sort((a: any, b: any) => (b.width * b.height) - (a.width * a.height));
    return {
      estimatedTimeSec: typeof r.estimated_time === "number" ? r.estimated_time : null,
      thumbnailRelPath: thumbs[0]?.relative_path ?? null,
      filamentType: r.filament_type ?? null,
      totalLayer: typeof r.layer_count === "number" ? r.layer_count : null,
      layerHeight: typeof r.layer_height === "number" ? r.layer_height : null,
      firstLayerHeight: typeof r.first_layer_height === "number" ? r.first_layer_height : null,
    };
  } catch {
    return null;
  }
}

/** Thumbnail relative_path metadata'da gcode dosyasının klasörüne görelidir. */
export function moonrakerThumbUrl(host: string, port: number, filename: string, relPath: string): string {
  const dir = filename.includes("/") ? filename.slice(0, filename.lastIndexOf("/")) : "";
  const full = dir ? `${dir}/${relPath}` : relPath;
  const encoded = full.split("/").map(encodeURIComponent).join("/");
  return `${moonrakerBase(host, port)}/server/files/gcodes/${encoded}`;
}

export async function moonrakerControl(host: string, port: number, action: "pause" | "resume" | "cancel"): Promise<void> {
  const res = await mfetch(`${moonrakerBase(host, port)}/printer/print/${action}`, { method: "POST" }, 6000);
  if (!res.ok) throw new Error(`Yazıcı komutu başarısız (HTTP ${res.status})`);
}

export async function moonrakerStart(host: string, port: number, filename: string): Promise<void> {
  const res = await mfetch(
    `${moonrakerBase(host, port)}/printer/print/start?filename=${encodeURIComponent(filename)}`,
    { method: "POST" },
    8000
  );
  if (!res.ok) throw new Error(`Baskı başlatılamadı (HTTP ${res.status})`);
}

/** Dosyayı yazıcıya yükle ve hemen baskıyı başlat (Moonraker upload print=true). */
export async function moonrakerUploadAndPrint(host: string, port: number, fileBuf: Buffer, filename: string): Promise<void> {
  const fd = new FormData();
  fd.append("root", "gcodes");
  fd.append("print", "true");
  fd.append("file", new Blob([new Uint8Array(fileBuf)]), filename);
  // Büyük gcode dosyaları için uzun timeout (LAN içi).
  const res = await mfetch(`${moonrakerBase(host, port)}/server/files/upload`, { method: "POST", body: fd }, 180000);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Yükleme/baskı başarısız (HTTP ${res.status}) ${t.slice(0, 140)}`.trim());
  }
}

export async function moonrakerFiles(host: string, port: number): Promise<MoonrakerFile[]> {
  const res = await mfetch(`${moonrakerBase(host, port)}/server/files/list?root=gcodes`, undefined, 6000);
  if (!res.ok) throw new Error(`Dosya listesi alınamadı (HTTP ${res.status})`);
  const arr = unwrap(await res.json());
  return (Array.isArray(arr) ? arr : []).map((f: any) => ({
    path: String(f.path ?? ""),
    modified: Number(f.modified) || 0,
    size: Number(f.size) || 0,
  }));
}

/** Kaydetmeden önce bağlantı testi — çalışan portu da döndürür (UI port alanını günceller). */
function normalizeHex(c: unknown): string {
  if (typeof c === "string") {
    const h = c.startsWith("#") ? c.slice(1) : c;
    if (/^[0-9a-fA-F]{6,8}$/.test(h)) return `#${h.slice(0, 6)}`;
  }
  return "#9ca3af";
}

/**
 * Snapmaker U1 (CFS) renkli slotları — DEFANSİF. Moonraker objelerini keşfedip
 * filament/cfs/rfid içerenleri sorgular, renk/materyal alanlarını esnek okur.
 * Çözemezse [] döner (UI "renkler okunamadı" der, baskı yine de başlar — gcode'da gömülü).
 */
export async function fetchMoonrakerSlots(host: string, port: number): Promise<{ slot: number; color: string; type: string }[]> {
  try {
    const listRes = await mfetch(`${moonrakerBase(host, port)}/printer/objects/list`, undefined, 4000);
    if (!listRes.ok) return [];
    const objs: string[] = unwrap(await listRes.json())?.objects ?? [];
    const cand = objs.filter((o) => /filament|cfs|rfid|spool|tray|ams/i.test(o)).slice(0, 16);
    if (!cand.length) return [];
    const q = cand.map((o) => `${encodeURIComponent(o)}`).join("&");
    const res = await mfetch(`${moonrakerBase(host, port)}/printer/objects/query?${q}`, undefined, 4000);
    if (!res.ok) return [];
    const status = unwrap(await res.json())?.status ?? {};
    const slots: { slot: number; color: string; type: string }[] = [];
    let i = 0;
    for (const val of Object.values(status)) {
      const v = (val ?? {}) as Record<string, unknown>;
      const rfid = (v.rfid ?? {}) as Record<string, unknown>;
      const color = v.color ?? v.colour ?? v.hex ?? v.rgb ?? rfid.color ?? rfid.colour;
      const type = v.material ?? v.type ?? v.filament_type ?? rfid.material;
      if (color != null || type != null) {
        slots.push({ slot: i, color: normalizeHex(color), type: typeof type === "string" ? type : "" });
      }
      i++;
    }
    return slots;
  } catch {
    return [];
  }
}

export async function testMoonraker(host: string, port: number): Promise<{ ok: boolean; hostname?: string; state?: string; port?: number; error?: string }> {
  let lastErr = "";
  for (const p of candidatePorts(port)) {
    try {
      const res = await mfetch(`http://${host}:${p}/printer/info`, undefined, 4000);
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
      const r = unwrap(await res.json());
      portCache.set(host, p);
      return { ok: true, hostname: r?.hostname, state: r?.state, port: p };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : "bağlanılamadı";
    }
  }
  return { ok: false, error: lastErr || "bağlanılamadı" };
}
