"use client";
/**
 * PARÇA SEÇİCİ SAHNESİ — "Hangi parça bozuldu?" penceresinin 3B'si.
 *
 * NEDEN: yazıcı parçaların yalnız tabladaki kaba kutusunu veriyor (Bambu'da dikdörtgen, Klipper'da
 * kaba çerçeve). Çapraz duran ya da iç içe geçen parçaların kutuları üst üste biniyor ve tepeden
 * bakan haritada hangi numaranın hangi parça olduğu anlaşılmıyordu. Burada parçalar izleyiciyle
 * aynı katı şeritlerle, GERÇEK biçimleriyle çizilir; imlecin altındaki parça yumuşakça parlar.
 *
 * NASIL:
 *  • Paket yol başına parça taşıyor (parse-gcode'daki parça etiketleri). Segment başına parça
 *    numarası örnek özniteliği olarak GPU'ya gider (`iNesne`).
 *  • Parça durumu (seçili / üzerinde / iptal) küçük bir dokuda: şader örneğin parçasının durumunu
 *    buradan okur → vurgu için sahne yeniden kurulmaz, yalnız birkaç bayt değişir.
 *  • SEÇİM GPU'DAN: imlecin altındaki tek piksel, parça numarasını renk olarak yazan ayrı bir
 *    geçişle 1×1 hedefe çizilir ve okunur. Görünen neyse o seçilir; iç içe parçalarda da doğru.
 *    Seçim geçişi modelin TAMAMINI çizer (basılmamış kısım da tıklanabilir).
 *
 * Ortak çizici parçaları (şerit şablonu, ışık, tabla) boncuk-ortak'tan; parçaya özgü şader eki bu
 * dosyada — telefondaki 3B paketini etkilemesin.
 */
import * as THREE from "three";
import type { ParsedGcode } from "./viz-pack";
import { bodyXYBounds, type VizPalette } from "./three-scene";
import { boncukRenkleri, GOLGE_BUTCESI } from "./bead-scene";
import {
  BONCUK_GENISLIK, BONCUK_SADER_SURUMU, SICAK_RENK, YAN_EGIM, YAMA_NOKTALARI, bastakiSegment,
  boncukSablonu, boncukUniformlari, boncukYamala, hayaletKur, katiNesneKur, katmanKalinligi,
  konumOznitelikleri, ornekGeometriKur, studyoKur,
} from "./boncuk-ortak";

/** Durum dokusunun genişliği — parça numarası (x, y) dokusuna bu genişlikle yerleşir. */
const DOKU_GENISLIK = 1024;
const PARCA_SADER_EKI = "parca-v1";

/** Vurgu renkleri (doğrusal RGB). Seçili = iptal edilecek → mevcut penceredeki kırmızı ton. */
const SECIM_RENGI = new THREE.Color("#ff5a4a");
const UZERINDE_RENGI = new THREE.Color("#3fd0ff");

const NESNE_KOSE_TANIMLARI = /* glsl */ `
attribute float iNesne;
uniform sampler2D uNesneDurum;
varying vec4 vNesne;
varying float vKimlik;
`;

const NESNE_KOSE = /* glsl */ `
vKimlik = iNesne;
if ( iNesne > 0.5 ) {
  int nNo = int( iNesne + 0.5 );
  vNesne = texelFetch( uNesneDurum, ivec2( nNo % ${DOKU_GENISLIK}, nNo / ${DOKU_GENISLIK} ), 0 );
} else {
  vNesne = vec4( 0.0 );
}
`;

const NESNE_PARCA_TANIMLARI = /* glsl */ `
varying vec4 vNesne;
uniform vec3 uSecimRengi;
uniform vec3 uUzerindeRengi;
uniform float uSoluk;
`;

/**
 * Katı şerit: vNesne.r seçili, .g üzerinde, .b iptal (0-1, yumuşak geçişli). Seçim varken diğer
 * parçalar biraz söner ki seçilen öne çıksın; iptal edilen gri ve karanlık.
 */
const NESNE_KATI_RENK = /* glsl */ `
float nSec = vNesne.r;
float nUst = vNesne.g * ( 1.0 - nSec );
float nIptal = vNesne.b;
float nParlak = dot( diffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) );
diffuseColor.rgb = mix( diffuseColor.rgb, vec3( nParlak * 0.4 ), nIptal );
diffuseColor.rgb = mix( diffuseColor.rgb, uSecimRengi, nSec * 0.62 );
diffuseColor.rgb = mix( diffuseColor.rgb, uUzerindeRengi, nUst * 0.38 );
diffuseColor.rgb *= 1.0 - uSoluk * ( 1.0 - max( nSec, vNesne.g ) );
`;

