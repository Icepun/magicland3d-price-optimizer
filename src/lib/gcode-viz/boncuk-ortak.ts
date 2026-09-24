"use client";
/**
 * BONCUK ÇİZİCİSİNİN ORTAK PARÇALARI — 3B izleyici (`bead-scene.ts`) ve yazıcı kartı
 * (`kart-sahne.ts`) AYNI şerit şablonunu, şader yamasını, renk kuralını, ışığı, tablayı ve
 * nozulu kullanır. Görünüm tek yerden değişsin: kart ile izleyici birbirinden kopmasın.
 *
 * Neden katı şerit (boncuk) çiziliyor, kumlanma ve opak taslak tuzakları: bkz. bead-scene.ts ve
 * hafıza notu gcode-render-research.
 */
import * as THREE from "three";
import {
  FEATURE_OUTER, FEATURE_INNER, FEATURE_INFILL, FEATURE_SUPPORT, FEATURE_OTHER,
  FEATURE_SOLID, FEATURE_SKIRT, isBodyFeature,
} from "./viz-pack";
import { hexToRgb, type VizPalette } from "./three-scene";

/**
 * Şader sürümü. Şader metnini değiştirirsen ARTIR: three derlenmiş programı bu anahtarla
 * önbellekten verir, artırılmazsa yama ekrana hiç ulaşmaz ([[improvement-never-reaches-screen]]).
 */
export const BONCUK_SADER_SURUMU = "boncuk-v2";

/** Şerit genişliği (mm) — 0,4 mm nozulun tipik çizgi genişliği. Pakette genişlik taşınmıyor. */
export const BONCUK_GENISLIK = 0.42;

/** Segment bayrakları (renk dizisinin 4. baytı). */
export const BAYRAK_KATI = 1;
export const BAYRAK_HAYALET = 2;

/** Yan yüz normallerinin dikey payı (0 = tamamen yatay) — bkz. KOSE_NORMALI. */
export const YAN_EGIM = 0.35;

/** Parlayan izin taşıyabileceği en fazla segment (hale tamponu). */
export const HALE_KAPASITE = 2048;

/** Sıcak plastiğin rengi (parıltı ve katı şeritteki ışıma). */
export const SICAK_RENK = 0xff9a4a;

/** Filament rengi bilinmiyorsa dilimleyicinin "özellik türü" renkleri (sRGB 0-1). */
const OZELLIK_RENGI: Record<number, readonly [number, number, number]> = {
  [FEATURE_OUTER]: [1.0, 0.49, 0.22],
  [FEATURE_INNER]: [1.0, 0.86, 0.55],
  [FEATURE_SOLID]: [0.62, 0.36, 0.82],
  [FEATURE_INFILL]: [0.72, 0.22, 0.2],
  [FEATURE_SUPPORT]: [0.55, 0.6, 0.66],
  [FEATURE_SKIRT]: [0.5, 0.54, 0.6],
  [FEATURE_OTHER]: [0.76, 0.78, 0.82],
};

/**
 * Filament rengi varken özelliğe göre hafif ton farkı. Işık şekli zaten okutuyor; bu yalnız
 * kesit yüzeyinde (basılan katmanın üstü) duvar, dolgu ve yüzeyin ayırt edilmesi için.
 */
const OZELLIK_TONU: Record<number, number> = {
  [FEATURE_OUTER]: 1.0,
  [FEATURE_SOLID]: 0.96,
  [FEATURE_OTHER]: 0.95,
  [FEATURE_INNER]: 0.9,
  [FEATURE_INFILL]: 0.8,
};

/** Destek ve etek AÇIKKEN kullanılan nötr renk — modelin önüne geçmesin. */
const YARDIMCI_RENK: readonly [number, number, number] = [0.55, 0.6, 0.66];

/**
 * Çok koyu filamenti (siyah) okunur bir kömür grisine kaldırır. Işıklı sahnede siyah plastik
 * tamamen yutulmuyor ama koyu tablada kayboluyor; dilimleyiciler de siyahı #333 civarı çizer.
 * Ton korunur: renge yalnız gri eklenir.
 */
export function okunurRenk(c: readonly [number, number, number]): [number, number, number] {
  const m = Math.max(c[0], c[1], c[2]);
  if (m >= 0.2) return [c[0], c[1], c[2]];
  const k = 0.2 - m;
  return [c[0] + k, c[1] + k, c[2] + k];
}

/**
 * Katman yüksekliği (mm): ardışık katmanların Z farklarının ortancası. Değişken katman
 * yüksekliği ve ilk katmanın kalınlığı ortancayı bozmaz. Bulunamazsa 0,2.
 */
