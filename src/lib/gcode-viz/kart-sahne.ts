"use client";
/**
 * KART SAHNESİ — yazıcı kartındaki canlı 3B baskı. İzleyiciyle AYNI görünüm (boncuk-ortak.ts),
 * ama gün boyu açık kalan bir panoda birden çok kart aynı anda dönebilsin diye HAFİF.
 *
 * NEDEN AYRI: izleyici tüm segmentleri çizer (1,84 milyon segment bu PC'de 5,4 ms/kare). Pano
 * saatlerce açık kalıyor ve üç yazıcı aynı anda dönebiliyor; zayıf bir ekran kartında bu,
 * sürekli dolu bir GPU demek. 168 piksellik kartta bir piksel ~6 katman — o ayrıntı görünmüyor.
 *
 * NASIL (seviye düşürme):
 *  • KABUK: her `kat`. katmanın yalnız dış duvarı ve yüzeyleri, `kat` kat kalın şeritle. Uzaktan
 *    fark edilmez; 1,84 milyon segment ~80 binde kalır.
 *  • BANT: basılan katman ve altındaki `kat` katman TAM ayrıntıyla (dolgu dahil) — kesit yüzeyi
 *    gerçek baskıdaki gibi görünsün. Nozul ve sıcak iz bu bantta yürür. Katman değişince bant
 *    yeniden kurulur (katman başına bir kez, küçük).
 *  • Kalan kısmın taslağı kabuktan çizilir.
 *
 * Veri kaynağı açılmış geometri DEĞİL, kompakt paket: 2 milyon segmentlik dosyada açılmış
 * geometri ~50 MB, paket ~15 MB. Kartta paket hafızada durur, bant gerektikçe açılır.
 */
import * as THREE from "three";
import type { VizPack, YolZamani } from "./viz-pack";
import { FEATURE_OTHER, FEATURE_OUTER, FEATURE_SOLID, isBodyFeature } from "./viz-pack";
import type { VizPalette } from "./three-scene";
import {
  BAYRAK_HAYALET, BAYRAK_KATI, BONCUK_GENISLIK, SICAK_RENK, YAN_EGIM, bastakiSegment, boncukSablonu, gorunenBas,
  boncukUniformlari, hayaletKur, kameraKur, katiNesneKur, katmanKalinligiZ, konumOznitelikleri, nozulKur,
  ornekGeometriKur, renkTablosu, renkYaz, sicakIzKur, studyoKur,
} from "./boncuk-ortak";
import {
  ilerlemeninKatmani, katmanBasSegment, katmanSonSegment, sonKucukEsit, type SegmentOkuyucu,
} from "./canli-konum";

/** Kabukta en fazla bu kadar katmanda bir katman çizilir (kalınlık = kat × katman yüksekliği). */
export const KART_KAT_SINIRI = 8;
/** Bu kadar katman kartta ~yeterli çözünürlük: daha fazlası seyreltilir. */
export const KART_HEDEF_KATMAN = 160;
/** Tam ayrıntılı bandın taşıyabileceği en fazla segment. */
export const BANT_KAPASITE = 150_000;

/** Kaç katmanda bir kabuk katmanı? */
export function kabukKati(katmanSayisi: number): number {
  return Math.max(1, Math.min(KART_KAT_SINIRI, Math.round(katmanSayisi / KART_HEDEF_KATMAN)));
}

/** Kabuğa giren katman mı? Her `kat`. katman ve en üst katman. */
export function kabukKatmaniMi(li: number, kat: number, katmanSayisi: number): boolean {
  return li % kat === kat - 1 || li === katmanSayisi - 1;
}

/** Kabuğa giren özellikler: dışarıdan görünen her şey (dış duvar, üst/alt yüzey, sınıflanmayan). */
function kabukOzelligiMi(f: number): boolean {
  return f === FEATURE_OUTER || f === FEATURE_SOLID || f === FEATURE_OTHER;
}

