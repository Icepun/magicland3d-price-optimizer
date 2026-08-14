"use client";
/**
 * three.js sahne yapı taşları — izleyici dialogu, thumbnail ve inşa-karesi (sprite) üretimi
 * AYNI sahneyi paylaşır. Çizgi tabanlı (LineSegments) gösterim: milyonlarca segmenti tek çizim
 * çağrısında akıcı çizer; katman ilerletme = drawRange (yeniden geometri üretmeden anlık).
 *
 * İKİ ÖNEMLİ DAVRANIŞ:
 *  • RENK ARAÇTAN GELİR. Segmentler basıldıkları kafaya (T0/T1/…) göre boyanır; renk paleti
 *    dışarıdan verilebilir (yazıcının bildirdiği gerçek filament renkleri). Palet yoksa gcode
 *    başlığındaki renkler, o da yoksa özellik renkleri kullanılır.
 *  • GÖVDE BASKIN. Dolgu, destek ve etek modelin eti değildir: izleyicide soluklaşır, kart
 *    görselinde hiç çizilmez. Aksi hâlde her segment aynı kalınlıkta çizildiği için kare doluluğu
 *    baskı boyunca neredeyse değişmiyor ve ilerleme gözle ayırt edilemiyordu.
 */
import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { ParsedGcode } from "./viz-pack";
import {
  FEATURE_OUTER, FEATURE_INNER, FEATURE_INFILL, FEATURE_SUPPORT, FEATURE_OTHER,
  FEATURE_SOLID, FEATURE_SKIRT, isBodyFeature,
} from "./viz-pack";

/** Palet yokken kullanılan özellik renkleri (koyu zeminde okunur). */
const FEATURE_COLORS: Record<number, [number, number, number]> = {
  [FEATURE_OUTER]: [1.0, 0.52, 0.24],
  [FEATURE_INNER]: [0.95, 0.72, 0.25],
  [FEATURE_SOLID]: [0.98, 0.62, 0.3],
  [FEATURE_INFILL]: [0.34, 0.45, 0.95],
  [FEATURE_SUPPORT]: [0.45, 0.48, 0.55],
  [FEATURE_SKIRT]: [0.4, 0.42, 0.5],
  [FEATURE_OTHER]: [0.62, 0.65, 0.72],
};

/** Özelliğe göre parlaklık — dış duvar en parlak (siluet), dolgu/destek geride kalır. */
const FEATURE_SHADE: Record<number, number> = {
  [FEATURE_OUTER]: 1.0,
  [FEATURE_SOLID]: 0.88,
  [FEATURE_INNER]: 0.76,
  [FEATURE_OTHER]: 0.8,
  [FEATURE_INFILL]: 0.6,
  [FEATURE_SUPPORT]: 0.55,
  [FEATURE_SKIRT]: 0.5,
};

export interface VizPalette {
  /** Araç (kafa) başına gerçek filament rengi "#RRGGBB". Boş/eksik girdi → yedeğe düşer. */
  toolColors?: (string | null | undefined)[];
}

export type VizMode = "viewer" | "card";

export interface VizSceneOptions {
  background?: number | null;
  palette?: VizPalette;
  /** "card": yalnız gövde çizilir (siluet dolumu gözle görülür). "viewer": dolgu/destek soluk. */
  mode?: VizMode;
  /**
   * Dolgu / destek / etek / temizleme kulesi çizilsin mi (yalnız "viewer" modunda anlamlı).
   *
   * ⚠️ VARSAYILAN KAPALI. Açıkken bu parçalar %20 saydamlıkla çiziliyordu ve `depthWrite`
   * açık olduğu için DERİNLİK TAMPONUNA yazıp arkalarındaki GÖVDEYİ siliyorlardı: model
   * "içi görünüyor, hatlar belirsiz" hâle geliyordu. Ölçüldü — kullanıcının dosyalarında
   * segmentlerin %9-21'i yalnız etek/purge.
   *
   * Açıldığında materyal `depthWrite: false`'a düşer; saydam parçalar artık gövdeyi silmez,
   * yalnız üstüne biner.
   */
  showSupport?: boolean;
}