const NESNE_KATI_ISIMA = /* glsl */ `
totalEmissiveRadiance += uSecimRengi * nSec * 0.32 + uUzerindeRengi * nUst * 0.22;
`;

/** Taslak (basılmamış kısım): vurgulanan parçanın taslağı belirginleşir, iptal edilen söner. */
const NESNE_HAYALET_RENK = /* glsl */ `
float gVurgu = max( vNesne.r, vNesne.g );
vec3 gRenk = mix( diffuse, vNesne.r > 0.5 ? uSecimRengi : uUzerindeRengi, gVurgu * 0.85 );
vec4 diffuseColor = vec4( gRenk, opacity * ( 1.0 + 2.4 * gVurgu ) * ( 1.0 - 0.7 * vNesne.b ) );
`;

/** Seçim geçişi: parça numarası renk olarak (r = düşük bayt, g = yüksek bayt, b = geçerli). */
const NESNE_KIMLIK_RENK = /* glsl */ `
float kNo = floor( vKimlik + 0.5 );
vec4 diffuseColor = vec4( mod( kNo, 256.0 ) / 255.0, floor( kNo / 256.0 ) / 255.0, 1.0, 1.0 );
`;

type ParcaTuru = "kati" | "hayalet" | "kimlik";

function yerlestir(metin: string, capa: string, ek: string, konum: "sonra" | "yerine" = "sonra"): string {
  if (!metin.includes(capa)) throw new Error(`parça şaderi: çapa yok (${capa.slice(0, 40)})`);
  return metin.replace(capa, konum === "sonra" ? `${capa}\n${ek}` : ek);
}

/** boncukYamala'nın üstüne parça ekini uygula (önce boncuk yaması, sonra bu). */
function parcaYamala(mat: THREE.Material, tur: ParcaTuru, ek: Record<string, THREE.IUniform>): void {
  const onceki = mat.onBeforeCompile.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    onceki(shader, renderer);
    Object.assign(shader.uniforms, ek);
    shader.vertexShader = yerlestir(shader.vertexShader, "varying vec4 vBead;", NESNE_KOSE_TANIMLARI);
    shader.vertexShader = yerlestir(shader.vertexShader, "vBead = vec4( iColor.rgb, bSicak );", NESNE_KOSE);
    let frag = shader.fragmentShader;
    if (tur === "kimlik") {
      frag = yerlestir(frag, YAMA_NOKTALARI.ortak, "varying float vKimlik;");
      frag = yerlestir(frag, YAMA_NOKTALARI.renk, NESNE_KIMLIK_RENK, "yerine");
    } else {
      frag = yerlestir(frag, "uniform vec3 uHotColor;", NESNE_PARCA_TANIMLARI);
      if (tur === "kati") {
        frag = yerlestir(frag, "vec4 diffuseColor = vec4( diffuse * sRGBTransferEOTF( vec4( vBead.rgb, 1.0 ) ).rgb, opacity );", NESNE_KATI_RENK);
        frag = yerlestir(frag, "totalEmissiveRadiance += uHotColor * pow( vBead.a, 1.6 );", NESNE_KATI_ISIMA);
      } else {
        frag = yerlestir(frag, YAMA_NOKTALARI.renk, NESNE_HAYALET_RENK, "yerine");
      }
    }
    shader.fragmentShader = frag;
  };
  const anahtar = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `${anahtar()}-${PARCA_SADER_EKI}-${tur}`;
}

/** Parçanın ekrandaki çapası: üst yüzeyinin ortası (model koordinatı, mm). */
export interface ParcaCapasi {
  /** Pakette parça anahtarı (Bambu identify_id / Klipper adı). */
  anahtar: string;
  /** Tabla XY'sindeki orta nokta — yazıcının parça listesiyle yer eşlemesi için. */
  merkez: [number, number];
  x: number;
  y: number;
  z: number;
}