export interface KabukVerisi {
  konum: Float32Array;
  renk: Uint8Array;
  /** Katman i dahil, o katmana kadar kabuktaki segment sayısı. */
  katmanSonu: Uint32Array;
  kat: number;
}

/** Paketten seyreltilmiş kabuk (saf, test edilir). */
export function kabukKur(p: VizPack, kat: number, tablo: Uint8Array, toolCount: number): KabukVerisi {
  const L = p.layerZ.length;
  let sayi = 0;
  for (let li = 0; li < L; li++) {
    if (!kabukKatmaniMi(li, kat, L)) continue;
    for (let pi = p.layerPathStart[li]; pi < p.layerPathEnd[li]; pi++) {
      if (kabukOzelligiMi(p.pathFeature[pi])) sayi += Math.max(0, p.pathLen[pi] - 1);
    }
  }
  const konum = new Float32Array(sayi * 6);
  const renk = new Uint8Array(sayi * 4);
  const katmanSonu = new Uint32Array(L);
  const ox = p.originX, oy = p.originY, s = p.scaleXY;
  let j = 0;
  for (let li = 0; li < L; li++) {
    if (kabukKatmaniMi(li, kat, L)) {
      const z = p.layerZ[li];
      for (let pi = p.layerPathStart[li]; pi < p.layerPathEnd[li]; pi++) {
        const f = p.pathFeature[pi];
        if (!kabukOzelligiMi(f)) continue;
        const b = p.pathStart[pi];
        const n = p.pathLen[pi];
        let px = ox + p.points[b * 2] * s;
        let py = oy + p.points[b * 2 + 1] * s;
        for (let k = 1; k < n; k++) {
          const qx = ox + p.points[(b + k) * 2] * s;
          const qy = oy + p.points[(b + k) * 2 + 1] * s;
          const o = j * 6;
          konum[o] = px; konum[o + 1] = py; konum[o + 2] = z;
          konum[o + 3] = qx; konum[o + 4] = qy; konum[o + 5] = z;
          renkYaz(tablo, toolCount, f, p.pathTool[pi], renk, j * 4);
          // Kabuğun her şeridi hem katı hem taslak adayı (taslak yalnız dış kabuktan çizilir).
          renk[j * 4 + 3] = BAYRAK_KATI | BAYRAK_HAYALET;
          j++;
          px = qx; py = qy;
        }
      }
    }
    katmanSonu[li] = j;
  }
  return { konum, renk, katmanSonu, kat };
}

/**
 * Paketten segment okuyucu (canlı konumda gerçek XY düzeltmesi için): genel segment i'nin uçları
 * ve katmanının Z'si. Açılmış geometri gerekmez.
 */
export function paketOkuyucu(p: VizPack, yz: YolZamani): SegmentOkuyucu {
  const yolKatmani = new Uint32Array(p.pathLen.length);
  for (let li = 0; li < p.layerZ.length; li++) {
    for (let pi = p.layerPathStart[li]; pi < p.layerPathEnd[li]; pi++) yolKatmani[pi] = li;
  }
  const ox = p.originX, oy = p.originY, s = p.scaleXY;
  return (i, c) => {
    const yol = Math.max(0, sonKucukEsit(yz.segBas, i));
    const k = Math.min(Math.max(0, i - yz.segBas[yol]), Math.max(0, p.pathLen[yol] - 2));
    const b = p.pathStart[yol] + k;
    c[0] = ox + p.points[b * 2] * s;
    c[1] = oy + p.points[b * 2 + 1] * s;
    c[2] = ox + p.points[(b + 1) * 2] * s;
    c[3] = oy + p.points[(b + 1) * 2 + 1] * s;
    c[4] = p.layerZ[yolKatmani[yol]];
  };
}

/**
 * Kadraj için GÖVDENİN XY sınırı (izleyicideki `bodyXYBounds`un paket karşılığı). Paketin kendi
 * sınırı başlangıç çizgisini ve eteği de kapsıyor: U1'de başlangıç çizgisi tablanın önünde, model
 * arkadaysa kadraj tüm tablaya açılıyor ve model kartta küçücük kalıyordu.
 */
