/**
 * Orca-ailesi (OrcaSlicer / Snapmaker Orca / Bambu Studio) gcode → katmanlı çizgi geometrisi.
 * Saf fonksiyon — Web Worker İÇİNDE çalışır (arayüzü asla dondurmaz).
 *
 * Çıktı: tek Float32Array içinde segmentler (x1,y1,z1,x2,y2,z2, ...) + katman aralıkları +
 * segment başına özellik tipi (dış duvar / iç duvar / dolgu / destek → renk). Nokta seyreltme
 * (min mesafe + doğrusal birleştirme) ile 200MB dosya bile birkaç MB geometriye iner.
 */

export interface ParsedGcode {
  /** Segment uçları: [x1,y1,z1,x2,y2,z2] × N (baskı tablası düzlemi XY, yükseklik Z). */
  positions: Float32Array;
  /** Segment başına özellik tipi kodu (FEATURE_* sabitleri). */
  features: Uint8Array;
  /** Katman i'nin segment aralığı: [start, end) — positions'ta segment indeksi (6 float = 1 segment). */
  layerRanges: { z: number; start: number; end: number }[];
  /** Model sınırları (kamera/çerçeveleme için). */
  bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  totalSegments: number;
}

export const FEATURE_OUTER = 0; // dış duvar
export const FEATURE_INNER = 1; // iç duvar
export const FEATURE_INFILL = 2; // dolgu
export const FEATURE_SUPPORT = 3; // destek
export const FEATURE_OTHER = 4; // köprü/kaplama/diğer

/** Orca ;TYPE: değerini kaba özellik koduna indir. */
function featureCode(type: string): number {
  const t = type.toLowerCase();
  if (t.includes("outer")) return FEATURE_OUTER;
  if (t.includes("inner") || t.includes("perimeter") || t.includes("wall")) return FEATURE_INNER;
  if (t.includes("infill") || t.includes("fill")) return FEATURE_INFILL;
  if (t.includes("support")) return FEATURE_SUPPORT;
  return FEATURE_OTHER;
}

