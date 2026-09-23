/**
 * BONCUK SAHNESİ — izleyicinin şeritleri dilimleyici gibi katı çizmesi.
 *
 * NEDEN TEST: yama three'nin standart şaderlerindeki ÇAPALARA dayanıyor. three sürüm
 * yükseltince biri değişirse `String.replace` sessizce hiçbir şey yapmaz, model ya hiç
 * çizilmez ya da eski hâliyle görünür — tsc, eslint ve diğer testler tertemiz geçerken
 * ([[improvement-never-reaches-screen]]). Ayrıca ilerleme hesabı (hangi segment basılıyor,
 * hangi katmandayız) ekranda görünen her şeyin temeli.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  BAYRAK_HAYALET, BAYRAK_KATI, BONCUK_SADER_SURUMU, YAMA_NOKTALARI,
  bastakiSegment, boncukRenkleri, boncukSablonu, buildBeadScene, ilerlemeKatmani, katmanKalinligi,
  okunurRenk,
} from "./bead-scene";
import { gorunenBas } from "./boncuk-ortak";
import {
  FEATURE_INFILL, FEATURE_INNER, FEATURE_OTHER, FEATURE_OUTER, FEATURE_SKIRT, FEATURE_SOLID,
  FEATURE_SUPPORT, type ParsedGcode,
} from "./viz-pack";

const ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

/**
 * Üç katmanlı küçük bir baskı: her katmanda 4 segmentlik kare dış duvar + 1 iç duvar
 * + 1 dolgu; ilk katmanda bir de destek segmenti.
 */
function ornekBaski(): ParsedGcode {
  const seg: number[] = [];
  const features: number[] = [];
  const layerRanges: ParsedGcode["layerRanges"] = [];
  const ekle = (x1: number, y1: number, x2: number, y2: number, z: number, f: number) => {
    seg.push(x1, y1, z, x2, y2, z);
    features.push(f);
  };
  for (let l = 0; l < 3; l++) {
    const z = 0.2 * (l + 1);
    const start = features.length;
    ekle(0, 0, 10, 0, z, FEATURE_OUTER);
    ekle(10, 0, 10, 10, z, FEATURE_OUTER);
    ekle(10, 10, 0, 10, z, FEATURE_OUTER);
    ekle(0, 10, 0, 0, z, FEATURE_OUTER);
    ekle(1, 1, 9, 1, z, FEATURE_INNER);
    ekle(2, 2, 8, 8, z, FEATURE_INFILL);
    if (l === 0) ekle(20, 0, 25, 0, z, FEATURE_SUPPORT);
    layerRanges.push({ z, start, end: features.length, byteOffset: l * 1000 });
  }
  const n = features.length;
  return {
    positions: new Float32Array(seg),
    features: new Uint8Array(features),
    tools: new Uint8Array(n),
    layerRanges,
    bounds: { minX: 0, maxX: 25, minY: 0, maxY: 10, minZ: 0.2, maxZ: 0.6 },
    totalSegments: n,
    scannedSegments: n,
    toolCount: 1,
    filamentColors: ["#FF7A30"],
    fileSize: 3000,
    thinLevel: 0,
  };
}

/** Sahnedeki boncuk materyallerini önbellek anahtarına göre bul. */
function boncukNesneleri(scene: THREE.Scene): Map<string, THREE.Mesh> {
  const m = new Map<string, THREE.Mesh>();
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.Material;
    const anahtar = mat.customProgramCacheKey?.();
    if (anahtar?.startsWith(BONCUK_SADER_SURUMU)) m.set(anahtar.slice(BONCUK_SADER_SURUMU.length + 1), mesh);
  });
  return m;
}

/** Nozul grubu: içindeki sıcak uç ışığının ebeveyni. */
function nozulGrubu(scene: THREE.Scene): THREE.Object3D {
  let grup: THREE.Object3D | null = null;
  scene.traverse((o) => { if ((o as THREE.PointLight).isPointLight) grup = o.parent; });
  if (!grup) throw new Error("nozul yok");
  return grup;
}