/** Segment başına parça dizisinden parça çapaları (saf, test edilir). İndeks = parça numarası − 1. */
export function parcaCapalari(g: Pick<ParsedGcode, "positions" | "objects" | "objectKeys" | "totalSegments">): ParcaCapasi[] {
  const anahtarlar = g.objectKeys ?? [];
  const K = anahtarlar.length;
  const minX = new Float64Array(K).fill(Infinity), maxX = new Float64Array(K).fill(-Infinity);
  const minY = new Float64Array(K).fill(Infinity), maxY = new Float64Array(K).fill(-Infinity);
  const maxZ = new Float64Array(K).fill(-Infinity);
  const o = g.objects;
  if (o) {
    const p = g.positions;
    for (let i = 0; i < g.totalSegments; i++) {
      const k = o[i] - 1;
      if (k < 0 || k >= K) continue;
      const b = i * 6;
      for (const j of [0, 3]) {
        const x = p[b + j], y = p[b + j + 1], z = p[b + j + 2];
        if (x < minX[k]) minX[k] = x; if (x > maxX[k]) maxX[k] = x;
        if (y < minY[k]) minY[k] = y; if (y > maxY[k]) maxY[k] = y;
        if (z > maxZ[k]) maxZ[k] = z;
      }
    }
  }
  return anahtarlar.map((anahtar, k) => {
    const var_ = Number.isFinite(minX[k]);
    const cx = var_ ? (minX[k] + maxX[k]) / 2 : 0;
    const cy = var_ ? (minY[k] + maxY[k]) / 2 : 0;
    return { anahtar, merkez: [cx, cy], x: cx, y: cy, z: var_ ? maxZ[k] : 0 };
  });
}

export interface ParcaDurumu {
  secili: boolean;
  uzerinde: boolean;
  iptal: boolean;
}

export interface ParcaSahnesi {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  golgeli: boolean;
  capalar: ParcaCapasi[];
  /** Basılan kısım: segment ilerlemesi (kesirli). null = modelin tamamı basılmış görünür. */
  setIlerleme: (p: number | null) => void;
  setPalette: (palet: VizPalette) => void;
  /** Parça k (1 tabanlı) için HEDEF durum; görünüm `adim` ile yumuşakça yaklaşır. */
  setDurum: (k: number, d: ParcaDurumu) => void;
  /** Seçim varken diğer parçaları söndür (0-1). */
  setSoluk: (v: number) => void;
  /** Durum geçişlerini ilerlet; hâlâ hareket varsa true (çizim gerekir). */
  adim: (dtSn: number) => boolean;
  /** Kamera: yatay açı, eğim, yakınlık (1 = kadraj). */
  setKamera: (az: number, el: number, yakinlik: number) => void;
  /** Parça çapasının dünya koordinatı (etiket yerleşimi için). */
  capaDunya: (k: number, hedef: THREE.Vector3) => THREE.Vector3;
  /** İmlecin altındaki parça (1 tabanlı; 0 = yok). x/y tuval pikseli (CSS), g/y tuval boyu. */
  sec: (renderer: THREE.WebGLRenderer, x: number, y: number, gen: number, yuk: number) => number;
  kirliMi: () => boolean;
  golgeKirliMi: () => boolean;
  dispose: () => void;
}

export function parcaSecilebilir(g: Pick<ParsedGcode, "objects" | "objectKeys">): boolean {
  return !!g.objects && !!g.objectKeys && g.objectKeys.length > 0;
}