export function paketGovdeSiniri(p: VizPack): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const ox = p.originX, oy = p.originY, s = p.scaleXY;
  for (let pi = 0; pi < p.pathLen.length; pi++) {
    if (!isBodyFeature(p.pathFeature[pi])) continue;
    const b = p.pathStart[pi];
    for (let k = 0; k < p.pathLen[pi]; k++) {
      const x = ox + p.points[(b + k) * 2] * s;
      const y = oy + p.points[(b + k) * 2 + 1] * s;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (minX > maxX) return { minX: p.bounds.minX, maxX: p.bounds.maxX, minY: p.bounds.minY, maxY: p.bounds.maxY };
  return { minX, maxX, minY, maxY };
}

export interface KartSahnesi {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  golgeli: boolean;
  layerCount: number;
  totalSegments: number;
  /** Canlı ilerleme: genel segment (kesirli). null → tam model (baskı bitti / canlı değil). */
  setProgress: (p: number | null, sicakIz?: number) => void;
  setPalette: (palette: VizPalette) => void;
  /** Kamerayı modelin etrafında döndür (radyan); `el` verilirse eğim (varsayılan 0,43). */
  setAci: (az: number, el?: number) => void;
  kirliMi: () => boolean;
  golgeKirliMi: () => boolean;
  /** Tanı: kabuktaki segment sayısı ve seyreltme katı. */
  tani: { kabukSegment: number; kat: number };
  dispose: () => void;
}

export interface KartSecenekleri {
  palette?: VizPalette;
  /** Kartta gölge haritası (varsayılan açık, 1024). */
  golgeli?: boolean;
  /**
   * Kalan kısmın (taslak) opaklığı — varsayılan 0,14 (masaüstü kartı). Telefonda sahne tam
   * genişlikte ve koyu zeminde duruyor; 0,14'lük taslak "model eksik" diye okunuyordu.
   */
  hayaletOpaklik?: number;
}

export function buildKartSahnesi(p: VizPack, yz: YolZamani, secenek: KartSecenekleri = {}): KartSahnesi {
  const L = p.layerZ.length;
  const N = yz.toplamSegment;
  const W = BONCUK_GENISLIK;
  const H = katmanKalinligiZ(p.layerZ);
  const kat = kabukKati(L);
  const golgeli = secenek.golgeli !== false;
  const scene = new THREE.Scene();

  let palet = secenek.palette;
  let { tablo, toolCount } = renkTablosu(p.toolCount, p.filamentColors, { palette: palet });

  const sicakRenk = { value: new THREE.Color(SICAK_RENK) };
  const yanEgim = { value: YAN_EGIM };
  const sablon = boncukSablonu();

  // ── Kabuk: seyreltilmiş dış yüzey ─────────────────────────────────────────────
  const kabuk = kabukKur(p, kat, tablo, toolCount);
  const K = kabuk.katmanSonu.length ? kabuk.katmanSonu[L - 1] : 0;
  const kabukOz = konumOznitelikleri(kabuk.konum);
  const kabukRenk = new THREE.InstancedBufferAttribute(kabuk.renk, 4, true);
  const kabukUni = boncukUniformlari(W, H * kat, K, sicakRenk, yanEgim);
  const kabukGeo = ornekGeometriKur(sablon, kabukOz.bas, kabukOz.son, kabukRenk, K);
  const kabukNesne = katiNesneKur(kabukGeo, kabukUni, golgeli);
  const hayaletUni = boncukUniformlari(W, H * kat, K, sicakRenk, yanEgim);
  const hayaletGeo = ornekGeometriKur(sablon, kabukOz.bas, kabukOz.son, kabukRenk, K);
  const hayalet = hayaletKur(hayaletGeo, hayaletUni, secenek.hayaletOpaklik);

  // ── Bant: basılan katmanın çevresi tam ayrıntıyla ─────────────────────────────
  const bantKonum = new Float32Array(BANT_KAPASITE * 6);
  const bantRenkDizi = new Uint8Array(BANT_KAPASITE * 4);
  const bantOz = konumOznitelikleri(bantKonum, true);
  const bantRenk = new THREE.InstancedBufferAttribute(bantRenkDizi, 4, true);
  bantRenk.setUsage(THREE.DynamicDrawUsage);
  const bantUni = boncukUniformlari(W, H, 0, sicakRenk, yanEgim);
  const bantGeo = ornekGeometriKur(sablon, bantOz.bas, bantOz.son, bantRenk, 0);
  const bantKati = katiNesneKur(bantGeo, bantUni, golgeli);
  bantKati.nesne.visible = false;
  const iz = sicakIzKur(sablon, W, H, sicakRenk, yanEgim);

  /** Şu an kurulu bant: [ilkKatman, sonKatman], genel segment başı ve adedi. */
  let bant = { ilk: -1, son: -1, bas: 0, adet: 0 };

  const bantKur = (sonKatman: number) => {
    let ilk = Math.max(0, sonKatman - kat + 1);
    // Kapasiteyi aşarsa bant alttan daralır (tek katman bile aşarsa kırpılır; nadir).
    while (ilk < sonKatman && katmanSonSegment(yz, sonKatman) - katmanBasSegment(yz, ilk) > BANT_KAPASITE) ilk++;
    const bas = katmanBasSegment(yz, ilk);
    const ox = p.originX, oy = p.originY, s = p.scaleXY;
    let j = 0;
    for (let li = ilk; li <= sonKatman && j < BANT_KAPASITE; li++) {
      const z = p.layerZ[li];
      for (let pi = p.layerPathStart[li]; pi < p.layerPathEnd[li] && j < BANT_KAPASITE; pi++) {
        const f = p.pathFeature[pi];
        const b = p.pathStart[pi];
        const n = p.pathLen[pi];
        let px = ox + p.points[b * 2] * s;
        let py = oy + p.points[b * 2 + 1] * s;
        for (let k = 1; k < n && j < BANT_KAPASITE; k++) {
          const qx = ox + p.points[(b + k) * 2] * s;
          const qy = oy + p.points[(b + k) * 2 + 1] * s;
          const o = j * 6;
          bantKonum[o] = px; bantKonum[o + 1] = py; bantKonum[o + 2] = z;
          bantKonum[o + 3] = qx; bantKonum[o + 4] = qy; bantKonum[o + 5] = z;
          // Gizli segmentler (destek, etek) de sırada kalır: bant içi indeks = genel − baş.
          renkYaz(tablo, toolCount, f, p.pathTool[pi], bantRenkDizi, j * 4);
          j++;
          px = qx; py = qy;
        }
      }
    }
    bantOz.tampon.needsUpdate = true;
    bantRenk.needsUpdate = true;
    bant = { ilk, son: sonKatman, bas, adet: j };
  };

  // ── Yerleşim ─────────────────────────────────────────────────────────────────
  const govde = paketGovdeSiniri(p);
  const cx = (govde.minX + govde.maxX) / 2;
  const cy = (govde.minY + govde.maxY) / 2;
  const spanX = Math.max(5, govde.maxX - govde.minX);
  const spanY = Math.max(5, govde.maxY - govde.minY);
  const tabanZ = p.bounds.minZ - H;
  const spanZ = Math.max(2, p.bounds.maxZ - tabanZ);
  const olcu = { spanX, spanY, spanZ, olcek: Math.max(spanX, spanY, spanZ) };

  const model = new THREE.Group();
  model.position.set(-cx, -cy, -tabanZ);
  model.add(kabukNesne.nesne, bantKati.nesne, hayalet.on, hayalet.renk, iz.nesne);
  const nozul = nozulKur(olcu.olcek, golgeli);
  model.add(nozul.grup);
  const cevir = new THREE.Group();
  cevir.rotation.x = -Math.PI / 2;
  cevir.add(model);
  scene.add(cevir);

  const studyo = studyoKur(scene, olcu, golgeli, 1024);
  // Kart kare ve küçük: model kadrajı biraz daha sıkı doldursun.
  const kamera = kameraKur(olcu, 0.98);

  let kirli = true;
  let golgeKirli = true;
  let sonIlerleme: number | null | undefined;

  const tamModel = () => {
    kabukGeo.instanceCount = K;
    bantKati.nesne.visible = false;
    hayalet.goster(false);
    iz.gizle();
    nozul.goster(false);
  };
  tamModel();

  return {
    scene,
    camera: kamera.camera,
    golgeli,
    layerCount: L,
    totalSegments: N,
    tani: { kabukSegment: K, kat },
    setProgress: (pIstek: number | null, sicakIz = 120) => {
      const pp = pIstek == null || pIstek >= N ? null : Math.max(0, pIstek);
      if (pp === sonIlerleme) return;
      sonIlerleme = pp;
      kirli = true;
      if (pp == null) {
        golgeKirli = true;
        tamModel();
        return;
      }
      const li = Math.max(0, ilerlemeninKatmani(yz, pp));
      if (li !== bant.son) {
        bantKur(li);
        golgeKirli = true;
      }
      // Kabuk: bandın ALTINDA kalan katmanlar; taslak: basılan katmanın ÜSTÜ.
      kabukGeo.instanceCount = bant.ilk > 0 ? kabuk.katmanSonu[bant.ilk - 1] : 0;
      hayaletUni.uHeadIndex.value = kabuk.katmanSonu[li] - 1;
      hayalet.goster(true);

      const yerel = Math.min(bant.adet, pp - bant.bas);
      if (bant.adet === 0 || yerel <= 0) {
        bantKati.nesne.visible = false;
        iz.gizle();
        nozul.goster(false);
        return;
      }
      const k = Math.min(bant.adet - 1, bastakiSegment(yerel));
      const f = Math.min(1, Math.max(0.02, yerel - k));
      bantGeo.instanceCount = k + 1;
      bantUni.uHeadIndex.value = k;
      bantUni.uHeadFrac.value = f;
      bantUni.uHotSpan.value = sicakIz;
      bantKati.nesne.visible = true;
      iz.doldur(bantKonum, bantRenkDizi, k, f, sicakIz);
      const j = gorunenBas(bantRenkDizi, k);
      if (j < 0) {
        nozul.goster(false);
        return;
      }
      const fj = j === k ? f : 1;
      const o = j * 6;
      nozul.konumla(
        bantKonum[o] + (bantKonum[o + 3] - bantKonum[o]) * fj,
        bantKonum[o + 1] + (bantKonum[o + 4] - bantKonum[o + 1]) * fj,
        bantKonum[o + 5],
      );
      nozul.goster(true);
    },
    setPalette: (pl: VizPalette) => {
      palet = pl;
      ({ tablo, toolCount } = renkTablosu(p.toolCount, p.filamentColors, { palette: palet }));
      const yeni = kabukKur(p, kat, tablo, toolCount);
      kabuk.renk.set(yeni.renk);
      kabukRenk.needsUpdate = true;
      if (bant.son >= 0) bantKur(bant.son);
      kirli = true;
      golgeKirli = true;
    },
    setAci: (az: number, el?: number) => {
      kamera.konumla(az, el);
      kirli = true;
    },
    kirliMi: () => {
      const k = kirli;
      kirli = false;
      return k;
    },
    golgeKirliMi: () => {
      const k = golgeKirli;
      golgeKirli = false;
      return k;
    },
    dispose: () => {
      sablon.dispose();
      kabukGeo.dispose();
      hayaletGeo.dispose();
      bantGeo.dispose();
      kabukNesne.dispose();
      bantKati.dispose();
      hayalet.dispose();
      iz.dispose();
      nozul.dispose();
      studyo.dispose();
    },
  };
}
