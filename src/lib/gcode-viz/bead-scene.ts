"use client";
/**
 * BONCUK SAHNESİ — baskı yollarını dilimleyicinin önizlemesindeki gibi KATI geometri olarak çizer.
 *
 * NEDEN: eski izleyici (three-scene.ts) her şeridi kameraya dönük kalın bir çizgi olarak çiziyor
 * ve ışığı sahte bir tüp normalinden üretiyordu. Model ölçeğinde bir şerit 1 pikselden ince
 * kalınca her piksel şeridin ORTASINA düşüyor, orada sahte normal hep kameraya bakıyor ve ışık
 * modelin her yerine aynı açıyla vuruyordu: parça düz bir leke gibi görünüyordu.
 * Dilimleyiciler şeridi gerçek bir prizma olarak çizer. Prizmanın yan yüzleri modelin yüzeyiyle
 * AYNI yöne baktığı için şerit piksel altına inse bile gölgelendirme şekli taşır. Burada yapılan da bu.
 *
 * NASIL: her ekstrüzyon segmenti bir örnek (instance) — dikdörtgen kesitli kısa bir prizma. Konum,
 * yön, en ve yükseklik KÖŞE ŞADERİNDE segmentin iki ucundan kurulur. Segment başına matris
 * tutulmaz (2 milyon segmentte 134 MB ederdi): paketten gelen `positions` dizisi kopyalanmadan
 * GPU'ya gider, segment başına yalnız 4 baytlık renk + bayrak eklenir.
 *
 * İLERLEME: segmentler baskı sırasıyla dizili. `instanceCount` basılan kısmı keser, baştaki
 * segment kesirli uzar (nozul akar). Kalan kısım soluk bir taslak olarak (yalnız dış kabuk)
 * çizilir; son basılan şerit birkaç saniye sıcak parlar. Işık, gölge ve renk kararları
 * kullanıcının onayladığı demoyla birebir. Kartla ortak parçalar: boncuk-ortak.ts.
 */
import * as THREE from "three";
import type { ParsedGcode } from "./viz-pack";
import { bodyXYBounds, yazilimsalMi, type VizPalette } from "./three-scene";
import {
  BONCUK_GENISLIK, HALE_KAPASITE, SICAK_RENK, YAN_EGIM, bastakiSegment, boncukSablonu, gorunenBas,
  boncukUniformlari, hayaletKur, kameraKur, katiNesneKur, katmanKalinligi, konumOznitelikleri,
  nozulKur, ornekGeometriKur, renkTablosu, renkYaz, sicakIzKur, studyoKur,
} from "./boncuk-ortak";

export {
  BAYRAK_HAYALET, BAYRAK_KATI, BONCUK_GENISLIK, BONCUK_SADER_SURUMU, KOSE_KONUMU, KOSE_NORMALI,
  KOSE_TANIMLARI, YAMA_NOKTALARI, YAN_EGIM, bastakiSegment, boncukSablonu, katmanKalinligi, okunurRenk,
} from "./boncuk-ortak";

/**
 * Bu kadar segmente kadar boncuk çizilir, üstünde eski çizgi izleyicisine düşülür. En büyük
 * ölçülen paket 2,15 milyon gövde segmenti; eşik hepsini kapsıyor. Yazılımsal çizicide (GPU
 * sürücüsü yok) örnek başına köşe maliyeti kaldırılamaz, orada eşik düşük.
 */
export const BONCUK_BUTCESI = 4_000_000;
export const BONCUK_BUTCESI_YAZILIMSAL = 400_000;

/**
 * Gölge haritası bu segment sayısına kadar açık. Gölge geçişi köşe işini ikiye katlıyor; üstünde
 * yalnız tabladaki yumuşak gölge lekesi kalır. (Gölge haritası kamera dönerken yeniden
 * çizilmez — yalnız ilerleme/renk değişince; bkz. `golgeKirliMi`.)
 * Ölçüm (23 Eyl 2026, RTX 4090, 2 kat çözünürlük): 1,84 milyon segment → dönerken 5,4 ms,
 * gölge tazelenen karede 9,2 ms. En büyük paket 2,15 milyon; eşik hepsini kapsıyor.
 */
export const GOLGE_BUTCESI = 2_500_000;

/**
 * İlerleme (basılan segment sayısı, kesirli) hangi katmanda? Baştaki segmentin katmanı döner;
 * boş katmanlar atlanır, sonuna gelinmişse son katman. Katman yoksa -1.
 */
export function ilerlemeKatmani(layerRanges: readonly { start: number; end: number }[], p: number): number {
  const n = layerRanges.length;
  if (n === 0) return -1;
  const k = bastakiSegment(p);
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const orta = (lo + hi) >> 1;
    if (layerRanges[orta].end > k) hi = orta;
    else lo = orta + 1;
  }
  return lo;
}