export function katmanKalinligiZ(zler: ArrayLike<number>): number {
  const farklar: number[] = [];
  for (let i = 1; i < zler.length; i++) {
    const d = zler[i] - zler[i - 1];
    if (d > 0.01 && d < 1.2) farklar.push(d);
  }
  if (farklar.length === 0) {
    const z0 = zler.length ? zler[0] : undefined;
    return z0 != null && z0 > 0.05 && z0 < 0.6 ? z0 : 0.2;
  }
  farklar.sort((a, b) => a - b);
  return Math.min(0.6, Math.max(0.05, farklar[Math.floor(farklar.length / 2)]));
}

export function katmanKalinligi(layerRanges: readonly { z: number }[]): number {
  return katmanKalinligiZ(layerRanges.map((l) => l.z));
}

/**
 * Baştaki (o an basılan) segment: p = 5,3 → 5. segment %30'da; p = 5 → 4. segment BİTMİŞ.
 * Tam sayıda bir sonraki segmente geçilmez — katman sonuna kilitlenen görünüm yan katmanın
 * ilk şeridini göstermesin.
 */
export function bastakiSegment(p: number): number {
  return Math.max(0, Math.ceil(p) - 1);
}

/**
 * Nozulun oturacağı segment: `k` ya da ondan önceki son GÖRÜNEN segment; hiç yoksa -1.
 *
 * Temizleme kulesi, destek ve etek varsayılan olarak çizilmiyor. Yazıcı onları basarken nozul
 * boşlukta, modelden kopuk duruyordu (çok renkli baskıda her renk değişiminde). O sırada nozul
 * modelde son basılan noktada bekler.
 */
export function gorunenBas(bayraklar: Uint8Array, k: number, sinir = 50_000): number {
  const alt = Math.max(0, k - sinir);
  for (let i = k; i >= alt; i--) if (bayraklar[i * 4 + 3] & BAYRAK_KATI) return i;
  return -1;
}

/**
 * Özellik × araç renk + bayrak tablosu (RGBA, 8 bit): indeks `(özellik * araçSayısı + araç) * 4`.
 * RGB sRGB'dir (şader doğrusala çevirir), A bayrak: bit0 = katı çizilir, bit1 = kalan kısmın
 * taslağında görünür (dış kabuk ve yüzeyler).
 *
 * Renk sırası: dışarıdan verilen palet (yazıcının bildirdiği gerçek filament) → gcode başlığındaki
 * filament rengi → özellik rengi. Destek ve etek varsayılan olarak ÇİZİLMEZ.
 */
export function renkTablosu(
  toolCountHam: number,
  filamentColors: readonly string[] | undefined,
  secenek: { palette?: VizPalette; showSupport?: boolean } = {},
): { tablo: Uint8Array; toolCount: number } {
  const toolCount = Math.max(1, toolCountHam || 1);
  const ozellikler = [FEATURE_OUTER, FEATURE_INNER, FEATURE_INFILL, FEATURE_SUPPORT, FEATURE_OTHER, FEATURE_SOLID, FEATURE_SKIRT];
  const tablo = new Uint8Array(7 * toolCount * 4);
  for (let t = 0; t < toolCount; t++) {
    const taban = hexToRgb(secenek.palette?.toolColors?.[t]) ?? hexToRgb(filamentColors?.[t]);
    for (const f of ozellikler) {
      const yardimci = f === FEATURE_SUPPORT || f === FEATURE_SKIRT;
      let c: [number, number, number];
      if (yardimci) c = [YARDIMCI_RENK[0], YARDIMCI_RENK[1], YARDIMCI_RENK[2]];
      else if (taban) {
        const ton = OZELLIK_TONU[f] ?? 0.9;
        c = okunurRenk([taban[0] * ton, taban[1] * ton, taban[2] * ton]);
      } else {
        const r = OZELLIK_RENGI[f] ?? OZELLIK_RENGI[FEATURE_OTHER];
        c = [r[0], r[1], r[2]];
      }
      const kati = isBodyFeature(f) || f === FEATURE_INFILL || (yardimci && secenek.showSupport === true);
      const hayalet = f === FEATURE_OUTER || f === FEATURE_SOLID;
      const o = (f * toolCount + t) * 4;
      tablo[o] = Math.round(Math.min(1, Math.max(0, c[0])) * 255);
      tablo[o + 1] = Math.round(Math.min(1, Math.max(0, c[1])) * 255);
      tablo[o + 2] = Math.round(Math.min(1, Math.max(0, c[2])) * 255);
      tablo[o + 3] = (kati ? BAYRAK_KATI : 0) | (hayalet ? BAYRAK_HAYALET : 0);
    }
  }
  return { tablo, toolCount };
}