export function buildParcaSahnesi(g: ParsedGcode, secenek: { palette?: VizPalette } = {}): ParcaSahnesi {
  if (!parcaSecilebilir(g)) throw new Error("Bu dosyada parça etiketi yok");
  const N = g.totalSegments;
  const K = g.objectKeys!.length;
  const W = BONCUK_GENISLIK;
  const H = katmanKalinligi(g.layerRanges);
  const scene = new THREE.Scene();
  const golgeli = N <= GOLGE_BUTCESI;

  const renkler = boncukRenkleri(g, { palette: secenek.palette });
  const sicakRenk = { value: new THREE.Color(SICAK_RENK) };
  const yanEgim = { value: YAN_EGIM };
  const ortak = boncukUniformlari(W, H, N, sicakRenk, yanEgim);

  // Parça durum dokusu: her parça için RGBA (r seçili, g üzerinde, b iptal).
  const dokuYuk = Math.ceil((K + 1) / DOKU_GENISLIK);
  const durumBayt = new Uint8Array(DOKU_GENISLIK * dokuYuk * 4);
  const durumDokusu = new THREE.DataTexture(durumBayt, DOKU_GENISLIK, dokuYuk, THREE.RGBAFormat);
  durumDokusu.minFilter = THREE.NearestFilter;
  durumDokusu.magFilter = THREE.NearestFilter;
  durumDokusu.generateMipmaps = false;
  durumDokusu.needsUpdate = true;
  const ek = {
    uNesneDurum: { value: durumDokusu },
    uSecimRengi: { value: SECIM_RENGI.clone() },
    uUzerindeRengi: { value: UZERINDE_RENGI.clone() },
    uSoluk: { value: 0 },
  };

  const sablon = boncukSablonu();
  const { bas: aBas, son: aSon } = konumOznitelikleri(g.positions);
  const aRenk = new THREE.InstancedBufferAttribute(renkler, 4, true);
  const aNesne = new THREE.InstancedBufferAttribute(g.objects!, 1, false);
  const nesneli = (geo: THREE.InstancedBufferGeometry) => { geo.setAttribute("iNesne", aNesne); return geo; };

  // Basılan kısım
  const katiGeo = nesneli(ornekGeometriKur(sablon, aBas, aSon, aRenk, N));
  const kati = katiNesneKur(katiGeo, ortak, golgeli);
  parcaYamala(kati.nesne.material as THREE.Material, "kati", ek);

  // Kalan kısmın taslağı
  const hayaletGeo = nesneli(ornekGeometriKur(sablon, aBas, aSon, aRenk, N));
  const hayalet = hayaletKur(hayaletGeo, ortak, 0.16);
  parcaYamala(hayalet.renk.material as THREE.Material, "hayalet", ek);

  // Seçim geçişi: modelin TAMAMI (basılmamış kısım da tıklanabilir), ayrı sahnede.
  const kimlikUni = boncukUniformlari(W, H, N, sicakRenk, yanEgim);
  const kimlikGeo = nesneli(ornekGeometriKur(sablon, aBas, aSon, aRenk, N));
  const kimlikMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  kimlikMat.blending = THREE.NoBlending;
  boncukYamala(kimlikMat, "derinlik", kimlikUni);
  parcaYamala(kimlikMat, "kimlik", ek);
  const kimlikNesne = new THREE.Mesh(kimlikGeo, kimlikMat);
  kimlikNesne.frustumCulled = false;

  // Yerleşim: izleyiciyle aynı (gcode Z yukarı → sahne Y yukarı)
  const govde = bodyXYBounds(g);
  const cx = (govde.minX + govde.maxX) / 2;
  const cy = (govde.minY + govde.maxY) / 2;
  const spanX = Math.max(5, govde.maxX - govde.minX);
  const spanY = Math.max(5, govde.maxY - govde.minY);
  const tabanZ = g.bounds.minZ - H;
  const spanZ = Math.max(2, g.bounds.maxZ - tabanZ);
  const olcu = { spanX, spanY, spanZ, olcek: Math.max(spanX, spanY, spanZ) };

  const model = new THREE.Group();
  model.position.set(-cx, -cy, -tabanZ);
  model.add(kati.nesne, hayalet.on, hayalet.renk);
  const cevir = new THREE.Group();
  cevir.rotation.x = -Math.PI / 2;
  cevir.add(model);
  scene.add(cevir);

  const kimlikSahnesi = new THREE.Scene();
  const kimlikModel = new THREE.Group();
  kimlikModel.position.copy(model.position);
  kimlikModel.add(kimlikNesne);
  const kimlikCevir = new THREE.Group();
  kimlikCevir.rotation.x = -Math.PI / 2;
  kimlikCevir.add(kimlikModel);
  kimlikSahnesi.add(kimlikCevir);

  const studyo = studyoKur(scene, olcu, golgeli);

  // Kamera: kadraja sığan uzaklık × yakınlık
  const kure = 0.5 * Math.hypot(spanX, spanY, spanZ);
  const fov = 34;
  const uzaklik = (kure / Math.sin((fov * Math.PI) / 360)) * 1.02;
  const camera = new THREE.PerspectiveCamera(fov, 1, Math.max(0.1, uzaklik * 0.02), uzaklik * 8);
  const hedef = new THREE.Vector3(0, spanZ * 0.35, 0);
  const setKamera = (az: number, el: number, yakinlik: number) => {
    const d = uzaklik / Math.max(0.3, yakinlik);
    camera.position.set(
      hedef.x + d * Math.cos(el) * Math.sin(az),
      hedef.y + d * Math.sin(el),
      hedef.z + d * Math.cos(el) * Math.cos(az),
    );
    camera.lookAt(hedef);
    kirli = true;
  };

  const capalar = parcaCapalari(g);

  // Durumlar: hedef ve anlık (yumuşak geçiş)
  const hedefDurum = new Float32Array((K + 1) * 3);
  const anlikDurum = new Float32Array((K + 1) * 3);
  let hareketli = false;

  let kirli = true;
  let golgeKirli = true;

  const setIlerleme = (p: number | null) => {
    kirli = true;
    golgeKirli = true;
    if (p == null || p >= N) {
      katiGeo.instanceCount = N;
      ortak.uHeadIndex.value = N;
      ortak.uHeadFrac.value = 1;
      hayalet.goster(false);
      return;
    }
    const k = Math.min(N - 1, bastakiSegment(Math.max(0, p)));
    katiGeo.instanceCount = k + 1;
    ortak.uHeadIndex.value = k;
    ortak.uHeadFrac.value = Math.min(1, Math.max(0.02, p - k));
    hayalet.goster(true);
  };
  setIlerleme(null);
  kimlikUni.uHeadIndex.value = N; // seçim geçişi her zaman tam model

  const kimlikHedefi = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
  const piksel = new Uint8Array(4);

  return {
    scene,
    camera,
    golgeli,
    capalar,
    setIlerleme,
    setPalette: (palet) => {
      boncukRenkleri(g, { palette: palet }, renkler);
      aRenk.needsUpdate = true;
      kirli = true;
      golgeKirli = true;
    },
    setDurum: (k, d) => {
      if (k < 1 || k > K) return;
      const o = k * 3;
      const r = d.secili ? 1 : 0, gg = d.uzerinde ? 1 : 0, b = d.iptal ? 1 : 0;
      if (hedefDurum[o] === r && hedefDurum[o + 1] === gg && hedefDurum[o + 2] === b) return;
      hedefDurum[o] = r; hedefDurum[o + 1] = gg; hedefDurum[o + 2] = b;
      hareketli = true;
    },
    setSoluk: (v) => {
      if (ek.uSoluk.value === v) return;
      ek.uSoluk.value = v;
      kirli = true;
    },
    adim: (dtSn) => {
      if (!hareketli) return false;
      const a = dtSn <= 0 ? 1 : 1 - Math.exp(-dtSn / 0.09);
      let kalan = false;
      for (let i = 3; i < anlikDurum.length; i++) {
        const fark = hedefDurum[i] - anlikDurum[i];
        if (Math.abs(fark) < 0.004) anlikDurum[i] = hedefDurum[i];
        else { anlikDurum[i] += fark * a; kalan = true; }
        const k = Math.floor(i / 3);
        durumBayt[k * 4 + (i % 3)] = Math.round(anlikDurum[i] * 255);
      }
      durumDokusu.needsUpdate = true;
      hareketli = kalan;
      kirli = true;
      return true;
    },
    setKamera,
    capaDunya: (k, v) => {
      const c = capalar[k - 1];
      if (!c) return v.set(0, 0, 0);
      v.set(c.x, c.y, c.z + H * 0.5);
      return model.localToWorld(v);
    },
    sec: (renderer, x, y, gen, yuk) => {
      if (gen <= 0 || yuk <= 0) return 0;
      camera.setViewOffset(gen, yuk, Math.floor(x), Math.floor(y), 1, 1);
      const oncekiHedef = renderer.getRenderTarget();
      const oncekiRenk = renderer.getClearColor(new THREE.Color());
      const oncekiAlfa = renderer.getClearAlpha();
      renderer.setRenderTarget(kimlikHedefi);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(kimlikSahnesi, camera);
      renderer.setRenderTarget(oncekiHedef);
      renderer.setClearColor(oncekiRenk, oncekiAlfa);
      camera.clearViewOffset();
      renderer.readRenderTargetPixels(kimlikHedefi, 0, 0, 1, 1, piksel);
      if (piksel[2] < 128) return 0;
      const k = piksel[0] + piksel[1] * 256;
      return k >= 1 && k <= K ? k : 0;
    },
    kirliMi: () => { const k = kirli; kirli = false; return k; },
    golgeKirliMi: () => { const k = golgeKirli; golgeKirli = false; return k; },
    dispose: () => {
      sablon.dispose();
      katiGeo.dispose();
      hayaletGeo.dispose();
      kimlikGeo.dispose();
      kati.dispose();
      hayalet.dispose();
      kimlikMat.dispose();
      kimlikHedefi.dispose();
      durumDokusu.dispose();
      studyo.dispose();
    },
  };
}

/** Şader sürümü (test/tanı için): parça eki ortak sürüme bağlı. */
export const PARCA_SADER_ANAHTARI = `${BONCUK_SADER_SURUMU}-${PARCA_SADER_EKI}`;