/** three'nin programı derlerken yaptığını taklit et: gerçek şablon şaderine yamayı uygula. */
function yamaliSader(mat: THREE.Material, kaynak: { vertexShader: string; fragmentShader: string }) {
  const shader = {
    vertexShader: kaynak.vertexShader,
    fragmentShader: kaynak.fragmentShader,
    uniforms: {} as Record<string, THREE.IUniform>,
  };
  (mat.onBeforeCompile as unknown as (s: typeof shader) => void)(shader);
  return shader;
}

describe("katman yüksekliği", () => {
  it("ardışık Z farklarının ortancası — kalın ilk katman bozmaz", () => {
    expect(katmanKalinligi([{ z: 0.3 }, { z: 0.5 }, { z: 0.7 }, { z: 0.9 }])).toBeCloseTo(0.2, 5);
  });
  it("tek katmanda katmanın kendi Z'si, hiç bilgi yoksa 0,2", () => {
    expect(katmanKalinligi([{ z: 0.28 }])).toBeCloseTo(0.28, 5);
    expect(katmanKalinligi([])).toBe(0.2);
  });
});

describe("ilerleme → baştaki segment ve katman", () => {
  it("kesirli ilerleme baştaki segmenti verir; tam sayıda bir sonrakine GEÇİLMEZ", () => {
    expect(bastakiSegment(5.3)).toBe(5);
    expect(bastakiSegment(5)).toBe(4);
    expect(bastakiSegment(0)).toBe(0);
    expect(bastakiSegment(0.4)).toBe(0);
  });

  it("katman sonuna kilitlenen görünüm o katmanda kalır, boş katman atlanır", () => {
    const katmanlar = [{ start: 0, end: 4 }, { start: 4, end: 4 }, { start: 4, end: 9 }];
    expect(ilerlemeKatmani(katmanlar, 0)).toBe(0);
    expect(ilerlemeKatmani(katmanlar, 4)).toBe(0);
    expect(ilerlemeKatmani(katmanlar, 4.5)).toBe(2);
    expect(ilerlemeKatmani(katmanlar, 9)).toBe(2);
    expect(ilerlemeKatmani(katmanlar, 100)).toBe(2);
    expect(ilerlemeKatmani([], 3)).toBe(-1);
  });
});

describe("renk ve bayraklar", () => {
  const tekSegment = (f: number, secenek: Parameters<typeof boncukRenkleri>[1] = {}, dosyaRengi: string[] = ["#FF7A30"]) =>
    boncukRenkleri(
      { features: new Uint8Array([f]), tools: new Uint8Array([0]), toolCount: 1, filamentColors: dosyaRengi, totalSegments: 1 },
      secenek,
    );

  it("gövde çizilir; kalan kısmın taslağına yalnız dış kabuk ve yüzeyler girer", () => {
    expect(tekSegment(FEATURE_OUTER)[3]).toBe(BAYRAK_KATI | BAYRAK_HAYALET);
    expect(tekSegment(FEATURE_SOLID)[3]).toBe(BAYRAK_KATI | BAYRAK_HAYALET);
    expect(tekSegment(FEATURE_INNER)[3]).toBe(BAYRAK_KATI);
    expect(tekSegment(FEATURE_INFILL)[3]).toBe(BAYRAK_KATI);
    expect(tekSegment(FEATURE_OTHER)[3]).toBe(BAYRAK_KATI);
  });

  it("destek ve etek varsayılan olarak ÇİZİLMEZ, istenirse çizilir", () => {
    expect(tekSegment(FEATURE_SUPPORT)[3]).toBe(0);
    expect(tekSegment(FEATURE_SKIRT)[3]).toBe(0);
    expect(tekSegment(FEATURE_SUPPORT, { showSupport: true })[3] & BAYRAK_KATI).toBe(BAYRAK_KATI);
    expect(tekSegment(FEATURE_SKIRT, { showSupport: true })[3] & BAYRAK_KATI).toBe(BAYRAK_KATI);
  });

  it("yazıcının bildirdiği renk dosyadakinin önüne geçer", () => {
    const c = tekSegment(FEATURE_OUTER, { palette: { toolColors: ["#1E90FF"] } });
    expect([c[0], c[1], c[2]]).toEqual([0x1e, 0x90, 0xff]);
    const d = tekSegment(FEATURE_OUTER);
    expect([d[0], d[1], d[2]]).toEqual([0xff, 0x7a, 0x30]);
  });

  it("siyah filament koyu tablada kaybolmasın — kömür grisine kalkar, parlak renge dokunulmaz", () => {
    const c = tekSegment(FEATURE_OUTER, { palette: { toolColors: ["#000000"] } });
    expect(Math.min(c[0], c[1], c[2])).toBeGreaterThanOrEqual(50);
    expect(okunurRenk([0, 0, 0])).toEqual([0.2, 0.2, 0.2]);
    expect(okunurRenk([1, 0.4, 0.1])).toEqual([1, 0.4, 0.1]);
  });

  it("renk bilgisi yoksa özellik renkleri (dış duvar turuncu)", () => {
    const c = tekSegment(FEATURE_OUTER, {}, []);
    expect(c[0]).toBeGreaterThan(200);
    expect(c[2]).toBeLessThan(90);
  });
});