/** Tablodan tek segmentin rengini hedef diziye yaz (özellik 0-6, araç sınırlı). */
export function renkYaz(
  tablo: Uint8Array, toolCount: number, ozellik: number, arac: number, hedef: Uint8Array, o: number,
): void {
  const k = (Math.min(6, ozellik) * toolCount + Math.min(toolCount - 1, arac)) * 4;
  hedef[o] = tablo[k];
  hedef[o + 1] = tablo[k + 1];
  hedef[o + 2] = tablo[k + 2];
  hedef[o + 3] = tablo[k + 3];
}

/**
 * Kesitin yüzleri — köşeler +y'den +z'ye doğru (saat yönünün tersi) dizili. Her yüzün iki
 * kenarının normali ayrı: yan yüzlerde üst kenar hafif yukarı, alt kenar hafif aşağı bakar
 * (dikey pay şaderde `uYanEgim` ile kısılır); üst ve alt yüzler düz.
 */
const KESIT_YUZLERI: readonly {
  p: readonly [number, number]; q: readonly [number, number];
  np: readonly [number, number]; nq: readonly [number, number];
}[] = [
  { p: [0.5, -0.5], q: [0.5, 0.5], np: [1, -1], nq: [1, 1] }, // sağ yan
  { p: [0.5, 0.5], q: [-0.5, 0.5], np: [0, 1], nq: [0, 1] }, // üst
  { p: [-0.5, 0.5], q: [-0.5, -0.5], np: [-1, 1], nq: [-1, -1] }, // sol yan
  { p: [-0.5, -0.5], q: [0.5, -0.5], np: [0, -1], nq: [0, -1] }, // alt
];

/**
 * Tek bir şeridin şablonu: x ekseni boyunca 0→1 uzanan, dikdörtgen kesitli açık uçlu prizma.
 * Kesit ±0,5'e ölçekli; şader genişlik ve katman yüksekliğiyle çarpınca şerit katmanı tam doldurur.
 *
 * NEDEN KUTU (altıgen değil): uzaktan bir katman pikselden ince kalıyor. Altıgenin eğimli üst ve
 * alt yüzleri aynı katmanda iki ayrı ton veriyor, her piksel rastgele birine düşüyor ve duvar
 * KUMLU görünüyordu (209 mm'lik ahtapotta ölçüldü). Kutunun yan yüzü katman boyunca neredeyse
 * tek tonda; basamaklanan eğimlerde üst yüzler ışık alıyor — şekli okutan tam da bu.
 * Uç kapağı yok: şader her şeridi iki uçtan yarım genişlik uzatıp komşusuna bindirir.
 */