/** "#RRGGBB" → [r,g,b] 0-1. Tanınmazsa null. */
function hexToRgb(hex: string | null | undefined): [number, number, number] | null {
  if (!hex) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/**
 * Sahnenin GERÇEK zemini. Uygulama koyu temaya sabit (layout.tsx `className="dark"`), izleyici
 * `--popover` üzerinde duruyor: oklch(0.225 0.022 265) ≈ #171C26 → bağıl parlaklık 0,0113.
 */
const BG_LUM = 0.0113;
/** Zemine karşı en az bu kontrast oranı (WCAG) sağlanır. */
const MIN_CR = 3.0;

/** sRGB bileşenini ışık şiddetine çevir (WCAG bağıl parlaklık için). */
function dogrusal(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function bagilParlaklik(c: readonly [number, number, number]): number {
  return 0.2126 * dogrusal(c[0]) + 0.7152 * dogrusal(c[1]) + 0.0722 * dogrusal(c[2]);
}

/**
 * Rengi ZEMİNDE OKUNUR hale getirir — ama yalnız GEREKİYORSA.
 *
 * Eskiden sabit bir parlaklık tabanı (0,45) vardı ve rengin kontrastına bakmıyordu: gerçek
 * kırmızı (#FF0000) ekranda pembeye (#FF3D3D), yazıcıdaki kırmızı (#E72F1D) #FF4D3B'ye
 * kayıyordu — u1.gcode'da gövdenin %96,9'u yanlış renkti. Oysa kırmızının koyu zeminle
 * kontrastı zaten 4,28:1, yani sorun yoktu; taban yalnız SİYAHI kurtarmak için konmuştu.
 *
 * Artık ölçüt kontrast: eşiği geçen renge DOKUNULMAZ, geçmeyen (siyah, çok koyu gri) tonunu
 * koruyarak eşiğe kadar açılır. Kapı, FEATURE_SHADE çarpıldıktan SONRA uygulanmalı — yoksa
 * eşiği geçen renk iç duvarda (shade 0,76) yine altına düşer.
 */
function gorunurYap(c: [number, number, number]): [number, number, number] {
  const hedef = MIN_CR * (BG_LUM + 0.05) - 0.05;
  let lo = 0;
  let hi = 1;
  if (bagilParlaklik(c) >= hedef) return c;
  // Beyaza doğru en KÜÇÜK kaydırmayı ikili aramayla bul — ton korunur, gereksiz açılma olmaz.
  for (let i = 0; i < 18; i++) {
    const k = (lo + hi) / 2;
    const deneme: [number, number, number] = [
      c[0] + (1 - c[0]) * k,
      c[1] + (1 - c[1]) * k,
      c[2] + (1 - c[2]) * k,
    ];
    if (bagilParlaklik(deneme) >= hedef) hi = k;
    else lo = k;
  }
  return [c[0] + (1 - c[0]) * hi, c[1] + (1 - c[1]) * hi, c[2] + (1 - c[2]) * hi];
}

/**
 * Özellik × araç renk tablosu — segment döngüsü bunu okur (segment başına hesap yapılmaz).
 * Renk kaynağı sırası: dışarıdan verilen palet → gcode başlığındaki filament renkleri →
 * özellik renkleri.
 */
export function vizColorTable(g: ParsedGcode, opts: VizSceneOptions = {}): { rgb: Float32Array; alpha: Float32Array; toolCount: number } {
  const toolCount = Math.max(1, g.toolCount || 1);
  const features = [FEATURE_OUTER, FEATURE_INNER, FEATURE_INFILL, FEATURE_SUPPORT, FEATURE_OTHER, FEATURE_SOLID, FEATURE_SKIRT];
  const rgb = new Float32Array(7 * toolCount * 3);
  const alpha = new Float32Array(7 * toolCount);
  const card = opts.mode === "card";

  for (let t = 0; t < toolCount; t++) {
    const fromPalette = hexToRgb(opts.palette?.toolColors?.[t]);
    const fromFile = hexToRgb(g.filamentColors?.[t]);
    const base = fromPalette ?? fromFile;
    for (const f of features) {
      const shade = FEATURE_SHADE[f] ?? 0.8;
      // Kontrast kapısı gölge ÇARPILDIKTAN SONRA — yoksa eşiği geçen renk iç duvarda
      // (shade 0,76) yeniden zeminde kaybolurdu. Yedek özellik renkleri zaten okunur seçilmiş.
      const c = base
        ? gorunurYap([base[0] * shade, base[1] * shade, base[2] * shade])
        : ((): [number, number, number] => {
            const y = FEATURE_COLORS[f] ?? FEATURE_COLORS[FEATURE_OTHER];
            return [y[0] * shade, y[1] * shade, y[2] * shade];
          })();
      const i = (f * toolCount + t) * 3;
      rgb[i] = c[0];
      rgb[i + 1] = c[1];
      rgb[i + 2] = c[2];
      // Gövde dışı parçalar (dolgu/destek/etek/purge) VARSAYILAN olarak atılır: alfa 0 →
      // alphaTest eler → derinlik tamponuna da yazmaz. Yalnız kullanıcı açıkça isterse
      // %20 saydamlıkla çizilir.
      alpha[f * toolCount + t] =
        isBodyFeature(f) ? 1 : card || !opts.showSupport ? 0 : 0.2;
    }
  }
  return { rgb, alpha, toolCount };
}

/** Segment başına RGBA (Uint8, normalized) — Float32'ye göre 4 kat az bellek. */
function fillColors(target: Uint8Array, g: ParsedGcode, opts: VizSceneOptions): void {
  const { rgb, alpha, toolCount } = vizColorTable(g, opts);
  const n = g.totalSegments;
  for (let i = 0; i < n; i++) {
    const f = g.features[i];
    const t = g.tools ? Math.min(toolCount - 1, g.tools[i]) : 0;
    const k = f * toolCount + t;
    const r = (rgb[k * 3] * 255) | 0;
    const gg = (rgb[k * 3 + 1] * 255) | 0;
    const b = (rgb[k * 3 + 2] * 255) | 0;
    const a = (alpha[k] * 255) | 0;
    const o = i * 8;
    target[o] = r; target[o + 1] = gg; target[o + 2] = b; target[o + 3] = a;
    target[o + 4] = r; target[o + 5] = gg; target[o + 6] = b; target[o + 7] = a;
  }
}

/**
 * Çerçeveleme sınırları: yalnız GÖVDE segmentlerinden. Dilimleyicinin tabla-kenarı purge/prime
 * çizgisi (tek uzun düz çizgi) tüm bounding-box'ı şişirip modeli köşede minicik bırakıyordu.
 * Gövde yoksa (çok küçük dosya) tüm segmentlerin %2-%98 yüzdeliğine düşer.
 */
function bodyXYBounds(g: ParsedGcode): { minX: number; maxX: number; minY: number; maxY: number } {
  const n = g.totalSegments;
  if (n === 0) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, seen = 0;
  for (let i = 0; i < n; i++) {
    if (!isBodyFeature(g.features[i])) continue;
    seen++;
    const o = i * 6;
    const x1 = g.positions[o], y1 = g.positions[o + 1], x2 = g.positions[o + 3], y2 = g.positions[o + 4];
    if (x1 < minX) minX = x1; if (x1 > maxX) maxX = x1;
    if (x2 < minX) minX = x2; if (x2 > maxX) maxX = x2;
    if (y1 < minY) minY = y1; if (y1 > maxY) maxY = y1;
    if (y2 < minY) minY = y2; if (y2 > maxY) maxY = y2;
  }
  if (seen > 0) return { minX, maxX, minY, maxY };
  const step = Math.max(1, Math.floor((g.positions.length / 3) / 30000));
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < g.positions.length / 3; i += step) { xs.push(g.positions[i * 3]); ys.push(g.positions[i * 3 + 1]); }
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const q = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))];
  return { minX: q(xs, 0.02), maxX: q(xs, 0.98), minY: q(ys, 0.02), maxY: q(ys, 0.98) };
}