/**
 * Segment başına renk + bayrak (RGBA, 8 bit) — kural `renkTablosu`nda (kartla ortak).
 * Destek ve etek varsayılan olarak ÇİZİLMEZ.
 */
export function boncukRenkleri(
  g: Pick<ParsedGcode, "features" | "tools" | "toolCount" | "filamentColors" | "totalSegments">,
  secenek: { palette?: VizPalette; showSupport?: boolean } = {},
  hedef?: Uint8Array,
): Uint8Array {
  const n = g.totalSegments;
  const out = hedef && hedef.length >= n * 4 ? hedef : new Uint8Array(n * 4);
  const { tablo, toolCount } = renkTablosu(g.toolCount, g.filamentColors, secenek);
  for (let i = 0; i < n; i++) renkYaz(tablo, toolCount, g.features[i], g.tools ? g.tools[i] : 0, out, i * 4);
  return out;
}

export interface BoncukSecenekleri {
  palette?: VizPalette;
  /** Destek ve etek çizilsin mi — varsayılan KAPALI (modelin eti değiller). */
  showSupport?: boolean;
}

export interface BoncukSahnesi {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Kameranın döneceği nokta (modelin ortası, biraz aşağıda). */
  hedef: THREE.Vector3;
  layerCount: number;
  totalSegments: number;
  /** Gölge haritası kullanılıyor mu — izleyici renderer'ı buna göre kurar. */
  golgeli: boolean;
  /** Katman i'ye kadar (dahil) basılmış göster — -1 = tamamı. */
  setLayer: (layerIdx: number) => void;
  /**
   * İnce ilerleme: basılan segment sayısı (kesirli, 0..totalSegments). null = tamamı.
   * `sicakIz`: kaç segment geriye kadar sıcak parlasın (oynatma hızına göre verilir).
   */
  setProgress: (p: number | null, sicakIz?: number) => void;
  layerAtProgress: (p: number) => number;
  setPalette: (palette: VizPalette) => void;
  setShowSupport: (goster: boolean) => void;
  /** Kalın çizgi izleyicisiyle aynı arayüz; boncuklar çözünürlükten bağımsız. */
  setResolution: (w: number, h: number) => void;
  /** Son okumadan beri çizilecek bir değişiklik var mı (okuyunca sıfırlanır). */
  kirliMi: () => boolean;
  /** Gölge haritası yeniden çizilmeli mi — yalnız içerik değişince (kamera dönmesi değil). */
  golgeKirliMi: () => boolean;
  dispose: () => void;
}

/** Bu dosya boncuk izleyicisiyle mi açılmalı? (Değilse eski çizgi izleyicisi.) */
export function boncukKullanilabilir(g: Pick<ParsedGcode, "totalSegments">): boolean {
  const n = g.totalSegments;
  if (!(n > 0)) return false;
  return n <= (yazilimsalMi() ? BONCUK_BUTCESI_YAZILIMSAL : BONCUK_BUTCESI);
}