export function boncukSablonu(): THREE.BufferGeometry {
  const yuzSayisi = KESIT_YUZLERI.length;
  const konum = new Float32Array(yuzSayisi * 4 * 3);
  const normal = new Float32Array(yuzSayisi * 4 * 3);
  const index: number[] = [];
  KESIT_YUZLERI.forEach((y, i) => {
    const koseler = [
      [0, y.p, y.np], [0, y.q, y.nq], [1, y.p, y.np], [1, y.q, y.nq],
    ] as const;
    koseler.forEach(([x, k, n], j) => {
      const o = (i * 4 + j) * 3;
      konum[o] = x;
      konum[o + 1] = k[0];
      konum[o + 2] = k[1];
      normal[o] = 0;
      normal[o + 1] = n[0];
      normal[o + 2] = n[1];
    });
    const a = i * 4, b = a + 1, c = a + 2, d = a + 3;
    // Dışarıdan bakınca saat yönünün tersi → ön yüz (FrontSide ile arka yüzler elenir).
    index.push(a, b, c, b, d, c);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(konum, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geo.setIndex(index);
  return geo;
}

// ── Şader yamaları ─────────────────────────────────────────────────────────────
// Standart materyallerin (ışık, gölge, ton eşleme) TAMAMI kullanılır; yalnız köşenin nereye
// konduğu ve rengi değişir. Üç çeşit: KATI (basılan kısım), HAYALET (kalan kısmın taslağı),
// HALE (son basılan şeridin sıcak parıltısı). Gölge geçişi de aynı köşe kodunu kullanır.

/**
 * `invariant gl_Position` — TASLAK iki geçişte çiziliyor: önce yalnız derinlik, sonra renk YALNIZ
 * derinliği birebir EŞİT yüzeye (`EqualDepth`). İki geçiş AYRI şader programı; derleyici aynı köşe
 * kodunu iki programda farklı sırayla hesaplarsa son bitte ayrışan derinlik eşitlik testini düşürür
 * ve taslak delik deşik çizilir. `invariant` iki programda aynı sonucu GARANTİ eder (bugünkü
 * masaüstü ve iOS Safari'de sorun görülmedi; farklı GPU sürücüleri için sigorta).
 */
export const KOSE_TANIMLARI = /* glsl */ `
invariant gl_Position;
attribute vec3 iStart;
attribute vec3 iEnd;
attribute vec4 iColor;
uniform float uBeadW;
uniform float uBeadH;
uniform float uHeadIndex;
uniform float uHeadFrac;
uniform float uHotSpan;
uniform float uYanEgim;
varying vec4 vBead;
`;

/**
 * Normal: şablon normalini şeridin eksenine oturt. Uzunluk ekseni normalde yok, o ölçek önemsiz.
 *
 * YAN YÜZLER NEREDEYSE YATAY (`uYanEgim`): uzaktan bakınca bir katman pikselden ince kalıyor
 * (209 mm'lik parçada ~3 katman/piksel). Şeridin eğimli üst ve alt yüzleri farklı aydınlanınca
 * her piksel rastgele birine düşüyor ve duvar KUMLU görünüyordu. Yan normallerin dikey payı
 * kısılınca duvar tek tonda okunur; yakından bakınca katman çizgileri hâlâ seçilir. Üst ve alt
 * yüzlerin normali dik kalır: parçanın tepesi ve basamaklanan eğimler ışık alsın.
 */
export const KOSE_NORMALI = /* glsl */ `
vec3 nEksen = iEnd - iStart;
nEksen = length( nEksen ) > 1e-6 ? normalize( nEksen ) : vec3( 1.0, 0.0, 0.0 );
vec3 nYan = normalize( cross( vec3( 0.0, 0.0, 1.0 ), nEksen ) );
float nDik = abs( normal.y ) > 0.5 ? normal.z * uYanEgim : normal.z;
vec3 objectNormal = normalize( nYan * normal.y + vec3( 0.0, 0.0, 1.0 ) * nDik );
`;

/**
 * Konum: şerit `iStart`'tan `iEnd`'e, üst yüzü gcode Z'sinde (nozul yüksekliği = katmanın üstü).
 * Gizlenen örnek tek noktaya çökertilir → üçgenleri alansız kalır, çizilmez.
 */
export const KOSE_KONUMU = /* glsl */ `
vec3 bEksen = iEnd - iStart;
float bUzun = length( bEksen );
bEksen = bUzun > 1e-6 ? bEksen / bUzun : vec3( 1.0, 0.0, 0.0 );
vec3 bYan = normalize( cross( vec3( 0.0, 0.0, 1.0 ), bEksen ) );
float bSira = float( gl_InstanceID );
float bBayrak = floor( iColor.a * 255.0 + 0.5 );
#if defined( BONCUK_HAYALET )
  bool bGoster = mod( floor( bBayrak / 2.0 ), 2.0 ) > 0.5 && bSira > uHeadIndex;
  float bPay = 1.0;
#elif defined( BONCUK_HALE )
  bool bGoster = iColor.a > 0.002;
  float bPay = 1.0;
#else
  bool bGoster = mod( bBayrak, 2.0 ) > 0.5;
  float bPay = bSira >= uHeadIndex ? uHeadFrac : 1.0;
#endif
float bUc = uBeadW * 0.5;
vec3 transformed = iStart
  + bEksen * ( position.x * ( bUzun * bPay + 2.0 * bUc ) - bUc )
  + bYan * ( position.y * uBeadW )
  + vec3( 0.0, 0.0, position.z * uBeadH - 0.5 * uBeadH );
if ( !bGoster ) transformed = iStart;
float bSicak = 0.0;
#if defined( BONCUK_HALE )
  bSicak = iColor.a;
#elif !defined( BONCUK_HAYALET )
  if ( uHotSpan > 0.0 ) bSicak = clamp( 1.0 - ( uHeadIndex + uHeadFrac - bSira ) / uHotSpan, 0.0, 1.0 );
#endif
vBead = vec4( iColor.rgb, bSicak );
#ifdef USE_ALPHAHASH
  vPosition = vec3( position );
#endif
`;

const PARCA_TANIMLARI = /* glsl */ `
varying vec4 vBead;
uniform vec3 uHotColor;
`;

/** three'nin şablon metinleri — biri değişirse yama SESSİZCE çalışmaz; test bunları kilitliyor. */
export const YAMA_NOKTALARI = {
  ortak: "#include <common>",
  normal: "#include <beginnormal_vertex>",
  konum: "#include <begin_vertex>",
  renk: "vec4 diffuseColor = vec4( diffuse, opacity );",
  isima: "#include <emissivemap_fragment>",
} as const;

export type BoncukTuru = "kati" | "hayalet" | "hayalet-derinlik" | "hale" | "derinlik";

/** Bir boncuk materyalinin okuduğu uniform'lar. Aynı nesneyi paylaşan materyaller birlikte değişir. */
export interface BoncukUniformlari {
  uBeadW: THREE.IUniform<number>;
  uBeadH: THREE.IUniform<number>;
  uHeadIndex: THREE.IUniform<number>;
  uHeadFrac: THREE.IUniform<number>;
  uHotSpan: THREE.IUniform<number>;
  uYanEgim: THREE.IUniform<number>;
  uHotColor: THREE.IUniform<THREE.Color>;
  [ad: string]: THREE.IUniform;
}

export function boncukUniformlari(
  W: number, H: number, bas: number, sicakRenk?: THREE.IUniform<THREE.Color>, yanEgim?: THREE.IUniform<number>,
): BoncukUniformlari {
  return {
    uBeadW: { value: W },
    uBeadH: { value: H },
    uHeadIndex: { value: bas },
    uHeadFrac: { value: 1 },
    uHotSpan: { value: 0 },
    uYanEgim: yanEgim ?? { value: YAN_EGIM },
    uHotColor: sicakRenk ?? { value: new THREE.Color(SICAK_RENK) },
  };
}

/** Standart three materyalini boncuk şaderine çevirir. */
export function boncukYamala(materyal: THREE.Material, tur: BoncukTuru, uniforms: BoncukUniformlari): void {
  const tanim: Record<string, string> = {};
  if (tur === "hayalet" || tur === "hayalet-derinlik") tanim.BONCUK_HAYALET = "";
  if (tur === "hale") tanim.BONCUK_HALE = "";
  materyal.defines = { ...(materyal.defines ?? {}), ...tanim };
  materyal.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(YAMA_NOKTALARI.ortak, `${YAMA_NOKTALARI.ortak}\n${KOSE_TANIMLARI}`)
      .replace(YAMA_NOKTALARI.normal, KOSE_NORMALI)
      .replace(YAMA_NOKTALARI.konum, KOSE_KONUMU);
    if (tur === "derinlik" || tur === "hayalet-derinlik") return;
    let frag = shader.fragmentShader.replace(YAMA_NOKTALARI.ortak, `${YAMA_NOKTALARI.ortak}\n${PARCA_TANIMLARI}`);
    if (tur === "kati") {
      frag = frag
        .replace(
          YAMA_NOKTALARI.renk,
          "vec4 diffuseColor = vec4( diffuse * sRGBTransferEOTF( vec4( vBead.rgb, 1.0 ) ).rgb, opacity );",
        )
        .replace(
          YAMA_NOKTALARI.isima,
          `${YAMA_NOKTALARI.isima}\n\ttotalEmissiveRadiance += uHotColor * pow( vBead.a, 1.6 );`,
        );
    } else if (tur === "hale") {
      frag = frag.replace(YAMA_NOKTALARI.renk, "vec4 diffuseColor = vec4( uHotColor * pow( vBead.a, 1.4 ), opacity );");
    }
    shader.fragmentShader = frag;
  };
  materyal.customProgramCacheKey = () => `${BONCUK_SADER_SURUMU}-${tur}`;
}

/** Şablonun köşeleri + segment başına örnek öznitelikleri → örneklenmiş geometri. */
export function ornekGeometriKur(
  sablon: THREE.BufferGeometry,
  bas: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  son: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  renk: THREE.InstancedBufferAttribute,
  adet: number,
): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setIndex(sablon.getIndex());
  geo.setAttribute("position", sablon.getAttribute("position"));
  geo.setAttribute("normal", sablon.getAttribute("normal"));
  geo.setAttribute("iStart", bas);
  geo.setAttribute("iEnd", son);
  geo.setAttribute("iColor", renk);
  geo.instanceCount = adet;
  return geo;
}

/** Konum dizisinden (x1,y1,z1,x2,y2,z2 × n) örnek öznitelikleri — kopyasız. */
export function konumOznitelikleri(dizi: Float32Array, dinamik = false): {
  bas: THREE.InterleavedBufferAttribute; son: THREE.InterleavedBufferAttribute; tampon: THREE.InstancedInterleavedBuffer;
} {
  const tampon = new THREE.InstancedInterleavedBuffer(dizi, 6, 1);
  if (dinamik) tampon.setUsage(THREE.DynamicDrawUsage);
  return {
    tampon,
    bas: new THREE.InterleavedBufferAttribute(tampon, 3, 0),
    son: new THREE.InterleavedBufferAttribute(tampon, 3, 3),
  };
}

/**
 * KATI + GÖLGE: basılan kısmın örneklenmiş nesnesi. Sınır küresi şablondan (orijindeki birim
 * prizma) hesaplandığı için görüş kırpması kapalı — yoksa model yanlışlıkla elenirdi.
 */
export function katiNesneKur(geo: THREE.InstancedBufferGeometry, uniforms: BoncukUniformlari, golgeli: boolean): {
  nesne: THREE.Mesh; dispose: () => void;
} {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0 });
  boncukYamala(mat, "kati", uniforms);
  const nesne = new THREE.Mesh(geo, mat);
  nesne.frustumCulled = false;
  nesne.castShadow = golgeli;
  nesne.receiveShadow = golgeli;
  const derinlik = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  boncukYamala(derinlik, "derinlik", uniforms);
  nesne.customDepthMaterial = derinlik;
  return { nesne, dispose: () => { mat.dispose(); derinlik.dispose(); } };
}

