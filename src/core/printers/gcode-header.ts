/**
 * Gcode başlık/altbilgi ayrıştırıcıları — dilimleyicinin dosyaya yazdığı ama Moonraker'ın
 * OKUMADIĞI bilgiler.
 *
 * Canlı ölçüm (12 Ağu, Elegoo Neptune 4 Pro/Plus): `/server/files/metadata` yalnız
 * `size, modified, print_start_time, job_id, filename` döndürüyor — süre tahmini yok,
 * küçük resim yok, katman yok, filament rengi yok. Oysa dosyanın kendisinde HEPSİ var:
 *
 *   BAŞ (~ilk 200 KB)  : `; total layer number: 371`
 *                        `; thumbnail begin 320x320 31312` … base64 … `; thumbnail end`
 *                        `; thumbnail begin 800x800 131940` … (en büyüğü seçilir)
 *   SON (~son 40 KB)   : `; estimated printing time (normal mode) = 2h 0m 50s`
 *                        `; filament_colour = #FFFFFF`  ·  `; filament_type = PLA`
 *                        `; total filament used [g] = 30.51`  ·  `; layer_height = 0.2`
 *
 * Snapmaker U1'de Moonraker bu alanları zaten tarıyor (ve `.thumbs/…-300x300.png` üretiyor),
 * orada bu ayrıştırıcılar yalnız yedek olarak devreye girer.
 */

export interface GcodeThumbnail {
  width: number;
  height: number;
  /** "image/png" | "image/jpeg" */
  mime: string;
  base64: string;
}

const THUMB_BEGIN = /^;\s*thumbnail(_JPG|_PNG)?\s+begin\s+(\d+)\s*[xX]\s*(\d+)\s+(\d+)\s*$/;
const THUMB_END = /^;\s*thumbnail(_JPG|_PNG)?\s+end\s*$/;

/**
 * Gcode metnindeki gömülü küçük resim bloklarını çıkar.
 * Blok kapanmadıysa (metin ortadan kesilmişse) o blok ATILIR — yarım base64 kırık görsel demek.
 */
export function parseGcodeThumbnails(text: string): GcodeThumbnail[] {
  const out: GcodeThumbnail[] = [];
  if (!text) return out;
  let current: { width: number; height: number; mime: string; parts: string[] } | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith(";")) {
      // Gerçek gcode başladıysa açık blok yarım kalmış demektir — bırak.
      if (current && line) current = null;
      continue;
    }
    const begin = THUMB_BEGIN.exec(line);
    if (begin) {
      current = {
        width: Number(begin[2]),
        height: Number(begin[3]),
        mime: begin[1]?.toUpperCase() === "_JPG" ? "image/jpeg" : "image/png",
        parts: [],
      };
      continue;
    }
    if (THUMB_END.test(line)) {
      if (current && current.parts.length) {
        const base64 = current.parts.join("");
        if (/^[A-Za-z0-9+/=]+$/.test(base64)) {
          out.push({ width: current.width, height: current.height, mime: current.mime, base64 });
        }
      }
      current = null;
      continue;
    }
    if (current) {
      // Blok içi satırlar "; <base64>" biçiminde; boş "; " satırları atlanır.
      // Base64 OLMAYAN satırlar (Elegoo'nun `;gimage:` önizlemesi bloğun ortasına düşebiliyor)
      // atlanır: eskiden bloğa karışıp tüm blokun geçersiz sayılmasına ve gerçek küçük resmin
      // kaybolmasına yol açıyordu. Base64 verisi ':' içermez, bu ayrım güvenlidir.
      const chunk = line.slice(1).trim();
      if (chunk && /^[A-Za-z0-9+/=]+$/.test(chunk)) current.parts.push(chunk);
    }
  }
  return out;
}

/** En yüksek çözünürlüklü küçük resim (yoksa null). */
export function pickLargestThumbnail(list: GcodeThumbnail[]): GcodeThumbnail | null {
  if (!list.length) return null;
  return [...list].sort((a, b) => b.width * b.height - a.width * a.height)[0];
}

/** Tarayıcıda doğrudan gösterilebilir data URL. */
export function thumbnailDataUrl(t: GcodeThumbnail): string {
  return `data:${t.mime};base64,${t.base64}`;
}

/**
 * Dilimleyicinin toplam süre tahmini (saniye).
 * Desteklenen biçimler:
 *   `; estimated printing time (normal mode) = 1d 2h 3m 4s`   (Orca / PrusaSlicer / Bambu Studio)
 *   `; estimated printing time = 2h 0m 50s`
 *   `;TIME:7250`                                              (Cura)
 *   `; total estimated time: 7250`
 */
export function parseGcodeEstimatedTimeSec(text: string): number | null {
  if (!text) return null;
  const human =
    /;\s*estimated printing time(?:\s*\([^)]*\))?\s*[:=]\s*([0-9dhms\s]+)/i.exec(text);
  if (human) {
    const sec = parseHumanDuration(human[1]);
    if (sec != null) return sec;
  }
  const cura = /^;TIME:\s*(\d+)\s*$/im.exec(text);
  if (cura) {
    const n = Number(cura[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const plain = /;\s*total estimated time\s*[:=]\s*(\d+)/i.exec(text);
  if (plain) {
    const n = Number(plain[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** "1d 2h 3m 4s" → saniye. Hiç birim yakalanmazsa null. */
function parseHumanDuration(s: string): number | null {
  let total = 0;
  let found = false;
  const re = /(\d+)\s*([dhms])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    found = true;
    switch (m[2].toLowerCase()) {
      case "d": total += n * 86400; break;
      case "h": total += n * 3600; break;
      case "m": total += n * 60; break;
      default: total += n;
    }
  }
  return found && total > 0 ? total : null;
}

/**
 * Dilimleyicinin filament renkleri: `; filament_colour = #FFFFFF;#000000`.
 * Sıra dilimleyicinin MANTIKSAL filament sırasıdır (kafa sırası değil).
 */
export function parseGcodeFilamentColours(text: string): string[] {
  if (!text) return [];
  const m = /^;\s*(?:filament_colour|filament_color|extruder_colour)\s*=\s*(.+)$/im.exec(text);
  if (!m) return [];
  return m[1]
    .split(/[;,]/)
    .map((p) => p.trim().replace(/^["']|["']$/g, ""))
    .filter((p) => /^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(p))
    .map((p) => `#${(p.startsWith("#") ? p.slice(1) : p).slice(0, 6).toUpperCase()}`);
}

/** Dilimleyicinin filament tipleri: `; filament_type = PLA;PETG` → ["PLA","PETG"]. */
export function parseGcodeFilamentTypes(text: string): string[] {
  if (!text) return [];
  const m = /^;\s*filament_type\s*=\s*(.+)$/im.exec(text);
  if (!m) return [];
  return [...new Set(m[1].split(/[;,:|/]/).map((p) => p.trim().replace(/^["']|["']$/g, "")).filter(Boolean))];
}

/** Toplam filament ağırlığı (gram) — YALNIZ GÖSTERİM içindir, maliyet hesabına girmez. */
export function parseGcodeFilamentGrams(text: string): number | null {
  if (!text) return null;
  const m =
    /^;\s*total filament used \[g\]\s*=\s*([\d.]+)/im.exec(text) ??
    /^;\s*filament used \[g\]\s*=\s*([\d.]+)/im.exec(text);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}
