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
  "print_stats&virtual_sdcard=progress&display_status=progress&extruder=temperature,target&extruder1=temperature,target&extruder2=temperature,target&extruder3=temperature,target&toolhead=extruder&heater_bed=temperature,target&gcode_move=gcode_position";

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

/**
 * 3MF metadata'sındaki materyal dizgesi çok-kafalı baskıda kafa-başına birleşik gelir
 * ("PLA:PLA", "PLA;PETG;PLA"). Ayır → kırp → tekrarı kaldır. Hepsi aynıysa tek değer ("PLA"),
 * farklıysa "PLA · PETG". Boşsa null.
 */
function cleanFilamentType(s: unknown): string | null {
  if (typeof s !== "string" || !s.trim()) return null;
  const uniq = [...new Set(s.split(/[;:,/|]+/).map((p) => p.trim()).filter(Boolean))];
  return uniq.length ? uniq.join(" · ") : null;
}

function parseStatus(status: any): MoonrakerStatus {
  const ps = status.print_stats ?? {};
  const vs = status.virtual_sdcard ?? {};
  const ds = status.display_status ?? {};
  // Tool-changer (Snapmaker U1): AKTİF kafanın sıcaklığını göster. toolhead.extruder aktif
  // ekstruderin adını verir ("extruder", "extruder1"...). Boştaki kafa 0'ı göstermeyiz.
  const th = status.toolhead ?? {};
  const activeExName = typeof th.extruder === "string" && th.extruder ? th.extruder : "extruder";
  const ex =
    (status[activeExName] && typeof status[activeExName] === "object"
      ? status[activeExName]
      : status.extruder) ?? {};
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
    const res = await mfetch(`http://${host}:${port}/printer/objects/query?${QUERY}`, undefined, 2500);
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
      filamentType: cleanFilamentType(r.filament_type),
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

/**
 * Snapmaker U1 (tool-changer) gcode'unda tool/kafa + CFS kanal atamasını yeniden eşle.
 * toolMap[dilimleyici_filament_index] = fiziksel kafa (0-tabanlı). U1'de kafa i ↔ CFS kanalı i SABİT,
 * bu yüzden hem kafa hem besleme kanalı AYNI eşlemeyle değiştirilir — yoksa kafa değişir ama filament
 * eski kanaldan beslenir → seçilen kafa boş kalır → "filament anomaly / runout".
 * Değiştirilen satırlar:
 *   - `T<n>` tek başına (aktif kafa seçimi) + `M104/M109/M108 ... T<n>` (kafa sıcaklığı)
 *   - `USE_CHANNEL CHANNEL=<n>` (CFS besleme kanalı) — Snapmaker filament yükleme makrosu
 * G-hareketleri / `M106 P..` fan / yorumlar DOKUNULMAZ. Identity (i→i) ise metin aynen döner.
 * NOT: gcode başka bir kanal/extruder komutu kullanıyorsa (örn. M620/SM_ EXTRUDER=) buraya eklenecek —
 * gerçek U1 gcode'u görülünce doğrulanır.
 */
export function remapMoonrakerTools(text: string, toolMap: Record<number, number>): string {
  const keys = Object.keys(toolMap).map(Number);
  if (!keys.length || keys.every((k) => toolMap[k] === k)) return text; // identity → değişiklik yok
  return text.split("\n").map((line) => {
    const t = line.trimStart();
    // Tool seç / sıcaklık → T token'ını eşle
    if (/^T\d+\s*$/.test(t) || /^M(?:104|109|108)\b/.test(t)) {
      return line.replace(/\bT(\d+)\b/g, (m, d) => {
        const n = Number(d);
        return n in toolMap ? `T${toolMap[n]}` : m;
      });
    }
    // CFS besleme kanalı → CHANNEL=n eşle (kafa ile aynı eşleme; head i ↔ channel i)
    if (/^USE_CHANNEL\b/i.test(t)) {
      return line.replace(/\bCHANNEL\s*=\s*(\d+)/i, (m, d) => {
        const n = Number(d);
        return n in toolMap ? `CHANNEL=${toolMap[n]}` : m;
      });
    }
    return line;
  }).join("\n");
}

export interface MoonrakerPrefs { timelapse?: boolean; bedLeveling?: boolean; flowCali?: boolean }

/** POST /printer/gcode/script — keyfi komut (Snapmaker gelişmiş başlatma için). */
async function moonrakerGcodeScript(host: string, port: number, script: string): Promise<void> {
  const res = await mfetch(
    `${moonrakerBase(host, port)}/printer/gcode/script?script=${encodeURIComponent(script)}`,
    { method: "POST" },
    30000
  );
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Baskı başlatılamadı (HTTP ${res.status}) ${t.slice(0, 180)}`.trim());
  }
}

/** Ham Moonraker metadata — Snapmaker WITH_PARAMETERS alanları için. Yükleme sonrası tarama
 *  gecikebilir → filament_type gelene kadar kısa poll. */
async function moonrakerRawMeta(host: string, port: number, filename: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 8; i++) {
    try {
      const res = await mfetch(
        `${moonrakerBase(host, port)}/server/files/metadata?filename=${encodeURIComponent(filename)}`,
        undefined, 6000
      );
      if (res.ok) {
        const m = unwrap(await res.json());
        if (m && typeof m === "object" && ((m as any).filament_type != null || i >= 4)) return m as Record<string, unknown>;
      }
    } catch { /* tekrar dene */ }
    await new Promise((r) => setTimeout(r, 700));
  }
  return {};
}

/** Yedek: gcode başlığından `; filament_type = PLA;PLA` çek (metadata taraması yetişmezse). */
function filamentTypeFromGcode(buf: Buffer): string | null {
  const head = buf.subarray(0, 4096).toString("latin1");
  const tail = buf.subarray(Math.max(0, buf.length - 8192)).toString("latin1");
  const re = /^;\s*filament_type\s*=\s*(.+)$/im;
  const m = re.exec(head) || re.exec(tail);
  return m ? m[1].trim() : null;
}

const SM_META_FIELDS = [
  "line_width", "layer_height", "outer_wall_speed", "nozzle_diameter_list", "nozzle_temp",
  "filament_type", "filament_flow_ratio", "filament_diameter", "filament_max_vol_speed",
  "filament_used_g", "filament_used_mm",
];
function pyRepr(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map((x) => (typeof x === "string" ? `'${x}'` : String(x))).join(", ") + "]";
  return String(v);
}

/**
 * Snapmaker U1 native baskı komutu — moonraker `start_print_advanced` + `_fill_metadata` BİREBİR replikası.
 * KRİTİK: `SDCARD_PRINT_FILE_WITH_PARAMETERS` önce `SET_PRINT_TASK_PARAMETERS` çalıştırıp `print_task_config`'i
 * (özellikle her kafanın `filament_type`'ını gcode başlığından) doldurur. Düz `SDCARD_PRINT_FILE` bunu YAPMAZ →
 * `filament_type=='NONE'` → preamble'daki `SM_PRINT_FLOW_CALIBRATE`/filament kontrolü `id=523,code=39` "not edit
 * filament" PAUSE → SAHTE runout, nozzle ısınmaz. (Kaynak: u1-moonraker klippy_apis.py, u1-klipper print_task_config.py.)
 * Calibration tercihleri DEFAULT 0/OFF — native preference (gcode'a dokunmadan; `flow_calibrate==0` makroyu
 * zararsızca erken döndürür, priming'i BOZMAZ).
 */
function buildSnapmakerStartScript(filename: string, meta: Record<string, unknown>, prefs?: MoonrakerPrefs): string {
  const esc = filename.replace(/"/g, '\\"');
  let s = `SDCARD_PRINT_FILE_WITH_PARAMETERS FILENAME="${esc}"`;
  s += ` BED_LEVEL="${prefs?.bedLeveling ? 1 : 0}" FLOW_CALIBRATE="${prefs?.flowCali ? 1 : 0}" TIME_LAPSE_CAMERA="${prefs?.timelapse ? 1 : 0}"`;
  for (const field of SM_META_FIELDS) {
    let out: string | null = null;
    if (field === "filament_used_g") {
      const w = (meta as any).filament_weight;
      if (w != null) out = pyRepr(w);
    } else if (field === "filament_type") {
      const ft = (meta as any).filament_type;
      if (ft != null) out = "[" + String(ft).split(";").map((it) => `'${it || "NONE"}'`).join(", ") + "]";
    } else {
      const v = (meta as any)[field];
      if (v != null && v !== "") out = pyRepr(v);
    }
    if (out != null) s += ` ${field.toUpperCase()}="${out}"`;
  }
  return s;
}

/**
 * Dosyayı yükle + baskıyı başlat.
 *  - **Snapmaker U1** → upload(`print=false`) + `SDCARD_PRINT_FILE_WITH_PARAMETERS` (native akış: print_task_config'i
 *    doldurur → SAHTE runout YOK; calibration tercihlerini geçirir).
 *  - **Diğer Moonraker (Elegoo)** → upload(`print=true`) (atomik; bu makro Elegoo'da yok).
 *  Dosya byte-for-byte gider; SADECE gerçek (identity olmayan) kafa remap'inde gcode'a dokunulur.
 */
export async function moonrakerUploadAndPrint(
  host: string,
  port: number,
  fileBuf: Buffer,
  filename: string,
  opts: { headMapping?: number[]; prefs?: MoonrakerPrefs; brand?: string } = {}
): Promise<void> {
  const isSnapmaker = (opts.brand || "").toLowerCase() === "snapmaker";
  let body = fileBuf;
  const isGcode = /\.(gcode|gco|g)$/i.test(filename);
  if (isGcode && opts.headMapping && opts.headMapping.length) {
    const toolMap: Record<number, number> = {};
    opts.headMapping.forEach((head, idx) => { if (typeof head === "number" && head >= 0) toolMap[idx] = head; });
    const keys = Object.keys(toolMap).map(Number);
    if (keys.length && !keys.every((k) => toolMap[k] === k)) {
      body = Buffer.from(remapMoonrakerTools(fileBuf.toString("latin1"), toolMap), "latin1");
    }
  }
  // Upload — Snapmaker: print=false (başlatma ayrı, parametreli); diğer: print=true (atomik).
  const fd = new FormData();
  fd.append("root", "gcodes");
  fd.append("print", isSnapmaker ? "false" : "true");
  fd.append("file", new Blob([new Uint8Array(body)]), filename);
  const res = await mfetch(`${moonrakerBase(host, port)}/server/files/upload`, { method: "POST", body: fd }, 180000);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Yükleme başarısız (HTTP ${res.status}) ${t.slice(0, 140)}`.trim());
  }
  if (!isSnapmaker) return; // Elegoo: print=true zaten başlattı.

  // Snapmaker: native start_print_advanced replikası → print_task_config dolar, sahte runout önlenir.
  const meta = await moonrakerRawMeta(host, port, filename);
  if ((meta as any).filament_type == null) {
    const ft = filamentTypeFromGcode(body);
    if (ft) (meta as any).filament_type = ft;
  }
  await moonrakerGcodeScript(host, port, buildSnapmakerStartScript(filename, meta, opts.prefs));
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