/**
 * KALAN KISMIN TASLAĞI — TEK KATLI CAM. Taslak her yüzeyde saydam çizilince büyük parçada bir
 * pikselin arkasına onlarca yüzey biniyor ve %10'luk saydamlık üst üste katlanıp taslağı OPAK
 * beyaza çeviriyordu: 209 mm'lik ahtapotta kesit hiç görünmedi. Önce taslağın yalnız derinliği
 * yazılır (renk yok), sonra renk YALNIZ en yakın yüzeye dökülür (EqualDepth). Sıra önemli: katı
 * kısım önce çizilmeli (renderOrder 0), yoksa derinlik geçişi onu görünmez yüzeylerle örter.
 */
export function hayaletKur(geo: THREE.InstancedBufferGeometry, uniforms: BoncukUniformlari, opaklik = 0.14): {
  on: THREE.Mesh; renk: THREE.Mesh; goster: (v: boolean) => void; dispose: () => void;
} {
  const onMat = new THREE.MeshStandardMaterial({ colorWrite: false });
  boncukYamala(onMat, "hayalet-derinlik", uniforms);
  const on = new THREE.Mesh(geo, onMat);
  on.frustumCulled = false;
  on.renderOrder = 1;
  on.visible = false;
  const renkMat = new THREE.MeshStandardMaterial({
    color: 0x9fb0cc, transparent: true, opacity: opaklik, depthWrite: false, depthFunc: THREE.EqualDepth,
    roughness: 0.9, metalness: 0,
  });
  boncukYamala(renkMat, "hayalet", uniforms);
  const renk = new THREE.Mesh(geo, renkMat);
  renk.frustumCulled = false;
  renk.renderOrder = 2;
  renk.visible = false;
  return {
    on,
    renk,
    goster: (v) => { on.visible = v; renk.visible = v; },
    dispose: () => { onMat.dispose(); renkMat.dispose(); },
  };
}