export interface VizScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  lines: THREE.LineSegments;
  geometry: THREE.BufferGeometry;
  /** Katman i'ye kadar (dahil) çiz — -1 = hepsi. */
  setLayer: (layerIdx: number) => void;
  /** Gerçek filament renkleri sonradan gelirse (API) paleti değiştir. */
  setPalette: (palette: VizPalette) => void;
  /** Dolgu/destek/etek görünürlüğü — sahne yeniden kurulmadan anlık değişir. */
  setShowSupport: (goster: boolean) => void;
  /**
   * Tuval boyutu değişince ÇAĞRILMALI. Kalın çizgi materyali kalınlığı piksele çevirirken
   * çözünürlüğü kullanır; güncellenmezse çizgiler yanlış kalınlıkta çizilir.
   */
  setResolution: (w: number, h: number) => void;
  layerCount: number;
  dispose: () => void;
}

/**
 * Kalın çizgi BÜTÇESİ. `LineSegments2` her segmenti bir örnek (instance) olarak taşır ve
 * fragment maliyeti kalınlıkla büyür. Gerçek 40 paketin gövde segmenti dağılımı ölçüldü:
 * medyan 80.784, p75 244.148, p90 725.910, en büyük 2.146.023. 600 bin eşiğinde paketlerin
 * ~%15'i ince yedeğe düşer — yani kalın çizgi dosyaların %85'inde devrede olur, ağır
 * dosyalarda kare hızı korunur.
 */
