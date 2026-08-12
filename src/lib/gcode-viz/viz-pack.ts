/**
 * "viz-pack" — gcode'un kompakt ikili görselleştirme paketi.
 *
 * NEDEN VAR: eski akışta 178 MB'lık gcode olduğu gibi tarayıcıya indiriliyor, orada ayrıştırılıyor
 * ve 900.000 segmentlik SABİT bir tavana takılıp dosyanın ortasında sessizce kesiliyordu — modelin
 * yalnız alt %17'si çiziliyordu. Paket bu üç sorunu birden çözer:
 *   1) Dosya BİR KEZ akış hâlinde taranır (sabit bellek), TÜM model paketlenir — sessiz kesme yok.
 *   2) Tarayıcıya 178 MB yerine birkaç MB iner.
 *   3) Her katmanın DOSYADAKİ BAYT KONUMU (`layerByteOffset`) pakette taşınır; yazıcının
 *      `virtual_sdcard.file_position` değeri doğrudan katmana çevrilebilir (canlı aşama göstergesi).
 *
 * Kayıp: segmentler yerine YOLLAR (kesintisiz ekstrüzyon zincirleri) saklanır ve XY 16-bit
 * kuantize edilir (model sınırlarına göre; tipik çözünürlük < 0.01 mm — ekstrüzyon genişliği
 * 0.4 mm olduğundan gözle görülmez). Z katman başına tek float.
 */

// ── Özellik (extrusion role) kodları ────────────────────────────────────────
// 0-4 eski kodlarla AYNI kalır (eski renk tablosu ve testler bozulmasın).
export const FEATURE_OUTER = 0; // dış duvar (siluet)
export const FEATURE_INNER = 1; // iç duvar
export const FEATURE_INFILL = 2; // seyrek dolgu — GÖVDE DEĞİL
export const FEATURE_SUPPORT = 3; // destek — GÖVDE DEĞİL
export const FEATURE_OTHER = 4; // sınıflandırılamayan
export const FEATURE_SOLID = 5; // katı dolgu / üst-alt yüzey / köprü / boşluk dolgusu — GÖVDE
export const FEATURE_SKIRT = 6; // etek, kenar, temizleme kulesi, purge — MODEL DEĞİL

/** Gövde (modelin gözle görülen eti) mi? Kart görselinde yalnız bunlar çizilir. */
export function isBodyFeature(f: number): boolean {
  return f === FEATURE_OUTER || f === FEATURE_INNER || f === FEATURE_SOLID || f === FEATURE_OTHER;
}

/**
 * Dilimleyicinin `;TYPE:` / `; FEATURE:` etiketini özellik koduna indir.
 * Sıra ÖNEMLİ: "Internal solid infill" içinde "infill" geçse de KATI gövdedir — eski kod bunu
 * seyrek dolgu sayıp modelin etini mavi boyuyordu.
 */
export function featureCode(type: string): number {
  const t = type.trim().toLowerCase();
  if (t.includes("support")) return FEATURE_SUPPORT;
  if (t.includes("prime tower") || t.includes("wipe tower") || t.includes("skirt") || t.includes("brim") || t.includes("purge") || t.includes("custom")) return FEATURE_SKIRT;
  if (t.includes("outer") || t.includes("overhang") || t.includes("external")) return FEATURE_OUTER;
  if (t.includes("bridge") || t.includes("solid") || t.includes("top surface") || t.includes("bottom surface") || t.includes("gap")) return FEATURE_SOLID;
  if (t.includes("inner") || t.includes("perimeter") || t.includes("wall")) return FEATURE_INNER;
  if (t.includes("infill") || t.includes("fill")) return FEATURE_INFILL;
  return FEATURE_OTHER;
}

export interface VizBounds {
  minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number;
}

/** Kompakt paket (bellekteki hâli). */
export interface VizPack {
  /** Kuantize nokta havuzu: [qx, qy] × pointCount. Gerçek mm = origin + q * scale. */
  points: Uint16Array;
  /** Yol i'nin ilk noktasının havuzdaki indeksi. */
  pathStart: Uint32Array;
  /** Yol i'nin nokta sayısı (>= 2 → en az 1 segment). */
  pathLen: Uint32Array;
  /** Yol i'nin özellik kodu (FEATURE_*). */
  pathFeature: Uint8Array;
  /** Yol i'yi basan araç (T0 → 0, T1 → 1, …). Gerçek filament renkleri buna bağlanır. */
  pathTool: Uint8Array;

  /** Katman i'nin Z yüksekliği (mm). */
  layerZ: Float32Array;
  /** Katman i'nin yol aralığı: [start, end). */
  layerPathStart: Uint32Array;
  layerPathEnd: Uint32Array;
  /** Katman i'nin gcode dosyasındaki BAYT konumu — file_position → katman çevrimi bunu kullanır. */
  layerByteOffset: Float64Array;

  /** Kuantizasyon tabanı ve adımı (mm). */
  originX: number;
  originY: number;
  scaleXY: number;

