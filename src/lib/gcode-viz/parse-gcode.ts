/**
 * Orca-ailesi (OrcaSlicer / Snapmaker Orca / Bambu Studio / Prusa / Cura) gcode → viz-pack.
 *
 * AKIŞ TABANLI: dosya parça parça (`push`) verilir, bellek SABİT kalır. Eski sürümdeki
 * `MAX_SEG = 900_000` tavanı ve `segCount < MAX_SEG` döngü koşulu kaldırıldı — o tavan dolunca
 * ayrıştırma dosyanın ORTASINDA sessizce duruyor, 178 MB'lık bir modelin yalnız alt %17'si
 * çiziliyordu. Artık tavan yerine NOKTA BÜTÇESİ var: bütçe dolunca tarama durmaz, o ana kadar
 * biriken yollar daha büyük toleransla yeniden sadeleştirilir (çözünürlük düşer, model TAM kalır).
 *
 * Ayrıca:
 *  • Aktif araç (`T0`/`T1`/…) izlenir → segment başına araç indeksi (gerçek filament renkleri).
 *  • Katmanın DOSYADAKİ BAYT KONUMU kaydedilir → `virtual_sdcard.file_position` → katman.
 *  • Bayt düzeyinde ayrıştırma (satır başına string üretilmez) — 187 MB'ı tek geçişte tarar.
 */
import {
  FEATURE_INFILL, FEATURE_OTHER, FEATURE_SKIRT, FEATURE_SUPPORT,
  featureCode, expandPack,
  type ParsedGcode, type VizPack,
} from "./viz-pack";

export {
  FEATURE_OUTER, FEATURE_INNER, FEATURE_INFILL, FEATURE_SUPPORT, FEATURE_OTHER,
  FEATURE_SOLID, FEATURE_SKIRT, isBodyFeature, featureCode,
  encodeVizPack, decodeVizPack, expandPack, layerAtBytePosition, PACK_VERSION,
} from "./viz-pack";
export type { ParsedGcode, VizPack, VizBounds } from "./viz-pack";

export interface ScanOptions {
  /**
   * Nokta bütçesi. Aşılırsa model KESİLMEZ — tolerans iki katına çıkar ve biriken yollar
   * yeniden sadeleştirilir. Varsayılan 3 milyon nokta: 178 MB'lık gerçek dosyada 2,07 M segment,
   * 0,08 mm tolerans (ekstrüzyon genişliğinin 1/5'i) ve ~15 MB paket verir.
   */
  maxPoints?: number;
  /** Başlangıç sadeleştirme toleransı (mm). 0.02 mm ≈ kayıpsız (ekstrüzyon genişliği 0.4 mm). */
  epsilon?: number;
  /** Dosya boyutu (bilinmiyorsa taranan bayt sayısı kullanılır). */
  fileSize?: number;
}

/** Dolgu/destek/etek daha kaba sadeleştirilir: bütçe GÖVDEYE ayrılsın. */
const COARSE_FACTOR = 3;

function coarse(feature: number): boolean {
  return feature === FEATURE_INFILL || feature === FEATURE_SUPPORT || feature === FEATURE_SKIRT;
}

/** B noktasının A→C doğrusuna dik uzaklığının karesi (mm²). */
function perpDist2(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const ux = cx - ax, uy = cy - ay;
  const len2 = ux * ux + uy * uy;
  const vx = bx - ax, vy = by - ay;
  if (len2 <= 1e-12) return vx * vx + vy * vy; // A ile C çakışık → B'nin A'ya uzaklığı
  const cross = ux * vy - uy * vx;
  return (cross * cross) / len2;
}

/** ASCII kalıp eşleşmesi — satırı string'e çevirmeden (5 milyon satırda string üretmek pahalı). */
function matchAscii(buf: Uint8Array, s: number, e: number, pat: string): number {
  const n = pat.length;
  if (s + n > e) return -1;
  for (let i = 0; i < n; i++) if (buf[s + i] !== pat.charCodeAt(i)) return -1;
  return s + n;
}

const LATIN = new TextDecoder("utf-8", { fatal: false });

export class GcodeScanner {
  private readonly maxPoints: number;
  private eps: number;
  private epsSq: number;
  private epsSqCoarse: number;
  private thinLevel = 0;
  private declaredFileSize: number;