type MoonrakerSlot = { slot: number; color: string; type: string; empty: boolean };

/**
 * U1 CFS `filament_detect` objesini slot dizisine çevir.
 * Gerçek yapı (Snapmaker/u1-klipper · klippy/extras/filament_detect.py get_status):
 *   status.filament_detect = { info: [4 kanal], state: [4] }
 *   info[i] = { VENDOR, MAIN_TYPE, SUB_TYPE, RGB_1 (int), ARGB_COLOR, ALPHA, OFFICIAL, ... }
 *   YÜKLÜ DEĞİL varsayılan: MAIN_TYPE="NONE", RGB_1=0xFFFFFF (beyaz), OFFICIAL=false → renk YOK say.
 * `present(i)` = filament_motion_sensor e{i}_filament.filament_detected (gerçek doluluk).
 */
function parseFilamentDetect(fd: any, present?: (i: number) => boolean | null): MoonrakerSlot[] {
  let arr: any[] = [];
  if (Array.isArray(fd?.info)) arr = fd.info;
  else if (Array.isArray(fd)) arr = fd;
  else if (Array.isArray(fd?.slots)) arr = fd.slots;
  else if (Array.isArray(fd?.filaments)) arr = fd.filaments;
  else if (Array.isArray(fd?.trays)) arr = fd.trays;
  else return [];

  return arr.map((v, i) => {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, any>;
    const rgb: number | null =
      typeof o.RGB_1 === "number" ? o.RGB_1
      : typeof o.rgb_1 === "number" ? o.rgb_1
      : typeof o.ARGB_COLOR === "number" ? (o.ARGB_COLOR & 0xffffff)
      : null;
    const main = typeof o.MAIN_TYPE === "string" ? o.MAIN_TYPE : (typeof o.material === "string" ? o.material : "");
    const sub = typeof o.SUB_TYPE === "string" ? o.SUB_TYPE : "";
    const hasType = !!main && main.toUpperCase() !== "NONE";
    const type = hasType ? (sub && !["basic", "none", ""].includes(sub.toLowerCase()) ? `${main} ${sub}` : main) : "";
    const official = o.OFFICIAL === true;
    const vendorKnown = typeof o.VENDOR === "string" && o.VENDOR.toUpperCase() !== "NONE";
    // Varsayılan beyaz + başka bilgi yoksa "renk yok" (boş slot beyaz görünmesin).
    const realColor = rgb != null && rgb >= 0 && !(rgb === 0xffffff && !hasType && !official && !vendorKnown);
    let color = "#9ca3af";
    if (realColor) color = `#${(rgb! & 0xffffff).toString(16).padStart(6, "0").toUpperCase()}`;
    else {
      const hx = normalizeHex(o.color_hex ?? o.colorHex ?? o.color ?? o.colour ?? o.hex);
      if (hx !== "#9ca3af") color = hx;
    }
    const detected = present ? present(i) : null;
    const hasInfo = hasType || official || vendorKnown || color !== "#9ca3af";
    const empty = detected != null ? !detected : !hasInfo;
    return { slot: i, color, type, empty };
  });
}