  bounds: VizBounds;
  /** Paketteki segment sayısı (Σ pathLen-1) — ekrana çizilecek olan. */
  segmentCount: number;
  /** Dosyada gerçekten görülen ekstrüzyon hareketi sayısı (seyreltmeden ÖNCE). */
  scannedSegments: number;
  /** Kullanılan araç sayısı (en büyük araç indeksi + 1). */
  toolCount: number;
  /** Dilimleyicinin bildirdiği filament renkleri ("#RRGGBB"), varsa. */
  filamentColors: string[];
  /** Taranan dosyanın boyutu (bayt). */
  fileSize: number;
  /** Uygulanan seyreltme kademesi (0 = tam çözünürlük). Sessiz KESME değildir; çözünürlük düşer. */
  thinLevel: number;
  /** Seyreltme toleransı (mm) — kademeyle büyür. */
  epsilon: number;
}

/** İzleyici/kart tarafının beklediği düz segment geometrisi. */
export interface ParsedGcode {
  /** Segment uçları: [x1,y1,z1,x2,y2,z2] × N. */
  positions: Float32Array;
  /** Segment başına özellik kodu. */
  features: Uint8Array;
  /** Segment başına araç indeksi. */
  tools: Uint8Array;
  /** Katman i'nin segment aralığı [start, end) + Z + dosyadaki bayt konumu. */
  layerRanges: { z: number; start: number; end: number; byteOffset: number }[];
  bounds: VizBounds;
  totalSegments: number;
  /** Dosyadaki gerçek segment sayısı (seyreltmeden önce) — "tam mı çizildi?" sorusunun cevabı. */
  scannedSegments: number;
  toolCount: number;
  filamentColors: string[];
  fileSize: number;
  thinLevel: number;
}

// ── İkili kodlama ───────────────────────────────────────────────────────────
// [ "MLVZ" | başlıkUzunluğu:u32 | JSON başlık | bölümler… ]
// Her bölüm KENDİ eleman boyutuna hizalanır (u16→2, u32/f32→4, f64→8).
//
// ⚠️ SÜRÜM 1'DEKİ HATA: bütün bölümler 4 bayta hizalanıyordu, ama son bölüm (`layerByteOffset`)
// bir Float64Array ve `new Float64Array(buffer, offset, n)` offset'in 8'in KATI olmasını şart
// koşar. Offset başlık uzunluğuna + nokta/yol/katman sayılarına bağlı olduğu için paketlerin
// yaklaşık yarısı çözülemiyor, `RangeError` fırlatıyordu. Yazma tarafı (u8.set) hatasız çalıştığı
// için sorun yalnız OKUMADA çıkıyordu. Sürüm 2 hizalamayı eleman boyutuna bağlar; eski (v1)
// paketler "eski sürüm" diye reddedilir ve yeniden üretilir.
const MAGIC = 0x5a564c4d; // "MLVZ" (little-endian u32)
export const PACK_VERSION = 2;

interface PackHeader {
  v: number;
  segmentCount: number;
  scannedSegments: number;
  pointCount: number;
  pathCount: number;
  layerCount: number;
  toolCount: number;
  originX: number;
  originY: number;
  scaleXY: number;
  bounds: VizBounds;
  filamentColors: string[];
  fileSize: number;
  thinLevel: number;
  epsilon: number;
}

/** Bir sonraki `a` katına yuvarla (a ikinin kuvveti). Kodlayıcı ve çözücü AYNI işlevi kullanır. */
function alignTo(n: number, a: number): number {
  return (n + a - 1) & ~(a - 1);
}