const KALIN_SEGMENT_BUTCESI = 600_000;

interface GovdeKatmani {
  nesne: LineSegments2;
  materyal: LineMaterial;
  geometri: LineSegmentsGeometry;
  /** Katman i'ye kadar (dahil) kaç GÖVDE segmenti var — setLayer bunu kullanır. */
  katmanSonu: Uint32Array;
  toplam: number;
}

/** Gövde segmentlerini ayıklayıp kalın çizgi nesnesi kurar. Bütçe aşılırsa null döner. */
function buildGovdeLines(g: ParsedGcode, colorBytes: Uint8Array): GovdeKatmani | null {
  const n = g.totalSegments;
  let govdeSayisi = 0;
  for (let i = 0; i < n; i++) if (isBodyFeature(g.features[i])) govdeSayisi++;
  if (govdeSayisi === 0 || govdeSayisi > KALIN_SEGMENT_BUTCESI) return null;

  const pos = new Float32Array(govdeSayisi * 6);
  const col = new Float32Array(govdeSayisi * 6);
  const katmanSonu = new Uint32Array(g.layerRanges.length);
  let j = 0;
  let katman = 0;
  for (let i = 0; i < n; i++) {
    // Katman sınırlarını geçerken o ana kadarki gövde sayısını damgala.
    while (katman < g.layerRanges.length && i >= g.layerRanges[katman].end) {
      katmanSonu[katman] = j;
      katman++;
    }
    if (!isBodyFeature(g.features[i])) continue;
    pos.set(g.positions.subarray(i * 6, i * 6 + 6), j * 6);
    const o = i * 8;
    const r = colorBytes[o] / 255, gg = colorBytes[o + 1] / 255, b = colorBytes[o + 2] / 255;
    col[j * 6] = r; col[j * 6 + 1] = gg; col[j * 6 + 2] = b;
    col[j * 6 + 3] = r; col[j * 6 + 4] = gg; col[j * 6 + 5] = b;
    j++;
  }
  while (katman < g.layerRanges.length) katmanSonu[katman++] = j;

  const geometri = new LineSegmentsGeometry();
  geometri.setPositions(pos);
  geometri.setColors(col);

  // Kalınlık DÜNYA BİRİMİNDE (mm) — gerçek şerit genişliği. Ekran birimli olsaydı
  // yakınlaştırınca incelir, uzaklaşınca kalınlaşırdı; parça hiç katı görünmezdi.
  const materyal = new LineMaterial({
    worldUnits: true,
    linewidth: 0.42,
    vertexColors: true,
    dashed: false,
  });
  const nesne = new LineSegments2(geometri, materyal);
  nesne.computeLineDistances();
  return { nesne, materyal, geometri, katmanSonu, toplam: govdeSayisi };
}