describe("nozulun oturacağı segment", () => {
  it("baş görünüyorsa kendisi, gizliyse geriye doğru son görünen, hiç yoksa -1", () => {
    // Üç segment (RGBA): görünen, görünen, gizli.
    const b = new Uint8Array([0, 0, 0, BAYRAK_KATI, 0, 0, 0, BAYRAK_KATI | BAYRAK_HAYALET, 0, 0, 0, 0]);
    expect(gorunenBas(b, 0)).toBe(0);
    expect(gorunenBas(b, 1)).toBe(1);
    expect(gorunenBas(b, 2)).toBe(1);
    expect(gorunenBas(new Uint8Array(8), 1)).toBe(-1);
  });
});

describe("şerit şablonu", () => {
  it("dikdörtgen kesitli açık prizma: 16 köşe, 8 üçgen, hepsi DIŞA bakıyor", () => {
    const geo = boncukSablonu();
    const pos = geo.getAttribute("position");
    const nor = geo.getAttribute("normal");
    const idx = geo.getIndex()!;
    expect(pos.count).toBe(16);
    expect(idx.count).toBe(24);
    const v = (i: number) => new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    const n = (i: number) => new THREE.Vector3(nor.getX(i), nor.getY(i), nor.getZ(i));
    for (let t = 0; t < idx.count; t += 3) {
      const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
      const yuz = new THREE.Vector3().subVectors(v(b), v(a)).cross(new THREE.Vector3().subVectors(v(c), v(a)));
      const ort = n(a).add(n(b)).add(n(c));
      expect(yuz.dot(ort)).toBeGreaterThan(0);
    }
  });

  it("kesit katmanı tam doldurur: yükseklik ±0,5, genişlik ±0,5", () => {
    const pos = boncukSablonu().getAttribute("position");
    let zMax = 0, yMax = 0;
    for (let i = 0; i < pos.count; i++) {
      zMax = Math.max(zMax, Math.abs(pos.getZ(i)));
      yMax = Math.max(yMax, Math.abs(pos.getY(i)));
    }
    expect(zMax).toBeCloseTo(0.5, 5);
    expect(yMax).toBeCloseTo(0.5, 5);
  });
});