/**
 * Snapmaker U1 `print_task_config` → kafa başına RENK + TİP + DOLULUK.
 * Gerçek kaynak (u1-klipper/print_task_config.py): touchscreen + Snapmaker Orca buradan okur.
 *   filament_color_rgba: ["RRGGBBAA"×4]  ·  filament_type: [...]  ·  filament_exist: [bool×4]
 * RFID'siz (3. parti) elle ayarlanan renkler de BURADA (filament_detect'te değil).
 */
function parsePrintTaskConfig(ptc: any): MoonrakerSlot[] | null {
  if (!ptc || typeof ptc !== "object") return null;
  const rgba = ptc.filament_color_rgba;
  const multi = ptc.filament_color_multi;
  const types = ptc.filament_type;
  const subs = ptc.filament_sub_type;
  const exist = ptc.filament_exist;
  if (!Array.isArray(rgba) && !Array.isArray(multi)) return null;
  const n = Math.max(Array.isArray(rgba) ? rgba.length : 0, Array.isArray(multi) ? multi.length : 0);
  const out: MoonrakerSlot[] = [];
  for (let i = 0; i < n; i++) {
    let hex: string | null = null;
    const r = Array.isArray(rgba) ? rgba[i] : null;
    if (typeof r === "string" && /^[0-9a-fA-F]{6,8}$/.test(r)) hex = r.slice(0, 6).toUpperCase(); // RRGGBBAA → RGB
    if (!hex) {
      const c = Array.isArray(multi) ? multi[i]?.colors?.[0] : null;
      if (typeof c === "string" && /^[0-9a-fA-F]{6}$/.test(c)) hex = c.toUpperCase();
    }
    const main = Array.isArray(types) && typeof types[i] === "string" ? types[i] : "";
    const sub = Array.isArray(subs) && typeof subs[i] === "string" ? subs[i] : "";
    const hasType = !!main && main.toUpperCase() !== "NONE";
    const type = hasType ? (sub && !["basic", "none", ""].includes(sub.toLowerCase()) ? `${main} ${sub}` : main) : "";
    const present = Array.isArray(exist) ? exist[i] === true : null;
    out.push({ slot: i, color: hex ? `#${hex}` : "#9ca3af", type, empty: present != null ? !present : (!hex && !type) });
  }
  return out.length ? out : null;
}