/** Kalın nesnenin renklerini `colorBytes`'tan tazeler (palet değişince). */
function govdeRenkleriniTazele(govde: GovdeKatmani, g: ParsedGcode, colorBytes: Uint8Array): void {
  const attr = govde.geometri.getAttribute("instanceColorStart") as THREE.InterleavedBufferAttribute;
  const buf = attr.data.array as Float32Array;
  let j = 0;
  for (let i = 0; i < g.totalSegments; i++) {
    if (!isBodyFeature(g.features[i])) continue;
    const o = i * 8;
    const r = colorBytes[o] / 255, gg = colorBytes[o + 1] / 255, b = colorBytes[o + 2] / 255;
    buf[j * 6] = r; buf[j * 6 + 1] = gg; buf[j * 6 + 2] = b;
    buf[j * 6 + 3] = r; buf[j * 6 + 4] = gg; buf[j * 6 + 5] = b;
    j++;
  }
  attr.data.needsUpdate = true;
}

/** Gövde segmentlerinin alfasını ince nesnede sıfırlar — kalın nesne onları zaten çiziyor. */
function govdeyiInceNesnedenGizle(g: ParsedGcode, colorBytes: Uint8Array): void {
  for (let i = 0; i < g.totalSegments; i++) {
    if (!isBodyFeature(g.features[i])) continue;
    colorBytes[i * 8 + 3] = 0;
    colorBytes[i * 8 + 7] = 0;
  }
}