describe("şader yaması", () => {
  it("ÇAPALAR hâlâ tutuyor — three'nin şaderlerinde beklenen satırlar var", () => {
    const std = THREE.ShaderLib.standard;
    for (const c of [YAMA_NOKTALARI.ortak, YAMA_NOKTALARI.normal, YAMA_NOKTALARI.konum]) {
      expect(std.vertexShader).toContain(c);
    }
    for (const c of [YAMA_NOKTALARI.ortak, YAMA_NOKTALARI.renk, YAMA_NOKTALARI.isima]) {
      expect(std.fragmentShader).toContain(c);
    }
    expect(THREE.ShaderLib.depth.vertexShader).toContain(YAMA_NOKTALARI.konum);
    expect(THREE.ShaderLib.depth.vertexShader).toContain(YAMA_NOKTALARI.ortak);
    expect(THREE.ShaderLib.basic.fragmentShader).toContain(YAMA_NOKTALARI.renk);
    expect(THREE.ShaderLib.basic.vertexShader).toContain(YAMA_NOKTALARI.konum);
  });

  it("yama GERÇEKTEN uygulanıyor — dört materyalin hepsi (katı, taslak, parıltı, gölge)", () => {
    const sahne = buildBeadScene(ornekBaski());
    const nesneler = boncukNesneleri(sahne.scene);
    expect([...nesneler.keys()].sort()).toEqual(["hale", "hayalet", "hayalet-derinlik", "kati"]);

    const kati = nesneler.get("kati")!;
    const katiSader = yamaliSader(kati.material as THREE.Material, THREE.ShaderLib.standard);
    expect(katiSader.vertexShader).toContain("gl_InstanceID");
    expect(katiSader.vertexShader).toContain("attribute vec3 iStart");
    expect(katiSader.vertexShader).not.toContain(YAMA_NOKTALARI.konum);
    expect(katiSader.vertexShader).not.toContain(YAMA_NOKTALARI.normal);
    expect(katiSader.fragmentShader).toContain("sRGBTransferEOTF( vec4( vBead.rgb");
    expect(katiSader.fragmentShader).toContain("totalEmissiveRadiance += uHotColor");

    // Gölge geçişi de AYNI köşe kodunu kullanmalı — yoksa gölge tabladaki birim prizmanın
    // gölgesi olur, modelinki değil.
    const derinlik = kati.customDepthMaterial!;
    const derinlikSader = yamaliSader(derinlik, THREE.ShaderLib.depth);
    expect(derinlikSader.vertexShader).toContain("gl_InstanceID");
    expect(derinlikSader.vertexShader).not.toContain(YAMA_NOKTALARI.konum);

    const hale = yamaliSader(nesneler.get("hale")!.material as THREE.Material, THREE.ShaderLib.basic);
    expect(hale.fragmentShader).toContain("uHotColor * pow( vBead.a");

    const anahtarlar = [
      kati.material, derinlik, nesneler.get("hayalet")!.material,
      nesneler.get("hayalet-derinlik")!.material, nesneler.get("hale")!.material,
    ].map((m) => (m as THREE.Material).customProgramCacheKey());
    expect(new Set(anahtarlar).size).toBe(5);
    sahne.dispose();
  });

  /**
   * Taslak her yüzeyde saydam çizilince büyük parçada yüzeyler üst üste katlanıp taslağı
   * opak beyaza çeviriyordu (209 mm'lik ahtapotta kesit hiç görünmedi). Tek katlı cam:
   * önce yalnız derinlik, sonra renk yalnız en yakın yüzeye; katı kısım İKİSİNDEN önce.
   */
  it("kalan kısmın taslağı tek katlı: önce derinlik, sonra yalnız en yakın yüzey", () => {
    const sahne = buildBeadScene(ornekBaski());
    const n = boncukNesneleri(sahne.scene);
    const on = n.get("hayalet-derinlik")!;
    const renk = n.get("hayalet")!;
    const onMat = on.material as THREE.Material;
    const renkMat = renk.material as THREE.Material;
    expect(onMat.colorWrite).toBe(false);
    expect(onMat.depthWrite).toBe(true);
    expect(renkMat.depthFunc).toBe(THREE.EqualDepth);
    expect(renkMat.depthWrite).toBe(false);
    // Aynı geometri → aynı derinlik değerleri (EqualDepth ancak böyle tutar).
    expect(on.geometry).toBe(renk.geometry);
    // Katı kısım derinlik geçişinden ÖNCE çizilmeli.
    expect(n.get("kati")!.renderOrder).toBeLessThan(on.renderOrder);
    expect(on.renderOrder).toBeLessThan(renk.renderOrder);
    // Derinlik geçişi de aynı köşe kodunu kullanıyor.
    const onSader = yamaliSader(onMat, THREE.ShaderLib.standard);
    expect(onSader.vertexShader).toContain("gl_InstanceID");
    sahne.setLayer(1);
    expect(on.visible).toBe(true);
    sahne.setLayer(-1);
    expect(on.visible).toBe(false);
    sahne.dispose();
  });
});

