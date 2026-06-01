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