export function buildVizScene(g: ParsedGcode, opts?: VizSceneOptions): VizScene {
  const options: VizSceneOptions = { mode: "viewer", ...opts };
  const scene = new THREE.Scene();
  if (options.background != null) scene.background = new THREE.Color(options.background);

  const segCount = g.totalSegments;
  const colorBytes = new Uint8Array(segCount * 8);
  fillColors(colorBytes, g, options);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(g.positions, 3));
  const colorAttr = new THREE.BufferAttribute(colorBytes, 4, true);
  geometry.setAttribute("color", colorAttr);

  // alphaTest: alfası 0 olan (kartta dolgu/destek) parçalar TAMAMEN atılır — derinlik tamponuna da
  // yazmaz, yoksa görünmez çizgiler gövdeyi kapatırdı.
  // ⚠️ depthWrite: saydam yardımcı parçalar AÇIKKEN kapatılır.
  //
  // Açık bırakılırsa %20 alfalı bir dolgu/destek çizgisi DERİNLİK TAMPONUNA yazıyor ve
  // arkasındaki KATI gövdeyi siliyor: model "içi boş, hatları belirsiz" görünüyordu.
  // Ölçülen ana sebep buydu. Kapalıyken (varsayılan) o parçalar zaten alphaTest ile
  // eleniyor, dolayısıyla derinlik yazımı gövde için AÇIK kalabiliyor — gövdenin kendi
  // arka duvarları öne geçmiyor.
  const saydamYardimcilar = options.mode !== "card" && options.showSupport === true;
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: options.mode !== "card",
    alphaTest: 0.02,
    depthWrite: !saydamYardimcilar,
  });
  const lines = new THREE.LineSegments(geometry, material);

  /**
   * KALIN GÖVDE — modelin katı bir cisim gibi görünmesini sağlayan katman.
   *
   * `LineBasicMaterial` çizgileri her zaman 1px'dir (WebGL'de linewidth desteklenmez), bu
   * yüzden model bir tel kafes / çizgi yumağı gibi duruyordu ("hala çok kötü durumda").
   * `LineSegments2` dünya birimli kalınlık verir: vuruş gerçek şerit genişliğine ölçeklenince
   * komşu yollar birleşir ve dolu bir yüzey çıkar.
   *
   * YALNIZ GÖVDE segmentleri buraya girer. Sebep teknik: `LineSegmentsGeometry.setColors`
   * yalnız RGB taşır, alfa taşımaz — dolgu/destek/etek görünürlüğü alfayla yönetildiği için
   * onlar eski ince nesnede kalır (alphaTest yolu aynen çalışır, derinlik sorunu doğmaz).
   */
  const govde = options.mode === "card" ? null : buildGovdeLines(g, colorBytes);

  const { minZ } = g.bounds;
  const rb = bodyXYBounds(g);
  const cx = (rb.minX + rb.maxX) / 2, cy = (rb.minY + rb.maxY) / 2;
  const group = new THREE.Group();
  lines.position.set(-cx, -cy, -minZ); // modeli GERÇEK merkezine göre ortala
  group.add(lines);
  if (govde) {
    govde.nesne.position.copy(lines.position);
    group.add(govde.nesne);
    // Gövde artık KALIN nesnede çiziliyor → ince nesnede SÖNDÜRÜLÜR (alfa 0, alphaTest eler).
    // Yoksa aynı yollar iki kez çizilir, ince çizgi kalının üstünde tel kafes izi bırakırdı.
    govdeyiInceNesnedenGizle(g, colorBytes);
  }

  /**
   * HAYALET — henüz BASILMAMIŞ kısım. Kullanıcı "process'i iyi göstersin" dedi: eskiden
   * geçerli katmanın üstü hiç çizilmiyordu, yani parçanın nereye varacağı görünmüyordu.
   * Artık kalan kısım çok soluk bir taslak olarak duruyor; basılan yer dolu ve renkli,
   * kalan yer hayalet → ilerleme tek bakışta okunuyor.
   *
   * Geometri PAYLAŞILIR (aynı BufferAttribute'lar) — yalnız `drawRange` ayrıdır, ek bellek yok.
   * `vertexColors: false`: ince tampondaki gövde alfası söndürülmüş durumda, hayalet onu
   * kullanmaz; düz ve nötr bir renkle çizilir.
   */
  const hayaletGeo = new THREE.BufferGeometry();
  hayaletGeo.setAttribute("position", geometry.getAttribute("position"));
  const hayaletMat = new THREE.LineBasicMaterial({
    color: 0x8fa3c8,
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
  });
  const hayalet = new THREE.LineSegments(hayaletGeo, hayaletMat);
  hayalet.position.copy(lines.position);
  hayalet.visible = false; // yalnız katman kesildiğinde (canlı/oynatma) anlamlı
  hayaletGeo.setDrawRange(0, 0);
  if (options.mode !== "card") group.add(hayalet);
  group.rotation.x = -Math.PI / 2;
  scene.add(group);

  // Tabla ızgarası (hafif) — gövde span'ine göre.
  const spanX = Math.max(10, rb.maxX - rb.minX), spanY = Math.max(10, rb.maxY - rb.minY);
  const gridSize = Math.ceil(Math.max(spanX, spanY) * 1.4 / 10) * 10;
  const grid = new THREE.GridHelper(gridSize, Math.max(6, Math.round(gridSize / 10)), 0x475069, 0x2a3042);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.3;
  scene.add(grid);

  // Kamera: izometrik açı. Faktör 0.72 (kanıtlanmış, kırpmaz).
  const spanZ = Math.max(5, g.bounds.maxZ - minZ);
  const radius = Math.max(spanX, spanY, spanZ) * 0.72;
  const camera = new THREE.PerspectiveCamera(38, 1, 0.5, radius * 20);
  camera.position.set(radius * 1.5, radius * 1.25, radius * 1.5);
  camera.lookAt(0, spanZ * 0.32, 0);

  const setLayer = (layerIdx: number) => {
    if (layerIdx < 0 || layerIdx >= g.layerRanges.length) {
      geometry.setDrawRange(0, segCount * 2);
      // LineSegments2 örneklenmiş geometridir: drawRange değil instanceCount ile kesilir.
      if (govde) govde.geometri.instanceCount = govde.toplam;
      hayalet.visible = false; // hepsi basılmış → gösterilecek "kalan" yok
    } else {
      const son = g.layerRanges[layerIdx].end;
      geometry.setDrawRange(0, son * 2); // segment → 2 vertex
      if (govde) govde.geometri.instanceCount = govde.katmanSonu[layerIdx];
      // Kalan kısım: bu katmanın sonundan dosyanın sonuna kadar.
      const kalan = segCount - son;
      hayalet.visible = kalan > 0;
      hayaletGeo.setDrawRange(son * 2, kalan * 2);
    }
  };

  /** Palet ve yardımcı-parça görünürlüğü AYNI yoldan tazelenir: sahne yeniden kurulmaz. */
  let aktifPalet: VizPalette | undefined = options.palette;
  let yardimcilarAcik = options.showSupport === true;

  const yenidenBoya = () => {
    fillColors(colorBytes, g, {
      ...options,
      palette: aktifPalet,
      showSupport: yardimcilarAcik,
    });
    if (govde) {
      govdeRenkleriniTazele(govde, g, colorBytes);
      govdeyiInceNesnedenGizle(g, colorBytes);
    }
    colorAttr.needsUpdate = true;
    // Saydam parçalar görünürken derinlik yazımı kapanmalı (bkz. materyal kurulumundaki not).
    material.depthWrite = !(options.mode !== "card" && yardimcilarAcik);
    material.needsUpdate = true;
  };

  const setPalette = (palette: VizPalette) => {
    aktifPalet = palette;
    yenidenBoya();
  };

  const setShowSupport = (goster: boolean) => {
    if (yardimcilarAcik === goster) return;
    yardimcilarAcik = goster;
    yenidenBoya();
  };

  const setResolution = (w: number, h: number) => {
    govde?.materyal.resolution.set(Math.max(1, w), Math.max(1, h));
  };

  return {
    scene, camera, lines, geometry, setLayer, setPalette, setShowSupport, setResolution,
    layerCount: g.layerRanges.length,
    dispose: () => {
      geometry.dispose();
      material.dispose();
      govde?.geometri.dispose();
      govde?.materyal.dispose();
      // hayaletGeo öznitelikleri PAYLAŞIYOR — dispose yalnız kendi kaydını siler, veriyi değil.
      hayaletGeo.dispose();
      hayaletMat.dispose();
      (grid.material as THREE.Material).dispose();
      grid.geometry.dispose();
    },
  };
}