/**
 * Snapmaker U1 slot renkleri. ÖNCE print_task_config (gerçek renk/tip/doluluk — touchscreen'in
 * yazdığı yer), olmazsa filament_detect (RFID) + motion sensor, olmazsa keşif.
 */
export async function fetchMoonrakerSlots(host: string, port: number): Promise<MoonrakerSlot[]> {
  // 1) print_task_config — kafa başına renk + tip + doluluk (asıl kaynak).
  try {
    const res = await mfetch(`${moonrakerBase(host, port)}/printer/objects/query?print_task_config`, undefined, 5000);
    if (res.ok) {
      const ptc = unwrap(await res.json())?.status?.print_task_config;
      const parsed = parsePrintTaskConfig(ptc);
      if (parsed) return parsed;
    }
  } catch { /* sonraki yola düş */ }
  // 2) filament_detect (RFID) + filament_motion_sensor e0..e3 (doluluk) — yedek.
  try {
    const objs = [
      "filament_detect",
      "filament_motion_sensor e0_filament", "filament_motion_sensor e1_filament",
      "filament_motion_sensor e2_filament", "filament_motion_sensor e3_filament",
    ];
    const q = objs.map((o) => encodeURIComponent(o)).join("&");
    const res = await mfetch(`${moonrakerBase(host, port)}/printer/objects/query?${q}`, undefined, 5000);
    if (res.ok) {
      const status = unwrap(await res.json())?.status ?? {};
      const fd = status.filament_detect;
      if (fd && Array.isArray(fd.info)) {
        const present = (i: number): boolean | null => {
          const ms = status[`filament_motion_sensor e${i}_filament`];
          return ms && typeof ms.filament_detected === "boolean" ? ms.filament_detected : null;
        };
        const parsed = parseFilamentDetect(fd, present);
        if (parsed.length) return parsed;
      }
    }
  } catch { /* keşfe düş */ }
  // 2) Keşif: CFS/filament ile ilgili objeleri bul (firmware sürümüne göre ad değişebilir:
  //    filament_detect, cfs, box, feeder, mmu, tray...). Geniş filtre + iki strateji.
  try {
    const listRes = await mfetch(`${moonrakerBase(host, port)}/printer/objects/list`, undefined, 4000);
    if (!listRes.ok) return [];
    const objs: string[] = unwrap(await listRes.json())?.objects ?? [];
    const cand = objs
      .filter((o) => /filament|cfs|rfid|spool|tray|ams|slot|channel|colou?r|material|feeder|box|mmu/i.test(o))
      .slice(0, 24);
    if (!cand.length) return [];
    const q = cand.map((o) => encodeURIComponent(o)).join("&");
    const res = await mfetch(`${moonrakerBase(host, port)}/printer/objects/query?${q}`, undefined, 4000);
    if (!res.ok) return [];
    const status = unwrap(await res.json())?.status ?? {};
    // Strateji A: CFS-tarzı .info[] dizisi taşıyan bir obje varsa onu parse et (filament_detect şeması).
    for (const val of Object.values(status)) {
      const v = (val ?? {}) as Record<string, unknown>;
      if (Array.isArray((v as { info?: unknown }).info)) {
        const parsed = parseFilamentDetect(v);
        if (parsed.length) return parsed;
      }
    }
    // Strateji B: her objeyi tek slot say (color/type alanları).
    const slots: MoonrakerSlot[] = [];
    let i = 0;
    for (const val of Object.values(status)) {
      const v = (val ?? {}) as Record<string, unknown>;
      const rfid = (v.rfid ?? {}) as Record<string, unknown>;
      const color = v.color ?? v.colour ?? v.hex ?? v.rgb ?? (v as { RGB_1?: unknown }).RGB_1 ?? rfid.color ?? rfid.colour;
      const type = v.material ?? v.type ?? v.filament_type ?? (v as { MAIN_TYPE?: unknown }).MAIN_TYPE ?? rfid.material;
      if (color != null || type != null) {
        const rgbHex = typeof color === "number" && color > 0
          ? `#${(color & 0xffffff).toString(16).padStart(6, "0").toUpperCase()}`
          : normalizeHex(color);
        slots.push({ slot: i, color: rgbHex, type: typeof type === "string" ? type : "", empty: false });
      }
      i++;
    }
    return slots;
  } catch {
    return [];
  }
}