  // Nokta havuzu (mm, kuantizasyon en sonda)
  private cap = 1 << 18;
  private xs = new Float32Array(this.cap);
  private ys = new Float32Array(this.cap);
  private pointCount = 0;

  // Yol tablosu
  private pathCap = 1 << 15;
  private pathStartArr = new Uint32Array(this.pathCap);
  private pathLenArr = new Uint32Array(this.pathCap);
  private pathFeatArr = new Uint8Array(this.pathCap);
  private pathToolArr = new Uint8Array(this.pathCap);
  private pathCount = 0;

  // Katman tablosu
  private layerCap = 2048;
  private layerZArr = new Float32Array(this.layerCap);
  private layerStartArr = new Uint32Array(this.layerCap);
  private layerEndArr = new Uint32Array(this.layerCap);
  private layerByteArr = new Float64Array(this.layerCap);
  private layerCount = 0;

  // Açık katman
  private curLayerPathStart = 0;
  private curLayerZ = 0;
  private curLayerByte = 0;
  private layerMarkersSeen = 0;
  private sawLayerMarker = false;

  // Açık yol
  private pathOpen = false;
  private curPathStart = 0;
  private curPathFeature = FEATURE_OTHER;
  private curPathTool = 0;
  private anchorX = 0;
  private anchorY = 0;
  private pendX = 0;
  private pendY = 0;
  private hasPend = false;

  // Yazıcı durumu
  private x = 0;
  private y = 0;
  private z = 0;
  private e = 0;
  private absE = true;
  private tool = 0;
  private maxTool = 0;
  private feature = FEATURE_OTHER;

  private minX = Infinity; private maxX = -Infinity;
  private minY = Infinity; private maxY = -Infinity;
  private minZ = Infinity; private maxZ = -Infinity;

  private scannedSegments = 0;
  private filamentColors: string[] = [];

  // Akış tamponu
  private tail = new Uint8Array(0);
  private tailAbs = 0;
  private totalBytes = 0;
  private numEnd = 0;

  constructor(opts?: ScanOptions) {
    this.maxPoints = Math.max(2_000, opts?.maxPoints ?? 3_000_000);
    this.eps = opts?.epsilon ?? 0.02;
    this.epsSq = this.eps * this.eps;
    this.epsSqCoarse = this.epsSq * COARSE_FACTOR * COARSE_FACTOR;
    this.declaredFileSize = opts?.fileSize ?? 0;
  }

  /** Taranan bayt sayısı (ilerleme göstergesi için). */
  get bytesScanned(): number {
    return this.totalBytes;
  }

  /** Bir parça bayt ver. Satır sınırları parçalar arasında korunur. */
  push(chunk: Uint8Array): void {
    let buf: Uint8Array;
    let base: number;
    if (this.tail.length) {
      buf = new Uint8Array(this.tail.length + chunk.length);
      buf.set(this.tail, 0);
      buf.set(chunk, this.tail.length);
      base = this.tailAbs;
    } else {
      buf = chunk;
      base = this.totalBytes;
    }
    this.totalBytes += chunk.length;

    const n = buf.length;
    let lineStart = 0;
    for (let i = 0; i < n; i++) {
      if (buf[i] === 10) {
        this.handleLine(buf, lineStart, i, base + lineStart);
        lineStart = i + 1;
      }
    }
    // Kalan (yarım satır) sonraki parçaya taşınır. Aşırı uzun satır (bozuk dosya) → at.
    if (n - lineStart > 8 * 1024 * 1024) {
      this.tail = new Uint8Array(0);
      this.tailAbs = base + n;
    } else {
      this.tail = buf.slice(lineStart);
      this.tailAbs = base + lineStart;
    }
  }