/** Büyük gcode metnini satır satır işle (tek geçiş, düşük bellek). */
export function parseGcode(text: string, opts?: { maxSegments?: number }): ParsedGcode {
  const MAX_SEG = opts?.maxSegments ?? 900_000; // ~21MB float — üst sınır emniyeti
  const MIN_DIST2 = 0.12 * 0.12; // 0.12mm altı hareketleri birleştir (görsel fark yok)

  // Dinamik büyüyen segment havuzu
  let cap = 262_144;
  let pos = new Float32Array(cap * 6);
  let feat = new Uint8Array(cap);
  let segCount = 0;

  const layerRanges: ParsedGcode["layerRanges"] = [];
  let curLayerStart = 0;
  let curLayerZ = 0;
  let layerOpen = false;

  let x = 0, y = 0, z = 0, e = 0;
  let absE = true; // M82/M83
  let curFeature: number = FEATURE_OTHER;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;

  // Seyreltme: aynı yönde art arda kısa segmentleri tek segmentte topla
  let runStartX = 0, runStartY = 0, runStartZ = 0;
  let runActive = false;
  let runFeature = 0;

  const grow = () => {
    cap *= 2;
    const np = new Float32Array(cap * 6); np.set(pos); pos = np;
    const nf = new Uint8Array(cap); nf.set(feat); feat = nf;
  };

  const pushSeg = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, f: number) => {
    if (segCount >= MAX_SEG) return;
    if (segCount >= cap) grow();
    const o = segCount * 6;
    pos[o] = x1; pos[o + 1] = y1; pos[o + 2] = z1;
    pos[o + 3] = x2; pos[o + 4] = y2; pos[o + 5] = z2;
    feat[segCount] = f;
    segCount++;
    if (x1 < minX) minX = x1; if (x1 > maxX) maxX = x1;
    if (x2 < minX) minX = x2; if (x2 > maxX) maxX = x2;
    if (y1 < minY) minY = y1; if (y1 > maxY) maxY = y1;
    if (y2 < minY) minY = y2; if (y2 > maxY) maxY = y2;
    if (z1 < minZ) minZ = z1; if (z1 > maxZ) maxZ = z1;
    if (z2 < minZ) minZ = z2; if (z2 > maxZ) maxZ = z2;
  };

  const flushRun = (endX: number, endY: number, endZ: number) => {
    if (!runActive) return;
    pushSeg(runStartX, runStartY, runStartZ, endX, endY, endZ, runFeature);
    runActive = false;
  };

  const closeLayer = () => {
    if (layerOpen && segCount > curLayerStart) {
      layerRanges.push({ z: curLayerZ, start: curLayerStart, end: segCount });
    }
    layerOpen = false;
  };

  let i = 0;
  const n = text.length;
  while (i < n && segCount < MAX_SEG) {
    let nl = text.indexOf("\n", i);
    if (nl === -1) nl = n;
    const line = text.slice(i, nl);
    i = nl + 1;

    if (line.length === 0) continue;
    const c0 = line.charCodeAt(0);

    if (c0 === 59 /* ';' */) {
      // Yorum: katman + özellik tipi işaretleri (Orca ailesi ortak)
      if (line.startsWith(";LAYER_CHANGE") || line.startsWith("; CHANGE_LAYER") || line.startsWith(";LAYER:")) {
        flushRun(x, y, z);
        closeLayer();
        curLayerStart = segCount;
        curLayerZ = z; // gerçek Z bir sonraki G1 Z ile netleşir; başlangıç değeri yeterli
        layerOpen = true;
      } else if (line.startsWith(";TYPE:") || line.startsWith("; FEATURE:")) {
        flushRun(x, y, z);
        curFeature = featureCode(line.slice(line.indexOf(":") + 1));
      } else if (line.startsWith(";Z:")) {
        const zv = parseFloat(line.slice(3));
        if (Number.isFinite(zv)) curLayerZ = zv;
      }
      continue;
    }

    if (c0 !== 71 /* 'G' */ && c0 !== 77 /* 'M' */) continue;

    if (c0 === 77) {
      if (line.startsWith("M82")) absE = true;
      else if (line.startsWith("M83")) absE = false;
      continue;
    }

    // G0/G1 hareketleri
    const sp = line.charCodeAt(1);
    if ((sp === 48 || sp === 49) && (line.length === 2 || line.charCodeAt(2) === 32)) {
      let nx = x, ny = y, nz = z, ne = NaN;
      // Hafif elle ayrıştırma (regex'ten hızlı): "X12.3 Y4 Z0.2 E1.234 F9000"
      let j = 2;
      const len = line.length;
      while (j < len) {
        const ch = line.charCodeAt(j);
        if (ch === 59) break; // satır içi yorum
        if (ch === 88 /*X*/ || ch === 89 /*Y*/ || ch === 90 /*Z*/ || ch === 69 /*E*/) {
          let k = j + 1;
          while (k < len) {
            const d = line.charCodeAt(k);
            if ((d >= 48 && d <= 57) || d === 46 || d === 45 || d === 43) k++;
            else break;
          }
          const v = parseFloat(line.slice(j + 1, k));
          if (Number.isFinite(v)) {
            if (ch === 88) nx = v;
            else if (ch === 89) ny = v;
            else if (ch === 90) nz = v;
            else ne = v;
          }
          j = k;
        } else j++;
      }

      const extruding = Number.isFinite(ne) ? (absE ? ne > e + 1e-6 : ne > 1e-6) : false;
      if (Number.isFinite(ne)) e = absE ? ne : e + ne;

      if (extruding && (nx !== x || ny !== y)) {
        if (!layerOpen) { // bazı başlangıç purge çizgileri LAYER_CHANGE'ten önce gelir
          curLayerStart = segCount;
          curLayerZ = nz;
          layerOpen = true;
        }
        const dx = nx - x, dy = ny - y;
        if (runActive && runFeature === curFeature && dx * dx + dy * dy < MIN_DIST2) {
          // kısa segment — koşuya kat (uç güncellenecek)
        } else {
          flushRun(x, y, z);
          runStartX = x; runStartY = y; runStartZ = z;
          runActive = true;
          runFeature = curFeature;
        }
      } else if (runActive) {
        flushRun(x, y, z); // seyahat hareketi koşuyu kapatır
      }
      x = nx; y = ny; z = nz;
    }
  }
  flushRun(x, y, z);
  closeLayer();

  if (segCount === 0) {
    return {
      positions: new Float32Array(0), features: new Uint8Array(0), layerRanges: [],
      bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 }, totalSegments: 0,
    };
  }
  return {
    positions: pos.slice(0, segCount * 6),
    features: feat.slice(0, segCount),
    layerRanges,
    bounds: { minX, maxX, minY, maxY, minZ, maxZ },
    totalSegments: segCount,
  };
}