/** Bölümün gerektirdiği hizalama — TypedArray görünümü bunu şart koşar. */
function sectionAlign(s: ArrayBufferView): number {
  return (s as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
}

/** Paketi tek ArrayBuffer'a yaz (ağdan geçen hâli). */
export function encodeVizPack(p: VizPack): ArrayBuffer {
  const header: PackHeader = {
    v: PACK_VERSION,
    segmentCount: p.segmentCount,
    scannedSegments: p.scannedSegments,
    pointCount: p.pathLen.length ? p.points.length / 2 : 0,
    pathCount: p.pathLen.length,
    layerCount: p.layerZ.length,
    toolCount: p.toolCount,
    originX: p.originX,
    originY: p.originY,
    scaleXY: p.scaleXY,
    bounds: p.bounds,
    filamentColors: p.filamentColors,
    fileSize: p.fileSize,
    thinLevel: p.thinLevel,
    epsilon: p.epsilon,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const sections: ArrayBufferView[] = [
    p.points, p.pathStart, p.pathLen, p.pathFeature, p.pathTool,
    p.layerZ, p.layerPathStart, p.layerPathEnd, p.layerByteOffset,
  ];

  // Başlıktan sonra en büyük eleman boyutuna (8) hizala; her bölüm ayrıca kendi boyutuna hizalanır.
  let offset = alignTo(8 + headerBytes.length, 8);
  const starts: number[] = [];
  for (const s of sections) {
    offset = alignTo(offset, sectionAlign(s));
    starts.push(offset);
    offset += s.byteLength;
  }

  const out = new ArrayBuffer(offset);
  const dv = new DataView(out);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, headerBytes.length, true);
  new Uint8Array(out, 8, headerBytes.length).set(headerBytes);
  const u8 = new Uint8Array(out);
  sections.forEach((s, i) => {
    u8.set(new Uint8Array(s.buffer, s.byteOffset, s.byteLength), starts[i]);
  });
  return out;
}

/** Paketi çöz. Bozuk/eski paket → hata (çağıran ham dosya yoluna düşebilir). */
export function decodeVizPack(buf: ArrayBuffer): VizPack {
  if (buf.byteLength < 8) throw new Error("Görselleştirme paketi bozuk");
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error("Görselleştirme paketi tanınmadı");
  const headerLen = dv.getUint32(4, true);
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headerLen))) as PackHeader;
  if (h.v !== PACK_VERSION) throw new Error("Görselleştirme paketi eski sürüm");

  let off = alignTo(8 + headerLen, 8);
  const take = <T>(ctor: { new (b: ArrayBuffer, o: number, n: number): T; BYTES_PER_ELEMENT: number }, count: number): T => {
    off = alignTo(off, ctor.BYTES_PER_ELEMENT);
    const view = new ctor(buf, off, count);
    off += count * ctor.BYTES_PER_ELEMENT;
    return view;
  };

  const points = take(Uint16Array, h.pointCount * 2);
  const pathStart = take(Uint32Array, h.pathCount);
  const pathLen = take(Uint32Array, h.pathCount);
  const pathFeature = take(Uint8Array, h.pathCount);
  const pathTool = take(Uint8Array, h.pathCount);
  const layerZ = take(Float32Array, h.layerCount);
  const layerPathStart = take(Uint32Array, h.layerCount);
  const layerPathEnd = take(Uint32Array, h.layerCount);
  const layerByteOffset = take(Float64Array, h.layerCount);

  return {
    points, pathStart, pathLen, pathFeature, pathTool,
    layerZ, layerPathStart, layerPathEnd, layerByteOffset,
    originX: h.originX, originY: h.originY, scaleXY: h.scaleXY,
    bounds: h.bounds,
    segmentCount: h.segmentCount,
    scannedSegments: h.scannedSegments,
    toolCount: h.toolCount,
    filamentColors: h.filamentColors ?? [],
    fileSize: h.fileSize,
    thinLevel: h.thinLevel ?? 0,
    epsilon: h.epsilon ?? 0,
  };
}

/** Paketi çizilebilir segment geometrisine aç (worker içinde, ana thread donmaz). */
export function expandPack(p: VizPack): ParsedGcode {
  const segCount = p.segmentCount;
  const positions = new Float32Array(segCount * 6);
  const features = new Uint8Array(segCount);
  const tools = new Uint8Array(segCount);
  const layerRanges: ParsedGcode["layerRanges"] = [];

  const ox = p.originX, oy = p.originY, s = p.scaleXY;
  let seg = 0;
  for (let li = 0; li < p.layerZ.length; li++) {
    const z = p.layerZ[li];
    const start = seg;
    for (let pi = p.layerPathStart[li]; pi < p.layerPathEnd[li]; pi++) {
      const base = p.pathStart[pi];
      const len = p.pathLen[pi];
      const f = p.pathFeature[pi];
      const t = p.pathTool[pi];
      let px = ox + p.points[base * 2] * s;
      let py = oy + p.points[base * 2 + 1] * s;
      for (let k = 1; k < len; k++) {
        const qx = ox + p.points[(base + k) * 2] * s;
        const qy = oy + p.points[(base + k) * 2 + 1] * s;
        const o = seg * 6;
        positions[o] = px; positions[o + 1] = py; positions[o + 2] = z;
        positions[o + 3] = qx; positions[o + 4] = qy; positions[o + 5] = z;
        features[seg] = f;
        tools[seg] = t;
        seg++;
        px = qx; py = qy;
      }
    }
    layerRanges.push({ z, start, end: seg, byteOffset: p.layerByteOffset[li] });
  }

  return {
    positions: seg === segCount ? positions : positions.slice(0, seg * 6),
    features: seg === segCount ? features : features.slice(0, seg),
    tools: seg === segCount ? tools : tools.slice(0, seg),
    layerRanges,
    bounds: p.bounds,
    totalSegments: seg,
    scannedSegments: p.scannedSegments,
    toolCount: p.toolCount,
    filamentColors: p.filamentColors,
    fileSize: p.fileSize,
    thinLevel: p.thinLevel,
  };
}

/**
 * Yazıcının bildirdiği dosya bayt konumunu KATMAN indeksine çevir.
 * Moonraker `virtual_sdcard.file_position` doğrudan buraya verilir.
 * Konum ilk katmandan önceyse 0, dosya sonundaysa son katman döner. Katman yoksa -1.
 */
export function layerAtBytePosition(
  layerByteOffset: ArrayLike<number>,
  filePosition: number,
): number {
  const n = layerByteOffset.length;
  if (n === 0) return -1;
  if (!Number.isFinite(filePosition) || filePosition <= layerByteOffset[0]) return 0;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (layerByteOffset[mid] <= filePosition) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