  /** Taramayı bitir ve kompakt paketi üret. */
  finish(): VizPack {
    if (this.tail.length) {
      this.handleLine(this.tail, 0, this.tail.length, this.tailAbs);
      this.tail = new Uint8Array(0);
    }
    this.closePath();
    if (this.layerMarkersSeen > 0 || this.pathCount > 0) this.pushLayer();

    if (this.pointCount === 0) {
      return {
        points: new Uint16Array(0),
        pathStart: new Uint32Array(0), pathLen: new Uint32Array(0),
        pathFeature: new Uint8Array(0), pathTool: new Uint8Array(0),
        layerZ: new Float32Array(0), layerPathStart: new Uint32Array(0),
        layerPathEnd: new Uint32Array(0), layerByteOffset: new Float64Array(0),
        originX: 0, originY: 0, scaleXY: 1,
        bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 },
        segmentCount: 0, scannedSegments: this.scannedSegments, toolCount: 1,
        filamentColors: this.filamentColors,
        fileSize: this.declaredFileSize || this.totalBytes,
        thinLevel: this.thinLevel, epsilon: this.eps,
      };
    }

    // Kuantizasyon: model sınırlarına göre 16 bit → 260 mm'lik modelde 0.004 mm çözünürlük.
    const spanX = Math.max(1e-3, this.maxX - this.minX);
    const spanY = Math.max(1e-3, this.maxY - this.minY);
    const scaleXY = Math.max(spanX, spanY) / 65535;
    const points = new Uint16Array(this.pointCount * 2);
    for (let i = 0; i < this.pointCount; i++) {
      const qx = Math.round((this.xs[i] - this.minX) / scaleXY);
      const qy = Math.round((this.ys[i] - this.minY) / scaleXY);
      points[i * 2] = qx < 0 ? 0 : qx > 65535 ? 65535 : qx;
      points[i * 2 + 1] = qy < 0 ? 0 : qy > 65535 ? 65535 : qy;
    }

    let segmentCount = 0;
    for (let i = 0; i < this.pathCount; i++) segmentCount += this.pathLenArr[i] - 1;