/** SICAK İZ — son basılan şeritlerin etrafında yumuşak parıltı (katkısal, küçük dinamik tampon). */
export interface SicakIz {
  nesne: THREE.Mesh;
  /**
   * Baş segment `k` (kesir `f`) ve ondan geriye `m` segmenti kaynaktan kopyalar.
   * `bayraklar` verilirse görünmeyen (ör. gizli destek) segment parlamaz.
   */
  doldur: (kaynak: Float32Array, bayraklar: Uint8Array | null, k: number, f: number, m: number) => void;
  gizle: () => void;
  dispose: () => void;
}

export function sicakIzKur(
  sablon: THREE.BufferGeometry, W: number, H: number, sicakRenk: THREE.IUniform<THREE.Color>, yanEgim: THREE.IUniform<number>,
): SicakIz {
  const veri = new Float32Array(HALE_KAPASITE * 6);
  const { bas, son, tampon } = konumOznitelikleri(veri, true);
  const renk = new Uint8Array(HALE_KAPASITE * 4);
  const renkAttr = new THREE.InstancedBufferAttribute(renk, 4, true);
  renkAttr.setUsage(THREE.DynamicDrawUsage);
  const geo = ornekGeometriKur(sablon, bas, son, renkAttr, 0);
  const uniforms = boncukUniformlari(W * 1.55, H * 1.5, HALE_KAPASITE, sicakRenk, yanEgim);
  const mat = new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  boncukYamala(mat, "hale", uniforms);
  const nesne = new THREE.Mesh(geo, mat);
  nesne.frustumCulled = false;
  nesne.renderOrder = 3;
  nesne.visible = false;
  return {
    nesne,
    doldur: (kaynak, bayraklar, k, f, mIstek) => {
      const m = Math.min(HALE_KAPASITE, Math.max(1, Math.ceil(mIstek)), k + 1);
      for (let j = 0; j < m; j++) {
        const i = k - j;
        const o = i * 6;
        const h = j * 6;
        const pay = j === 0 ? f : 1;
        veri[h] = kaynak[o];
        veri[h + 1] = kaynak[o + 1];
        veri[h + 2] = kaynak[o + 2];
        veri[h + 3] = kaynak[o] + (kaynak[o + 3] - kaynak[o]) * pay;
        veri[h + 4] = kaynak[o + 1] + (kaynak[o + 4] - kaynak[o + 1]) * pay;
        veri[h + 5] = kaynak[o + 5];
        const gorunur = !bayraklar || (bayraklar[i * 4 + 3] & BAYRAK_KATI) !== 0;
        renk[j * 4 + 3] = gorunur ? Math.round(255 * Math.pow(1 - j / m, 1.2)) : 0;
      }
      tampon.needsUpdate = true;
      renkAttr.needsUpdate = true;
      geo.instanceCount = m;
      nesne.visible = true;
    },
    gizle: () => { nesne.visible = false; },
    dispose: () => { geo.dispose(); mat.dispose(); },
  };
}