export function buildBeadScene(g: ParsedGcode, secenek: BoncukSecenekleri = {}): BoncukSahnesi {
  const N = g.totalSegments;
  const W = BONCUK_GENISLIK;
  const H = katmanKalinligi(g.layerRanges);
  const scene = new THREE.Scene();

  let palet = secenek.palette;
  let yardimcilar = secenek.showSupport === true;
  const renkler = boncukRenkleri(g, { palette: palet, showSupport: yardimcilar });

  // Ortak uniform nesneleri: katı, hayalet ve gölge materyali AYNI nesneleri okur.
  const sicakRenk = { value: new THREE.Color(SICAK_RENK) };
  const yanEgim = { value: YAN_EGIM };
  const ortak = boncukUniformlari(W, H, N, sicakRenk, yanEgim);

  const sablon = boncukSablonu();
  const { bas: aBas, son: aSon } = konumOznitelikleri(g.positions);
  const aRenk = new THREE.InstancedBufferAttribute(renkler, 4, true);

  // ── Basılan kısım ────────────────────────────────────────────────────────────
  const golgeli = N <= GOLGE_BUTCESI;
  const katiGeo = ornekGeometriKur(sablon, aBas, aSon, aRenk, N);
  const kati = katiNesneKur(katiGeo, ortak, golgeli);

  // ── Kalan kısmın taslağı (yalnız dış kabuk ve yüzeyler, tek katlı cam) ──────
  const hayaletGeo = ornekGeometriKur(sablon, aBas, aSon, aRenk, N);
  const hayalet = hayaletKur(hayaletGeo, ortak);

  // ── Sıcak iz ─────────────────────────────────────────────────────────────────
  const iz = sicakIzKur(sablon, W, H, sicakRenk, yanEgim);

  // ── Yerleşim: gcode koordinatları (Z yukarı) → sahne (Y yukarı) ─────────────
  const govde = bodyXYBounds(g);
  const cx = (govde.minX + govde.maxX) / 2;
  const cy = (govde.minY + govde.maxY) / 2;
  const spanX = Math.max(5, govde.maxX - govde.minX);
  const spanY = Math.max(5, govde.maxY - govde.minY);
  const tabanZ = g.bounds.minZ - H; // ilk katmanın ALTI tablaya otursun
  const spanZ = Math.max(2, g.bounds.maxZ - tabanZ);
  const olcu = { spanX, spanY, spanZ, olcek: Math.max(spanX, spanY, spanZ) };

  const model = new THREE.Group();
  model.position.set(-cx, -cy, -tabanZ);
  model.add(kati.nesne, hayalet.on, hayalet.renk, iz.nesne);
  const nozul = nozulKur(olcu.olcek, golgeli);
  model.add(nozul.grup);

  const cevir = new THREE.Group();
  cevir.rotation.x = -Math.PI / 2; // (x, y, z) → (x, z, -y)
  cevir.add(model);
  scene.add(cevir);

  const studyo = studyoKur(scene, olcu, golgeli);
  const { camera, hedef } = kameraKur(olcu);

  // ── İlerleme ────────────────────────────────────────────────────────────────
  let kirli = true;
  let golgeKirli = true;
  let ilerleme: number | null = null;
  let sicakIzi = 120;
  const pos = g.positions;

  const uygula = () => {
    kirli = true;
    golgeKirli = true;
    if (ilerleme == null || ilerleme >= N) {
      katiGeo.instanceCount = N;
      ortak.uHeadIndex.value = N;
      ortak.uHeadFrac.value = 1;
      ortak.uHotSpan.value = 0;
      hayalet.goster(false);
      iz.gizle();
      nozul.goster(false);
      return;
    }
    const k = Math.min(N - 1, bastakiSegment(ilerleme));
    const f = Math.min(1, Math.max(0.02, ilerleme - k));
    katiGeo.instanceCount = k + 1;
    ortak.uHeadIndex.value = k;
    ortak.uHeadFrac.value = f;
    ortak.uHotSpan.value = sicakIzi;
    hayalet.goster(true);
    // Parıltı: baştan geriye `sicakIzi` kadar segment, en yenisi en parlak.
    iz.doldur(pos, renkler, k, f, sicakIzi);
    const j = gorunenBas(renkler, k);
    if (j < 0) {
      nozul.goster(false);
      return;
    }
    const fj = j === k ? f : 1;
    const o = j * 6;
    nozul.konumla(pos[o] + (pos[o + 3] - pos[o]) * fj, pos[o + 1] + (pos[o + 4] - pos[o + 1]) * fj, pos[o + 2]);
    nozul.goster(true);
  };

  const yenidenBoya = () => {
    boncukRenkleri(g, { palette: palet, showSupport: yardimcilar }, renkler);
    aRenk.needsUpdate = true;
    uygula(); // parıltı görünürlüğü bayraklara bağlı
  };

  return {
    scene,
    camera,
    hedef,
    layerCount: g.layerRanges.length,
    totalSegments: N,
    golgeli,
    setLayer: (layerIdx: number) => {
      if (layerIdx < 0 || layerIdx >= g.layerRanges.length) {
        ilerleme = null;
        sicakIzi = 120;
      } else {
        const katman = g.layerRanges[layerIdx];
        ilerleme = katman.end;
        // Katmana kilitli görünümde parıltı katmanın son üçte birini kaplar: nozulun az önce
        // geçtiği yer seçilsin. Sabit 120 şerit büyük katmanda bir nokta kadar kalıyordu.
        sicakIzi = Math.max(120, Math.min(HALE_KAPASITE, Math.round((katman.end - katman.start) * 0.3)));
      }
      uygula();
    },
    setProgress: (p: number | null, sicak?: number) => {
      ilerleme = p == null ? null : Math.max(0, Math.min(N, p));
      sicakIzi = Math.max(24, sicak ?? 120);
      uygula();
    },
    layerAtProgress: (p: number) => ilerlemeKatmani(g.layerRanges, p),
    setPalette: (p: VizPalette) => {
      palet = p;
      yenidenBoya();
    },
    setShowSupport: (goster: boolean) => {
      if (yardimcilar === goster) return;
      yardimcilar = goster;
      yenidenBoya();
    },
    setResolution: () => {
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
      katiGeo.dispose();
      hayaletGeo.dispose();
      kati.dispose();
      hayalet.dispose();
      iz.dispose();
      nozul.dispose();
      studyo.dispose();
    },
  };
}