    return {
      points,
      pathStart: this.pathStartArr.slice(0, this.pathCount),
      pathLen: this.pathLenArr.slice(0, this.pathCount),
      pathFeature: this.pathFeatArr.slice(0, this.pathCount),
      pathTool: this.pathToolArr.slice(0, this.pathCount),
      layerZ: this.layerZArr.slice(0, this.layerCount),
      layerPathStart: this.layerStartArr.slice(0, this.layerCount),
      layerPathEnd: this.layerEndArr.slice(0, this.layerCount),
      layerByteOffset: this.layerByteArr.slice(0, this.layerCount),
      originX: this.minX,
      originY: this.minY,
      scaleXY,
      bounds: {
        minX: this.minX, maxX: this.maxX,
        minY: this.minY, maxY: this.maxY,
        minZ: Number.isFinite(this.minZ) ? this.minZ : 0,
        maxZ: Number.isFinite(this.maxZ) ? this.maxZ : 0,
      },
      segmentCount,
      scannedSegments: this.scannedSegments,
      toolCount: this.maxTool + 1,
      filamentColors: this.filamentColors,
      fileSize: this.declaredFileSize || this.totalBytes,
      thinLevel: this.thinLevel,
      epsilon: this.eps,
    };
  }

  // ── Satır işleme ──────────────────────────────────────────────────────────

  private handleLine(buf: Uint8Array, s: number, eIn: number, abs: number): void {
    let e = eIn;
    if (e > s && buf[e - 1] === 13) e--; // CRLF
    while (s < e && (buf[s] === 32 || buf[s] === 9)) s++;
    if (s >= e) return;
    const b0 = buf[s];

    if (b0 === 59 /* ';' */) { this.handleComment(buf, s, e, abs); return; }
    if (b0 === 71 /* 'G' */) { this.handleG(buf, s, e, abs); return; }
    if (b0 === 77 /* 'M' */) {
      if (matchAscii(buf, s, e, "M82") > 0) this.absE = true;
      else if (matchAscii(buf, s, e, "M83") > 0) this.absE = false;
      return;
    }
    if (b0 === 84 /* 'T' */) {
      const v = this.readNum(buf, s + 1, e);
      // T-1 / T255 = "araç yok" işaretleri; yalnız gerçek kafa indekslerini al.
      if (Number.isFinite(v) && v >= 0 && v < 64) {
        const t = v | 0;
        if (t !== this.tool) {
          this.closePath();
          this.tool = t;
          if (t > this.maxTool) this.maxTool = t;
        }
      }
    }
  }

  private handleComment(buf: Uint8Array, s: number, e: number, abs: number): void {
    // Katman başlangıcı — Orca/Bambu ";LAYER_CHANGE", Prusa "; CHANGE_LAYER", Cura ";LAYER:".
    if (matchAscii(buf, s, e, ";LAYER_CHANGE") > 0 || matchAscii(buf, s, e, "; CHANGE_LAYER") > 0) {
      this.newLayer(this.z, abs, true);
      return;
    }
    let p = matchAscii(buf, s, e, ";LAYER:");
    if (p > 0) { this.newLayer(this.z, abs, true); return; }

    p = matchAscii(buf, s, e, ";Z:");
    if (p > 0) {
      const zv = this.readNum(buf, p, e);
      if (Number.isFinite(zv)) this.setLayerZ(zv);
      return;
    }
    p = matchAscii(buf, s, e, ";TYPE:");
    if (p < 0) p = matchAscii(buf, s, e, "; FEATURE:");
    if (p > 0) {
      const f = featureCode(LATIN.decode(buf.subarray(p, e)));
      if (f !== this.feature) { this.closePath(); this.feature = f; }
      return;
    }
    if (this.filamentColors.length === 0) {
      let c = matchAscii(buf, s, e, "; filament_colour");
      if (c < 0) c = matchAscii(buf, s, e, ";filament_colour");
      if (c < 0) c = matchAscii(buf, s, e, "; filament colour");
      if (c > 0) {
        const eq = LATIN.decode(buf.subarray(c, e));
        const val = eq.slice(eq.indexOf("=") + 1);
        const cols = val.split(";").map((t) => t.trim()).filter((t) => /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(t));
        if (cols.length) this.filamentColors = cols.map((t) => t.slice(0, 7).toUpperCase());
      }
    }
  }

  private handleG(buf: Uint8Array, s: number, e: number, abs: number): void {
    const c1 = buf[s + 1];
    if (c1 !== 48 && c1 !== 49) return; // yalnız G0/G1
    const c2 = buf[s + 2];
    if (c2 >= 48 && c2 <= 57) return; // G10/G17/G92… değil

    let nx = this.x, ny = this.y, nz = this.z, ne = NaN;
    let j = s + 2;
    while (j < e) {
      const ch = buf[j];
      if (ch === 59) break; // satır içi yorum
      if (ch === 88 || ch === 89 || ch === 90 || ch === 69) {
        const v = this.readNum(buf, j + 1, e);
        j = this.numEnd;
        if (Number.isFinite(v)) {
          if (ch === 88) nx = v;
          else if (ch === 89) ny = v;
          else if (ch === 90) nz = v;
          else ne = v;
        }
      } else j++;
    }

    const extruding = Number.isFinite(ne) ? (this.absE ? ne > this.e + 1e-6 : ne > 1e-6) : false;
    if (Number.isFinite(ne)) this.e = this.absE ? ne : this.e + ne;

    if (extruding && (nx !== this.x || ny !== this.y)) {
      // Katman işareti olmayan dosyalar (bazı Cura/legacy çıktıları): Z arttıkça katman aç.
      // Bayrak AÇIK işaretten (";LAYER_CHANGE"/";LAYER:") gelir; bu yedek yol onu SET ETMEZ,
      // yoksa ilk Z artışında kendini kapatır ve dosyanın tamamı tek katmana yığılırdı.
      if (!this.sawLayerMarker && nz !== this.curLayerZ && this.pointCount > 0) this.newLayer(nz, abs, false);
      this.scannedSegments++;
      if (nz < this.minZ) this.minZ = nz;
      if (nz > this.maxZ) this.maxZ = nz;
      if (!this.pathOpen) this.startPath(this.x, this.y);
      this.addPoint(nx, ny);
    } else if (this.pathOpen) {
      this.closePath(); // seyahat/geri çekme → yol biter
    }
    this.x = nx; this.y = ny; this.z = nz;
  }

  /** Bayt dizisinden sayı oku (parseFloat + string dilimi yerine — 5 M satırda fark eder). */
  private readNum(buf: Uint8Array, i: number, e: number): number {
    let j = i;
    let sign = 1;
    if (j < e && (buf[j] === 45 || buf[j] === 43)) { if (buf[j] === 45) sign = -1; j++; }
    let v = 0;
    let seen = false;
    while (j < e) {
      const d = buf[j];
      if (d >= 48 && d <= 57) { v = v * 10 + (d - 48); j++; seen = true; } else break;
    }
    if (j < e && buf[j] === 46) {
      j++;
      let f = 0, scale = 1;
      while (j < e) {
        const d = buf[j];
        if (d >= 48 && d <= 57) { f = f * 10 + (d - 48); scale *= 10; j++; seen = true; } else break;
      }
      v += f / scale;
    }
    this.numEnd = j > i ? j : i + 1; // ilerleme garantisi (sonsuz döngü olmasın)
    return seen ? sign * v : NaN;
  }

  // ── Katman / yol yönetimi ────────────────────────────────────────────────

  /** ";Z:" katman yüksekliğini netleştirir (LAYER_CHANGE anında Z henüz eski değerdedir). */
  private setLayerZ(z: number): void {
    this.curLayerZ = z;
    if (z < this.minZ) this.minZ = z;
    if (z > this.maxZ) this.maxZ = z;
  }

  /** `fromMarker`: dilimleyicinin AÇIK katman yorumundan mı geldi (Z yedeği değil). */
  private newLayer(z: number, byteOffset: number, fromMarker: boolean): void {
    this.closePath();
    if (fromMarker) this.sawLayerMarker = true;
    if (this.layerMarkersSeen === 0) {
      // İlk katman işareti: başlangıç gcode'undaki purge/prime çizgileri katman 0'a KATILIR.
      // Böylece katman sayımız dilimleyicininkiyle (ve yazıcının current_layer'ıyla) 1:1 eşleşir.
      this.curLayerPathStart = 0;
      this.curLayerByte = 0;
      this.curLayerZ = z;
    } else {
      this.pushLayer();
      this.curLayerPathStart = this.pathCount;
      this.curLayerByte = byteOffset;
      this.curLayerZ = z;
    }
    this.layerMarkersSeen++;
  }

  private pushLayer(): void {
    if (this.layerCount >= this.layerCap) {
      this.layerCap *= 2;
      const z = new Float32Array(this.layerCap); z.set(this.layerZArr); this.layerZArr = z;
      const a = new Uint32Array(this.layerCap); a.set(this.layerStartArr); this.layerStartArr = a;
      const b = new Uint32Array(this.layerCap); b.set(this.layerEndArr); this.layerEndArr = b;
      const c = new Float64Array(this.layerCap); c.set(this.layerByteArr); this.layerByteArr = c;
    }
    this.layerZArr[this.layerCount] = this.curLayerZ;
    this.layerStartArr[this.layerCount] = this.curLayerPathStart;
    this.layerEndArr[this.layerCount] = this.pathCount;
    this.layerByteArr[this.layerCount] = this.curLayerByte;
    this.layerCount++;
  }

  private startPath(x: number, y: number): void {
    this.curPathStart = this.pointCount;
    this.curPathFeature = this.feature;
    this.curPathTool = this.tool;
    this.commitPoint(x, y);
    this.anchorX = x; this.anchorY = y;
    this.hasPend = false;
    this.pathOpen = true;
  }

  private addPoint(x: number, y: number): void {
    if (this.hasPend) {
      const epsSq = coarse(this.curPathFeature) ? this.epsSqCoarse : this.epsSq;
      if (perpDist2(this.anchorX, this.anchorY, this.pendX, this.pendY, x, y) <= epsSq) {
        this.pendX = x; this.pendY = y; // ara nokta doğrusal → at
        return;
      }
      this.commitPoint(this.pendX, this.pendY);
      this.anchorX = this.pendX; this.anchorY = this.pendY;
    }
    this.pendX = x; this.pendY = y;
    this.hasPend = true;
    // Tek bir yol havuzu şişirmesin (kapanmadan bütçe kontrolü yapılamaz).
    if (this.pointCount - this.curPathStart > 200_000) {
      const lx = this.pendX, ly = this.pendY;
      this.closePath();
      this.startPath(lx, ly); // kesintisiz devam (görsel olarak fark yok)
    }
  }

  private closePath(): void {
    if (!this.pathOpen) return;
    if (this.hasPend) { this.commitPoint(this.pendX, this.pendY); this.hasPend = false; }
    const len = this.pointCount - this.curPathStart;
    if (len >= 2) {
      if (this.pathCount >= this.pathCap) {
        this.pathCap *= 2;
        const a = new Uint32Array(this.pathCap); a.set(this.pathStartArr); this.pathStartArr = a;
        const b = new Uint32Array(this.pathCap); b.set(this.pathLenArr); this.pathLenArr = b;
        const c = new Uint8Array(this.pathCap); c.set(this.pathFeatArr); this.pathFeatArr = c;
        const d = new Uint8Array(this.pathCap); d.set(this.pathToolArr); this.pathToolArr = d;
      }
      this.pathStartArr[this.pathCount] = this.curPathStart;
      this.pathLenArr[this.pathCount] = len;
      this.pathFeatArr[this.pathCount] = this.curPathFeature;
      this.pathToolArr[this.pathCount] = this.curPathTool;
      this.pathCount++;
    } else {
      this.pointCount = this.curPathStart; // tek noktalı yol → geri al
    }
    this.pathOpen = false;

    // Bütçe kontrolü YALNIZ burada güvenli: açık yol yokken tüm noktalar bir yola aittir.
    let guard = 0;
    while (this.pointCount > this.maxPoints && guard++ < 14) this.thinOnce();
  }

  private commitPoint(x: number, y: number): void {
    if (this.pointCount >= this.cap) {
      this.cap *= 2;
      const nx = new Float32Array(this.cap); nx.set(this.xs); this.xs = nx;
      const ny = new Float32Array(this.cap); ny.set(this.ys); this.ys = ny;
    }
    this.xs[this.pointCount] = x;
    this.ys[this.pointCount] = y;
    this.pointCount++;
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
  }

  /**
   * Bütçe dolunca: toleransı iki katına çıkar ve BİRİKMİŞ yolları yeniden sadeleştir.
   * Hiçbir yol atılmaz (her yol en az ilk+son noktasını korur) → katman aralıkları geçerli kalır,
   * modelin üst kısmı ASLA kaybolmaz. Yalnız çözünürlük düşer.
   */
  private thinOnce(): void {
    this.thinLevel++;
    this.eps *= 2;
    this.epsSq = this.eps * this.eps;
    this.epsSqCoarse = this.epsSq * COARSE_FACTOR * COARSE_FACTOR;

    const xs = this.xs, ys = this.ys;
    let w = 0;
    for (let i = 0; i < this.pathCount; i++) {
      const s = this.pathStartArr[i];
      const len = this.pathLenArr[i];
      const epsSq = coarse(this.pathFeatArr[i]) ? this.epsSqCoarse : this.epsSq;
      const newStart = w;
      let ax = xs[s], ay = ys[s];
      xs[w] = ax; ys[w] = ay; w++;
      let bx = 0, by = 0, hasPend = false;
      for (let k = 1; k < len; k++) {
        const cx = xs[s + k], cy = ys[s + k];
        if (hasPend) {
          if (perpDist2(ax, ay, bx, by, cx, cy) <= epsSq) { bx = cx; by = cy; continue; }
          xs[w] = bx; ys[w] = by; w++;
          ax = bx; ay = by;
        }
        bx = cx; by = cy; hasPend = true;
      }
      if (hasPend) { xs[w] = bx; ys[w] = by; w++; }
      this.pathStartArr[i] = newStart;
      this.pathLenArr[i] = w - newStart; // >= 2 her zaman (ilk + son korunur)
    }
    this.pointCount = w;
  }
}

/**
 * Tek seferde metinden ayrıştır (küçük dosyalar, testler). Büyük dosyalarda `GcodeScanner`
 * akışını kullan — bu sarmalayıcı tüm metni bellekte tutar.
 */
export function scanGcodeText(text: string, opts?: ScanOptions): VizPack {
  const sc = new GcodeScanner({ ...opts, fileSize: opts?.fileSize ?? text.length });
  sc.push(new TextEncoder().encode(text));
  return sc.finish();
}

/** Geriye dönük uyumlu kısa yol: metin → çizilebilir segment geometrisi. */
export function parseGcode(text: string, opts?: ScanOptions): ParsedGcode {
  return expandPack(scanGcodeText(text, opts));
}