/** NOZUL — ucu gcode Z'sinde (şeridin üstü), gövdesi yukarıda; model büyüklüğüne ölçekli. */
export interface Nozul {
  grup: THREE.Group;
  konumla: (x: number, y: number, z: number) => void;
  goster: (v: boolean) => void;
  dispose: () => void;
}

export function nozulKur(olcek: number, golgeli: boolean): Nozul {
  const grup = new THREE.Group();
  const ucMat = new THREE.MeshStandardMaterial({ color: 0xcaa45c, metalness: 0.35, roughness: 0.32 });
  const uc = new THREE.Mesh(new THREE.ConeGeometry(0.85, 1.9, 24), ucMat);
  uc.rotation.x = -Math.PI / 2; // tepe -Z'ye (tablaya) baksın
  uc.position.z = 0.95;
  const blokMat = new THREE.MeshStandardMaterial({ color: 0xb9c0cb, metalness: 0.3, roughness: 0.38 });
  const blok = new THREE.Mesh(new THREE.BoxGeometry(4.6, 3.8, 2.8), blokMat);
  blok.position.z = 3.3;
  uc.castShadow = golgeli;
  // Blok gölge düşürmez: ilk katmanlarda tablaya modelden kopuk koyu bir kare bırakıyordu.
  blok.castShadow = false;
  const isik = new THREE.PointLight(0xffa860, 2.4, 18, 2);
  isik.position.z = 0.5;
  grup.add(uc, blok, isik);
  // 20 mm'lik parçada gerçek boyutlu ısıtıcı blok parçayı kapatırdı.
  const s = Math.min(4, Math.max(0.6, olcek / 45));
  grup.scale.setScalar(s);
  isik.distance = 18 * s;
  grup.visible = false;
  return {
    grup,
    konumla: (x, y, z) => { grup.position.set(x, y, z); },
    goster: (v) => { grup.visible = v; },
    dispose: () => {
      uc.geometry.dispose();
      blok.geometry.dispose();
      ucMat.dispose();
      blokMat.dispose();
    },
  };
}

/** Modelin kaplamı (mm) — ışık, tabla ve kamera buna göre kurulur. */
export interface ModelOlcusu {
  spanX: number;
  spanY: number;
  spanZ: number;
  olcek: number;
}

