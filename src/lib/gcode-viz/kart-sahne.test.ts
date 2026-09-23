/**
 * KART SAHNESİ — yazıcı kartındaki canlı 3B'nin hafif sürümü.
 *
 * Pano gün boyu açık ve birden çok kart aynı anda dönüyor: seyreltme bozulursa kart ya ağırlaşır
 * (zayıf GPU'da sürekli dolu) ya da modelin bir kısmı kaybolur. Bant (basılan katmanın tam
 * ayrıntısı) kayarsa nozul yanlış yerde görünür.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { scanGcodeText } from "./parse-gcode";
import { decodeVizPack, encodeVizPack, yolZamaniKur } from "./viz-pack";
import { BONCUK_SADER_SURUMU, renkTablosu } from "./boncuk-ortak";
import { buildKartSahnesi, kabukKati, kabukKatmaniMi, kabukKur, paketGovdeSiniri, paketOkuyucu } from "./kart-sahne";
import { katmanBasSegment, katmanSonSegment } from "./canli-konum";

/** Katman başına: dış duvar karesi (4 segment) + iç duvar (1) + dolgu (1). */
function baski(katman: number): string {
  const s: string[] = ["M83", "G1 F1200"];
  for (let l = 0; l < katman; l++) {
    const z = +(0.2 * (l + 1)).toFixed(2);
    s.push(";LAYER_CHANGE", `;Z:${z}`, ";TYPE:Outer wall", `G0 X0 Y0 Z${z}`);
    s.push("G1 X20 Y0 E0.5", "G1 X20 Y20 E0.5", "G1 X0 Y20 E0.5", "G1 X0 Y0 E0.5");
    s.push(";TYPE:Inner wall", "G0 X2 Y2", "G1 X18 Y2 E0.4");
    s.push(";TYPE:Sparse infill", "G0 X4 Y4", "G1 X16 Y16 E0.4");
  }
  return s.join("\n") + "\n";
}

describe("seyreltme katı", () => {
  it("~160 katmana kadar seyreltme yok, üstünde katlanır, tavan 8", () => {
    expect(kabukKati(120)).toBe(1);
    expect(kabukKati(160)).toBe(1);
    expect(kabukKati(1046)).toBe(7);
    expect(kabukKati(5000)).toBe(8);
  });

  it("her kat'ıncı katman ve EN ÜST katman kabukta (tepe kaybolmaz)", () => {
    expect(kabukKatmaniMi(2, 3, 10)).toBe(true);
    expect(kabukKatmaniMi(3, 3, 10)).toBe(false);
    expect(kabukKatmaniMi(9, 3, 10)).toBe(true);
  });
});

describe("kabuk", () => {
  const p = scanGcodeText(baski(9));
  const { tablo, toolCount } = renkTablosu(p.toolCount, p.filamentColors);

  it("yalnız dış duvar/yüzey girer, iç duvar ve dolgu girmez", () => {
    const k = kabukKur(p, 1, tablo, toolCount);
    // 9 katman × 4 dış duvar segmenti.
    expect(k.katmanSonu[8]).toBe(36);
  });

  it("seyreltilince yalnız seçilen katmanlar girer; katman sayacı artan", () => {
    const k = kabukKur(p, 3, tablo, toolCount);
    // Katman 2, 5, 8 → 3 × 4.
    expect(k.katmanSonu[8]).toBe(12);
    for (let i = 1; i < 9; i++) expect(k.katmanSonu[i]).toBeGreaterThanOrEqual(k.katmanSonu[i - 1]);
    expect(k.katmanSonu[1]).toBe(0);
    expect(k.katmanSonu[2]).toBe(4);
  });
});

function sahneNesneleri(scene: THREE.Scene) {
  const m = new Map<string, THREE.Mesh[]>();
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const k = (mesh.material as THREE.Material).customProgramCacheKey?.();
    if (!k?.startsWith(BONCUK_SADER_SURUMU)) return;
    const ad = k.slice(BONCUK_SADER_SURUMU.length + 1);
    m.set(ad, [...(m.get(ad) ?? []), mesh]);
  });
  return m;
}