describe("ilerleme sahneye doğru yansıyor", () => {
  it("katman kilidi: o katmana kadar basılı, kalan kısım taslak, nozul görünür", () => {
    const g = ornekBaski();
    const sahne = buildBeadScene(g);
    const nesneler = boncukNesneleri(sahne.scene);
    const katiGeo = nesneler.get("kati")!.geometry as THREE.InstancedBufferGeometry;

    sahne.setLayer(-1);
    expect(katiGeo.instanceCount).toBe(g.totalSegments);
    expect(nesneler.get("hayalet")!.visible).toBe(false);

    sahne.setLayer(0);
    expect(katiGeo.instanceCount).toBe(g.layerRanges[0].end);
    expect(nesneler.get("hayalet")!.visible).toBe(true);
    expect(nesneler.get("hale")!.visible).toBe(true);
    expect(sahne.layerAtProgress(g.layerRanges[0].end)).toBe(0);

    // Kesirli: 9,5 → 9. segment yarıda (katman 1'in 3. segmenti).
    sahne.setProgress(9.5);
    expect(katiGeo.instanceCount).toBe(10);
    expect(sahne.layerAtProgress(9.5)).toBe(1);

    sahne.setProgress(null);
    expect(katiGeo.instanceCount).toBe(g.totalSegments);
    sahne.dispose();
  });

  it("gizli şerit (destek, temizleme kulesi) basılırken nozul modelde son basılan noktada bekler", () => {
    const g = ornekBaski();
    const sahne = buildBeadScene(g);
    const nozul = nozulGrubu(sahne.scene);
    sahne.setProgress(6.5); // 6. segment destek — varsayılan olarak çizilmiyor
    expect(nozul.visible).toBe(true);
    expect(nozul.position.x).toBeCloseTo(8, 3); // dolgunun (5. segment) ucu
    expect(nozul.position.y).toBeCloseTo(8, 3);
    // Destekler gösterilince nozul yazıcının gerçekten bastığı yere geçer.
    sahne.setShowSupport(true);
    expect(nozul.position.x).toBeCloseTo(22.5, 3);
    sahne.dispose();
  });

  it("değişiklik gölgeyi de kirletir, kamera dönmesi kirletmez", () => {
    const sahne = buildBeadScene(ornekBaski());
    sahne.kirliMi();
    sahne.golgeKirliMi();
    expect(sahne.golgeKirliMi()).toBe(false);
    sahne.setLayer(1);
    expect(sahne.kirliMi()).toBe(true);
    expect(sahne.golgeKirliMi()).toBe(true);
    sahne.dispose();
  });
});

describe("izleyici yeni çiziciye bağlı", () => {
  const izleyici = fs.readFileSync(path.join(ROOT, "src/components/printers/GcodeViewer.tsx"), "utf8");
  const mesh = fs.readFileSync(path.join(ROOT, "src/components/printers/MeshViewer.tsx"), "utf8");

  it("yol izleyicisi boncuk sahnesini kuruyor, yedek yalnız uygun olmayan dosyada", () => {
    expect(izleyici).toContain("boncukKullanilabilir(geom)");
    expect(izleyici).toContain("buildBeadScene(geom");
  });

  it("iki izleyici de kendiliğinden dönüyor ve tutunca duruyor", () => {
    for (const kaynak of [izleyici, mesh]) {
      expect(kaynak).toMatch(/\.autoRotate = donmeRef\.current && !tutuyor/);
      expect(kaynak).toContain('addEventListener("start"');
    }
  });

  it("gölge haritası kamera dönerken yeniden çizilmiyor", () => {
    expect(izleyici).toContain("renderer.shadowMap.autoUpdate = false");
    expect(izleyici).toContain("golgeKirliMi()");
  });
});