/** Tabladaki yumuşak gölge lekesi (gölge haritası kapalıyken de model havada durmasın). */
function golgeLekesi(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(0,0,0,0.55)");
  grad.addColorStop(0.55, "rgba(0,0,0,0.22)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * STÜDYO — demodaki ışık düzeni (three r155+ fiziksel birimlerinde π ile ölçekli), koyu tabla,
 * ince ızgara ve yumuşak gölge lekesi. Gölge sapması gölge pikselinin boyuna göre: büyük parçada
 * bir gölge pikseli bir şerit kadar (209 mm → ~0,18 mm) ve sabit küçük sapma yüzeyi benekliyordu.
 */
export function studyoKur(scene: THREE.Scene, o: ModelOlcusu, golgeli: boolean, golgeHaritasi = 2048): { dispose: () => void } {
  const { spanX, spanY, spanZ, olcek } = o;
  const tablaBoyu = Math.ceil((Math.max(spanX, spanY) * 1.55 + 24) / 10) * 10;
  const tablaMat = new THREE.MeshStandardMaterial({ color: 0x2e333c, roughness: 0.85, metalness: 0.05 });
  const tabla = new THREE.Mesh(new THREE.BoxGeometry(tablaBoyu, 1.2, tablaBoyu), tablaMat);
  tabla.position.y = -0.62;
  tabla.receiveShadow = golgeli;
  scene.add(tabla);
  const izgara = new THREE.GridHelper(tablaBoyu, Math.max(8, Math.round(tablaBoyu / 10)), 0x5a6170, 0x454b57);
  izgara.position.y = 0.02;
  const izgaraMat = izgara.material as THREE.Material;
  izgaraMat.transparent = true;
  izgaraMat.opacity = 0.4;
  scene.add(izgara);

  const lekeDokusu = golgeLekesi();
  let leke: THREE.Mesh | null = null;
  if (lekeDokusu) {
    const lekeBoyu = Math.max(spanX, spanY) * 1.35;
    leke = new THREE.Mesh(
      new THREE.PlaneGeometry(lekeBoyu, lekeBoyu),
      new THREE.MeshBasicMaterial({ map: lekeDokusu, transparent: true, depthWrite: false, opacity: golgeli ? 0.35 : 0.6 }),
    );
    leke.rotation.x = -Math.PI / 2;
    leke.position.y = 0.04;
    leke.renderOrder = 1;
    scene.add(leke);
  }

  const yaricap = olcek * 0.72;
  scene.add(new THREE.HemisphereLight(0xf2f5ff, 0x363b47, 2.2));
  const anahtar = new THREE.DirectionalLight(0xffffff, 3.4);
  anahtar.position.set(-yaricap * 1.6, yaricap * 2.9, yaricap * 1.8);
  anahtar.target.position.set(0, spanZ * 0.4, 0);
  scene.add(anahtar, anahtar.target);
  if (golgeli) {
    anahtar.castShadow = true;
    const g0 = anahtar.shadow;
    g0.mapSize.set(golgeHaritasi, golgeHaritasi);
    const r = olcek * 0.85 + 8;
    const kam = g0.camera as THREE.OrthographicCamera;
    kam.left = -r; kam.right = r; kam.top = r; kam.bottom = -r;
    kam.near = 1;
    kam.far = yaricap * 9 + r * 3;
    kam.updateProjectionMatrix();
    const golgePikseli = (2 * r) / golgeHaritasi;
    g0.bias = -0.0005;
    g0.normalBias = Math.max(0.05, golgePikseli * 1.6);
    g0.radius = 3;
  }
  const kenar = new THREE.DirectionalLight(0xcfe0ff, 1.6);
  kenar.position.set(yaricap * 1.6, yaricap * 1.2, -yaricap * 2.2);
  scene.add(kenar);

  return {
    dispose: () => {
      tabla.geometry.dispose();
      tablaMat.dispose();
      izgara.geometry.dispose();
      izgaraMat.dispose();
      if (leke) {
        leke.geometry.dispose();
        (leke.material as THREE.Material).dispose();
      }
      lekeDokusu?.dispose();
      anahtar.dispose();
    },
  };
}

/** Kamera: dörtte üç görünüm, model kadraja sığacak uzaklıkta; `konumla` hedef etrafında döndürür. */
export function kameraKur(o: ModelOlcusu, carpan = 1.08): {
  camera: THREE.PerspectiveCamera; hedef: THREE.Vector3; konumla: (az: number, el?: number) => void;
} {
  const kure = 0.5 * Math.hypot(o.spanX, o.spanY, o.spanZ);
  const fov = 34;
  const uzaklik = (kure / Math.sin((fov * Math.PI) / 360)) * carpan;
  const camera = new THREE.PerspectiveCamera(fov, 1, Math.max(0.1, uzaklik * 0.02), uzaklik * 8);
  const hedef = new THREE.Vector3(0, o.spanZ * 0.4, 0);
  const konumla = (az: number, el = 0.43) => {
    camera.position.set(
      hedef.x + uzaklik * Math.cos(el) * Math.sin(az),
      hedef.y + uzaklik * Math.sin(el),
      hedef.z + uzaklik * Math.cos(el) * Math.cos(az),
    );
    camera.lookAt(hedef);
  };
  konumla(Math.PI / 4);
  return { camera, hedef, konumla };
}