describe("kart sahnesi", () => {
  const p = scanGcodeText(baski(9));
  const yz = yolZamaniKur(p);

  it("tam modelde kabuğun tamamı, bant/taslak/nozul yok", () => {
    const s = buildKartSahnesi(p, yz, { golgeli: false });
    s.setProgress(null);
    const n = sahneNesneleri(s.scene);
    const katilar = n.get("kati")!;
    expect(katilar).toHaveLength(2); // kabuk + bant
    const kabuk = katilar.find((x) => x.visible && (x.geometry as THREE.InstancedBufferGeometry).instanceCount > 0)!;
    expect((kabuk.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(s.tani.kabukSegment);
    expect(n.get("hayalet")![0].visible).toBe(false);
    s.dispose();
  });

  it("baskı ortasında: bant basılan katmanı taşır, nozul orada", () => {
    const s = buildKartSahnesi(p, yz, { golgeli: false });
    const bas = katmanBasSegment(yz, 4);
    s.setProgress(bas + 2.5);
    const n = sahneNesneleri(s.scene);
    const bant = n.get("kati")!.find((x) => x.visible && (x.geometry as THREE.InstancedBufferGeometry).instanceCount <= 8);
    expect(bant).toBeTruthy();
    expect(n.get("hayalet")![0].visible).toBe(true);
    s.dispose();
  });

  it("paketten segment okuyucu açılmış geometriyle aynı uçları verir", () => {
    const oku = paketOkuyucu(p, yz);
    const c = new Float64Array(5);
    const i = katmanBasSegment(yz, 3); // katman 3'ün ilk segmenti: (0,0) → (20,0)
    oku(i, c);
    expect(c[0]).toBeCloseTo(0, 2);
    expect(c[2]).toBeCloseTo(20, 2);
    expect(c[4]).toBeCloseTo(0.8, 3);
    expect(katmanSonSegment(yz, 3) - katmanBasSegment(yz, 3)).toBe(6);
  });
});

describe("nozul", () => {
  it("gizli şerit (destek) basılırken nozul modelde son basılan noktada bekler", () => {
    const s: string[] = ["M83", "G1 F1200"];
    for (let l = 0; l < 3; l++) {
      const z = +(0.2 * (l + 1)).toFixed(2);
      s.push(";LAYER_CHANGE", `;Z:${z}`, ";TYPE:Outer wall", `G0 X0 Y0 Z${z}`);
      s.push("G1 X20 Y0 E0.5", "G1 X20 Y20 E0.5", "G1 X0 Y20 E0.5", "G1 X0 Y0 E0.5");
      s.push(";TYPE:Support", "G0 X40 Y0", "G1 X50 Y0 E0.4");
    }
    const p = scanGcodeText(s.join("\n") + "\n");
    const yz = yolZamaniKur(p);
    const sahne = buildKartSahnesi(p, yz, { golgeli: false });
    let nozul: THREE.Object3D | null = null;
    sahne.scene.traverse((o) => { if ((o as THREE.PointLight).isPointLight) nozul = o.parent; });
    // Katman 1: 4 dış duvar segmenti + 1 destek; destek segmentinin ortası.
    sahne.setProgress(katmanBasSegment(yz, 1) + 4.5);
    const n = nozul as unknown as THREE.Object3D;
    expect(n.visible).toBe(true);
    expect(n.position.x).toBeCloseTo(0, 1); // dış duvarın son ucu (0,0), desteğin (45,0) değil
    expect(n.position.y).toBeCloseTo(0, 1);
    sahne.dispose();
  });
});

describe("kadraj", () => {
  it("başlangıç çizgisi (tablanın önü) kadraja girmez — model kartı doldurur", () => {
    // U1 gibi: ilk katmanda tablanın önüne uzun bir başlangıç çizgisi, model arkada.
    const s = baski(3).replace(";LAYER_CHANGE", ";LAYER_CHANGE\n;TYPE:Custom\nG0 X-150 Y-150 Z0.2\nG1 X-50 Y-150 E3");
    const p = scanGcodeText(s);
    const g = paketGovdeSiniri(p);
    expect(g.minX).toBeGreaterThanOrEqual(-0.01);
    expect(g.minY).toBeGreaterThanOrEqual(-0.01);
    expect(g.maxX).toBeCloseTo(20, 1);
    // Paketin kendi sınırı çizgiyi kapsıyor (kadraj için kullanılmamalı).
    expect(p.bounds.minX).toBeLessThan(-100);
  });
});

describe("paket sürümü", () => {
  it("eski (v2) paket reddedilir — önbellekteki eski paket yeniden üretilir", () => {
    const tampon = encodeVizPack(scanGcodeText(baski(2)));
    const dv = new DataView(tampon);
    const uz = dv.getUint32(4, true);
    const baslik = new TextDecoder().decode(new Uint8Array(tampon, 8, uz)).replace('"v":3', '"v":2');
    new Uint8Array(tampon, 8, uz).set(new TextEncoder().encode(baslik));
    expect(() => decodeVizPack(tampon)).toThrow(/eski sürüm/);
  });

  it("v3 paket gidiş dönüşte yol zaman çizelgesini korur", () => {
    const p = scanGcodeText(baski(3));
    const r = decodeVizPack(encodeVizPack(p));
    expect(Array.from(r.pathByteStart)).toEqual(Array.from(p.pathByteStart));
    expect(Array.from(r.pathTimeEnd)).toEqual(Array.from(p.pathTimeEnd));
  });
});