/**
 * TANILAMA: yazıcının açığa çıkardığı obje listesi + filament_detect ham yanıtı + CFS aday
 * objelerinin ham değerleri. Slot renkleri okunamadığında kullanıcı bunu paylaşır → şema eşlenir.
 */
export async function fetchMoonrakerSlotDebug(
  host: string,
  port: number
): Promise<{ objects: string[]; filamentDetect: unknown; candidates: Record<string, unknown> }> {
  const base = moonrakerBase(host, port);
  let objects: string[] = [];
  let filamentDetect: unknown = null;
  const candidates: Record<string, unknown> = {};
  try {
    const listRes = await mfetch(`${base}/printer/objects/list`, undefined, 4000);
    if (listRes.ok) objects = unwrap(await listRes.json())?.objects ?? [];
  } catch { /* yoksa boş */ }
  try {
    const fdRes = await mfetch(`${base}/printer/objects/query?filament_detect`, undefined, 4000);
    if (fdRes.ok) filamentDetect = unwrap(await fdRes.json())?.status?.filament_detect ?? null;
  } catch { /* yoksa null */ }
  const cand = objects
    .filter((o) => /filament|cfs|rfid|spool|tray|ams|slot|channel|colou?r|material|feeder|box|mmu/i.test(o))
    .slice(0, 24);
  if (cand.length) {
    try {
      const q = cand.map((o) => encodeURIComponent(o)).join("&");
      const res = await mfetch(`${base}/printer/objects/query?${q}`, undefined, 4000);
      if (res.ok) Object.assign(candidates, unwrap(await res.json())?.status ?? {});
    } catch { /* atla */ }
  }
  return { objects, filamentDetect, candidates };
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
