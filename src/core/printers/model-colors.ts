/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Model dosyasından (gcode / 3mf) baskının kullandığı filament RENKLERİNİ okur.
 *
 * Amaç: çok renkli baskıda kullanıcıya Bambu Studio tarzı "şu rengi hangi slota"
 * seçtirmek — renk sayısını/renkleri ELLE değil, DOSYADAN almak.
 *
 * Kaynaklar:
 *  - .gcode (Bambu/Orca/Prusa/Klipper) başlık/altbilgi yorumları:
 *      "; filament_colour = #RRGGBB;#RRGGBB"   → renk listesi
 *      "; filament used [g] = a,b"             → kullanılan (0 olmayanlar)
 *      "; filament_type = PLA;PETG"
 *  - .3mf (zip):
 *      1) Metadata/slice_info.config (XML) → SADECE kullanılan filamentler:
 *         <filament id="1" type="PLA" color="#RRGGBB" used_g="12.3"/>
 *      2) Metadata/project_settings.config (JSON) → filament_colour[], filament_type[]
 *      3) Metadata/plate_*.gcode başlığı (yukarıdaki gcode mantığı)
 */
import fs from "node:fs";
import { unzipSync, strFromU8 } from "fflate";

export interface ModelColor {
  index: number; // dilimleyicideki 0-tabanlı filament sırası (T-index)
  hex: string; // #RRGGBB
  type: string; // PLA, PETG... ("" bilinmiyorsa)
  grams: number | null;
}
export type ColorSource = "gcode" | "3mf-sliceinfo" | "3mf-settings" | "3mf-gcode" | "none";
export interface ModelColorInfo {
  colors: ModelColor[];
  source: ColorSource;
  fileKind: "gcode" | "3mf" | "other";
}

function normHex(s: unknown): string | null {
  if (typeof s !== "string") return null;
  let h = s.trim();
  if (h.startsWith("#")) h = h.slice(1);
  if (/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(h)) return `#${h.slice(0, 6).toUpperCase()}`; // RRGGBB[AA]
  return null;
}

function splitList(v: string): string[] {
  return v.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
}

function headerValue(text: string, key: string): string | null {
  // "; key = value"  (boşluk toleranslı, satır bazlı, büyük/küçük harf duyarsız)
  const re = new RegExp(`^\\s*;\\s*${key}\\s*=\\s*(.+?)\\s*$`, "im");
  const m = text.match(re);
  return m ? m[1] : null;
}

/** Bir gcode metninden (başlık/altbilgi) kullanılan filament renklerini çıkar. */
export function parseGcodeText(text: string): ModelColor[] {
  const colourRaw =
    headerValue(text, "filament_colour") ||
    headerValue(text, "filament_color") ||
    headerValue(text, "extruder_colour") ||
    headerValue(text, "extruder_color");
  if (!colourRaw) return [];
  const hexes = splitList(colourRaw).map(normHex);

  const typeRaw = headerValue(text, "filament_type");
  const types = typeRaw ? splitList(typeRaw) : [];

  const usedRaw =
    headerValue(text, "filament used \\[g\\]") ||
    headerValue(text, "filament used \\[mm\\]") ||
    headerValue(text, "filament used \\[cm3\\]");
  const used = usedRaw ? splitList(usedRaw).map((x) => parseFloat(x.replace(/[^0-9.\-]/g, ""))) : [];
  const haveUsed = used.length > 0;

  const out: ModelColor[] = [];
  hexes.forEach((hex, i) => {
    if (!hex) return;
    const g = haveUsed ? (Number.isFinite(used[i]) ? used[i] : 0) : null;
    if (haveUsed && (g ?? 0) <= 0) return; // dilimde tanımlı ama basılmayan filamenti atla
    out.push({ index: i, hex, type: types[i] || "", grams: g != null ? Math.round(g * 10) / 10 : null });
  });
  // Hiçbiri "used" filtresini geçemediyse (ör. tek renk, used=0 yazılmış) → ham listeyi döndür
  if (out.length === 0 && hexes.some(Boolean)) {
    hexes.forEach((hex, i) => { if (hex) out.push({ index: i, hex, type: types[i] || "", grams: null }); });
  }
  return out;
}