// PAYLAŞILAN offscreen renderer — her çağrıda yeni WebGL context YARATMAK pahalıdır ve tarayıcı
// context sayısını (~16) sınırlar. Üretim zaten SERİ olduğundan tek renderer güvenle kullanılır.
let sharedRenderer: THREE.WebGLRenderer | null = null;
let sharedCanvas: HTMLCanvasElement | null = null;
function getSharedRenderer(size: number): THREE.WebGLRenderer | null {
  try {
    if (!sharedRenderer) {
      sharedCanvas = document.createElement("canvas");
      sharedRenderer = new THREE.WebGLRenderer({ canvas: sharedCanvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      sharedRenderer.setClearColor(0x000000, 0);
    }
    sharedCanvas!.width = size; sharedCanvas!.height = size;
    sharedRenderer.setSize(size, size, false);
    return sharedRenderer;
  } catch {
    return null; // WebGL yoksa görselsiz devam
  }
}

/** Offscreen tek kare (thumbnail) — PNG data URL. Paylaşılan renderer, sahne dispose edilir. */
export function renderThumbnail(g: ParsedGcode, size = 512, palette?: VizPalette): string | null {
  const renderer = getSharedRenderer(size);
  if (!renderer) return null;
  const viz = buildVizScene(g, { background: null, mode: "card", palette });
  viz.camera.aspect = 1;
  viz.camera.updateProjectionMatrix();
  try {
    viz.setLayer(-1);
    renderer.render(viz.scene, viz.camera);
    return renderer.domElement.toDataURL("image/png");
  } finally {
    viz.dispose(); // renderer paylaşımlı — dispose ETME
  }
}

/** İnşa kareleri: N aşamada küçük WEBP kareleri — kartta canlı dolum için. Kareler arasında
 *  BOŞTA bekleyip (yield) arayüzü bloke etmez; paylaşılan renderer kullanır. */
export async function renderBuildFrames(
  g: ParsedGcode,
  frameCount = 24,
  size = 240,
  yieldFn?: () => Promise<void>,
  palette?: VizPalette,
): Promise<Blob[]> {
  const renderer = getSharedRenderer(size);
  if (!renderer) return [];
  const canvas = renderer.domElement as HTMLCanvasElement;
  const blobs: Blob[] = [];
  const viz = buildVizScene(g, { background: null, mode: "card", palette });
  viz.camera.aspect = 1;
  viz.camera.updateProjectionMatrix();
  try {
    const layers = Math.max(1, viz.layerCount);
    for (let k = 1; k <= frameCount; k++) {
      const layerIdx = Math.min(layers - 1, Math.ceil((k / frameCount) * layers) - 1);
      viz.setLayer(layerIdx);
      renderer.render(viz.scene, viz.camera);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/webp", 0.8));
      if (!blob) return [];
      blobs.push(blob);
      if (yieldFn) await yieldFn(); // her kareden sonra arayüze nefes aldır
    }
    return blobs;
  } finally {
    viz.dispose();
  }
}