function parse3mf(buf: Buffer): { colors: ModelColor[]; source: ColorSource } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buf), {
      // Sadece küçük metadata dosyalarını aç (dev plate gcode'unu açma → hız/bellek)
      filter: (f) => /\.config$/i.test(f.name) || /Metadata\/.*\.gcode$/i.test(f.name),
    });
  } catch {
    return { colors: [], source: "none" };
  }
  const readByRx = (rx: RegExp): string | null => {
    const key = Object.keys(files).find((k) => rx.test(k));
    return key ? strFromU8(files[key]) : null;
  };

  // 1) slice_info.config — yalnızca KULLANILAN filamentler (en güvenilir)
  const sliceInfo = readByRx(/slice_info\.config$/i);
  if (sliceInfo) {
    const colors: ModelColor[] = [];
    const re = /<filament\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sliceInfo))) {
      const tag = m[0];
      const id = /\bid\s*=\s*"(\d+)"/i.exec(tag)?.[1];
      const hex = normHex(/\bcolou?r\s*=\s*"([^"]+)"/i.exec(tag)?.[1]);
      const type = /\btype\s*=\s*"([^"]+)"/i.exec(tag)?.[1] || "";
      const g = parseFloat(/\bused_g\s*=\s*"([^"]+)"/i.exec(tag)?.[1] || "");
      if (hex) {
        colors.push({
          index: id ? Math.max(0, parseInt(id, 10) - 1) : colors.length,
          hex, type, grams: Number.isFinite(g) ? Math.round(g * 10) / 10 : null,
        });
      }
    }
    if (colors.length) return { colors, source: "3mf-sliceinfo" };
  }

  // 2) project_settings.config — JSON filament_colour[] (tüm tanımlı filamentler)
  const proj = readByRx(/project_settings\.config$/i);
  if (proj) {
    try {
      const j: any = JSON.parse(proj);
      const cols: unknown[] = Array.isArray(j.filament_colour) ? j.filament_colour : [];
      const types: unknown[] = Array.isArray(j.filament_type) ? j.filament_type : [];
      const colors: ModelColor[] = [];
      cols.forEach((c, i) => {
        const h = normHex(c);
        if (h) colors.push({ index: i, hex: h, type: typeof types[i] === "string" ? (types[i] as string) : "", grams: null });
      });
      if (colors.length) return { colors, source: "3mf-settings" };
    } catch { /* yoksay */ }
  }

  // 3) gömülü plate gcode başlığı
  const gkey =
    Object.keys(files).find((k) => /Metadata\/.*plate.*\.gcode$/i.test(k)) ||
    Object.keys(files).find((k) => /\.gcode$/i.test(k));
  if (gkey) {
    const colors = parseGcodeText(strFromU8(files[gkey]).slice(0, 400_000));
    if (colors.length) return { colors, source: "3mf-gcode" };
  }

  return { colors: [], source: "none" };
}

/** Dosyanın baş ve son N baytını birleştirip metin döndürür (büyük gcode'u tümüyle yüklemeden). */
function readHeadTail(filePath: string, n: number): string {
  const size = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, "r");
  try {
    if (size <= n * 2) {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      return buf.toString("latin1");
    }
    const head = Buffer.alloc(n);
    fs.readSync(fd, head, 0, n, 0);
    const tail = Buffer.alloc(n);
    fs.readSync(fd, tail, 0, n, size - n);
    return `${head.toString("latin1")}\n${tail.toString("latin1")}`;
  } finally {
    fs.closeSync(fd);
  }
}

/** Bir model dosyasının (gcode/3mf) kullandığı filament renklerini oku. */
export function readModelColors(filePath: string): ModelColorInfo {
  const lower = filePath.toLowerCase();
  const is3mf = lower.endsWith(".3mf"); // .gcode.3mf dahil
  const isGcode = !is3mf && /\.(gcode|gco|g)$/i.test(lower);
  try {
    if (is3mf) {
      const r = parse3mf(fs.readFileSync(filePath));
      return { colors: r.colors, source: r.source, fileKind: "3mf" };
    }
    if (isGcode) {
      const colors = parseGcodeText(readHeadTail(filePath, 350_000));
      return { colors, source: colors.length ? "gcode" : "none", fileKind: "gcode" };
    }
  } catch { /* none döner */ }
  return { colors: [], source: "none", fileKind: is3mf ? "3mf" : isGcode ? "gcode" : "other" };
}

// ── Baskı meta verisi (süre / gramaj / önizleme) — özel baskı ekranı için ──────────────
export interface ModelMeta {
  grams: number | null; // toplam kullanılan filament (g)
  estPrintMin: number | null; // tahmini baskı süresi (dakika)
  thumbnail: string | null; // data URL (PNG önizleme)
}

function parseTimeToMin(s: string): number | null {
  let total = 0;
  let found = false;
  const h = /(\d+)\s*h/i.exec(s);
  if (h) { total += Number(h[1]) * 60; found = true; }
  const m = /(\d+)\s*m(?:in)?\b/i.exec(s);
  if (m) { total += Number(m[1]); found = true; }
  const sec = /(\d+)\s*s\b/i.exec(s);
  if (sec) { total += Number(sec[1]) / 60; found = true; }
  return found ? Math.max(1, Math.round(total)) : null;
}

/** gcode başlığındaki gömülü PNG önizlemeyi (en büyüğünü) data URL olarak çıkar. */
function gcodeThumbnail(text: string): string | null {
  const re = /;\s*thumbnail\s+begin\s+(\d+)x(\d+)\s+\d+\s*([\s\S]*?);\s*thumbnail\s+end/gi;
  let best: { area: number; b64: string } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const area = Number(m[1]) * Number(m[2]);
    const b64 = m[3].replace(/^\s*;/gm, "").replace(/\s+/g, "");
    if (b64 && (!best || area > best.area)) best = { area, b64 };
  }
  return best ? `data:image/png;base64,${best.b64}` : null;
}

function gcodeMeta(text: string): ModelMeta {
  let grams: number | null = null;
  const tot = headerValue(text, "total filament used \\[g\\]");
  if (tot) { const g = parseFloat(tot); if (Number.isFinite(g)) grams = Math.round(g * 10) / 10; }
  if (grams == null) {
    const used = headerValue(text, "filament used \\[g\\]");
    if (used) {
      const sum = splitList(used).map((x) => parseFloat(x)).filter((n) => Number.isFinite(n)).reduce((a, b) => a + b, 0);
      if (sum > 0) grams = Math.round(sum * 10) / 10;
    }
  }
  const t =
    headerValue(text, "estimated printing time \\(normal mode\\)") ||
    headerValue(text, "estimated printing time") ||
    headerValue(text, "model printing time") ||
    headerValue(text, "total estimated time");
  return { grams, estPrintMin: t ? parseTimeToMin(t) : null, thumbnail: gcodeThumbnail(text) };
}

function meta3mf(buf: Buffer): ModelMeta {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buf), {
      filter: (f) => /\.config$/i.test(f.name) || /Metadata\/.*\.(png|gcode)$/i.test(f.name),
    });
  } catch {
    return { grams: null, estPrintMin: null, thumbnail: null };
  }
  let grams: number | null = null;
  let estPrintMin: number | null = null;
  let thumbnail: string | null = null;

  const sliceKey = Object.keys(files).find((k) => /slice_info\.config$/i.test(k));
  if (sliceKey) {
    const xml = strFromU8(files[sliceKey]);
    const usedG = [...xml.matchAll(/used_g\s*=\s*"([^"]+)"/gi)].map((m) => parseFloat(m[1])).filter((n) => Number.isFinite(n));
    if (usedG.length) grams = Math.round(usedG.reduce((a, b) => a + b, 0) * 10) / 10;
    const pred = /(?:prediction|time)\s*=\s*"(\d+)"/i.exec(xml) || /key\s*=\s*"prediction"\s+value\s*=\s*"(\d+)"/i.exec(xml);
    if (pred) estPrintMin = Math.max(1, Math.round(Number(pred[1]) / 60));
  }

  const pngKeys = Object.keys(files).filter((k) => /Metadata\/.*\.png$/i.test(k));
  if (pngKeys.length) {
    const key = pngKeys.find((k) => /plate_1\.png$/i.test(k)) || pngKeys.sort((a, b) => files[b].length - files[a].length)[0];
    thumbnail = `data:image/png;base64,${Buffer.from(files[key]).toString("base64")}`;
  }

  if (estPrintMin == null || grams == null) {
    const gkey =
      Object.keys(files).find((k) => /Metadata\/.*plate.*\.gcode$/i.test(k)) ||
      Object.keys(files).find((k) => /\.gcode$/i.test(k));
    if (gkey) {
      const gm = gcodeMeta(strFromU8(files[gkey]).slice(0, 400_000));
      estPrintMin = estPrintMin ?? gm.estPrintMin;
      grams = grams ?? gm.grams;
    }
  }
  return { grams, estPrintMin, thumbnail };
}

/**
 * Bambu baskı için: .3mf içindeki GERÇEK plate gcode yolu + PROJEDEKİ TOPLAM filament sayısı.
 * BambuStudio ams_mapping'i TÜM proje filamentleri üzerinden (kullanılmayan = -1) ve plate
 * param'ını gerçek dosya adıyla gönderir. Biz de aynısını yapmalıyız, yoksa A1 reddeder.
 */
export function readBambuPrintMeta(filePath: string): { plateParam: string; filamentCount: number } {
  const def = { plateParam: "Metadata/plate_1.gcode", filamentCount: 0 };
  const lower = filePath.toLowerCase();
  const countFromHeader = (text: string): number => {
    const raw =
      headerValue(text, "filament_colour") || headerValue(text, "filament_color") ||
      headerValue(text, "extruder_colour") || headerValue(text, "extruder_color");
    return raw ? splitList(raw).filter((x) => normHex(x)).length : 0;
  };
  try {
    if (lower.endsWith(".3mf")) {
      const files = unzipSync(new Uint8Array(fs.readFileSync(filePath)), {
        filter: (f) => /\.config$/i.test(f.name) || /Metadata\/.*plate.*\.gcode$/i.test(f.name),
      });
      const gkey =
        Object.keys(files).find((k) => /Metadata\/plate_\d+\.gcode$/i.test(k)) ||
        Object.keys(files).find((k) => /Metadata\/.*plate.*\.gcode$/i.test(k));
      const plateParam = gkey || def.plateParam;
      let filamentCount = 0;
      const projKey = Object.keys(files).find((k) => /project_settings\.config$/i.test(k));
      if (projKey) {
        try {
          const j = JSON.parse(strFromU8(files[projKey]));
          if (Array.isArray(j.filament_colour)) filamentCount = j.filament_colour.length;
        } catch { /* yoksay */ }
      }
      if (!filamentCount && gkey) filamentCount = countFromHeader(strFromU8(files[gkey]).slice(0, 200_000));
      return { plateParam, filamentCount };
    }
    return { plateParam: def.plateParam, filamentCount: countFromHeader(readHeadTail(filePath, 200_000)) };
  } catch {
    return def;
  }
}

/** Bir model dosyasının baskı meta verisi: toplam gramaj + süre + önizleme görseli. */
export function readModelMeta(filePath: string): ModelMeta {
  const lower = filePath.toLowerCase();
  const is3mf = lower.endsWith(".3mf");
  const isGcode = !is3mf && /\.(gcode|gco|g)$/i.test(lower);
  try {
    if (is3mf) return meta3mf(fs.readFileSync(filePath));
    if (isGcode) return gcodeMeta(readHeadTail(filePath, 400_000));
  } catch { /* boş döner */ }
  return { grams: null, estPrintMin: null, thumbnail: null };
}

/**
 * Dosya gerçekten DİLİMLENMİŞ bir Bambu/Orca 3MF mi? (içinde Metadata/plate_*.gcode var mı)
 * STL/OBJ veya unsliced 3MF → false. .gcode dosyaları zaten dilimli sayılır (true).
 */
export function is3mfSliced(filePath: string): boolean {
  const low = filePath.toLowerCase();
  if (/\.(gcode|gco|g)$/.test(low) && !low.endsWith(".3mf")) return true; // ham gcode = dilimli
  if (!low.endsWith(".3mf")) return false; // .stl/.obj vb. dilimli değil
  try {
    const files = unzipSync(new Uint8Array(fs.readFileSync(filePath)), {
      filter: (f) => /\.gcode$/i.test(f.name),
    });
    return Object.keys(files).some((k) => /Metadata\/.*plate.*\.gcode$/i.test(k) || /\.gcode$/i.test(k));
  } catch {
    return false;
  }
}
