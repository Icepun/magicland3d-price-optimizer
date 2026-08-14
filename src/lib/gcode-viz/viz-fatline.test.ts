/**
 * KALIN GÖVDE ÇİZGİSİ — modelin katı bir cisim gibi görünmesini sağlayan katman.
 *
 * NEDEN VAR: WebGL'de `LineBasicMaterial` çizgileri her zaman 1px'dir; model bir tel kafes /
 * çizgi yumağı gibi duruyordu ("baskı sırasında makinenin hareket çizgilerini görüyoruz").
 * Gövde artık `LineSegments2` ile DÜNYA BİRİMLİ kalınlıkta çizilir.
 *
 * Bu dosya üç tuzağı kilitler:
 *  1) Kalın nesne YALNIZ gövde segmentlerini taşır (LineSegmentsGeometry alfa taşımaz;
 *     dolgu/destek/etek görünürlüğü alfayla yönetildiği için onlar ince nesnede kalmalı).
 *  2) Gövde ince nesnede SÖNDÜRÜLÜR — yoksa aynı yol iki kez çizilir, kalının üstünde
 *     tel kafes izi kalırdı.
 *  3) Katman ilerletme kalın nesnede `drawRange` DEĞİL `instanceCount` ile olur; eşleme
 *     gövde-dışı segmentler ayıklandığı için kaymamalı.
 */
import { describe, expect, it } from "vitest";
import { buildVizScene } from "./three-scene";
import {
  FEATURE_OUTER, FEATURE_INFILL, FEATURE_SKIRT, isBodyFeature, type ParsedGcode,
} from "./viz-pack";

/**
 * İki katmanlı sahte model. Katman 0: gövde, dolgu, gövde. Katman 1: etek, gövde.
 * Yani gövde segmentleri 0, 2, 4 → toplam 3.
 */
function ornek(): ParsedGcode {
  const features = new Uint8Array([FEATURE_OUTER, FEATURE_INFILL, FEATURE_OUTER, FEATURE_SKIRT, FEATURE_OUTER]);
  const n = features.length;
  const positions = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    positions[i * 6] = i; positions[i * 6 + 1] = 0; positions[i * 6 + 2] = 0;
    positions[i * 6 + 3] = i + 1; positions[i * 6 + 4] = 1; positions[i * 6 + 5] = 0;
  }
  return {
    positions, features, tools: new Uint8Array(n),
    layerRanges: [
      { z: 0.2, start: 0, end: 3, byteOffset: 0 },
      { z: 0.4, start: 3, end: 5, byteOffset: 100 },
    ],
    bounds: { minX: 0, maxX: 5, minY: 0, maxY: 1, minZ: 0, maxZ: 0.4 },
    totalSegments: n, scannedSegments: n, toolCount: 1,
    filamentColors: ["#FF0000"], fileSize: 0, thinLevel: 0,
  };
}

/** Sahnedeki kalın nesne (LineSegments2) — yoksa null. */
function kalinNesne(scene: { children: unknown[] }): { geometry: { instanceCount: number } } | null {
  const bul = (o: { children?: unknown[]; type?: string }): unknown => {
    if (o.type === "LineSegments2") return o;
    for (const c of (o.children ?? []) as { children?: unknown[]; type?: string }[]) {
      const r = bul(c);
      if (r) return r;
    }
    return null;
  };
  return bul(scene as never) as never;
}

describe("kalın gövde çizgisi", () => {
  it("izleyicide kalın nesne kurulur ve YALNIZ gövde segmentlerini taşır", () => {
    const g = ornek();
    const viz = buildVizScene(g, { mode: "viewer" });
    const fat = kalinNesne(viz.scene as never);
    expect(fat).not.toBeNull();
    const govdeSayisi = [...g.features].filter((f) => isBodyFeature(f)).length;
    expect(govdeSayisi).toBe(3);
    viz.setLayer(-1);
    expect(fat!.geometry.instanceCount).toBe(3);
    viz.dispose();
  });

  it("katman ilerletme gövde-dışı segmentleri ayıklayarak KAYMADAN eşlenir", () => {
    const g = ornek();
    const viz = buildVizScene(g, { mode: "viewer" });
    const fat = kalinNesne(viz.scene as never)!;
    // Katman 0'da gövde segmenti 0 ve 2 var (arada dolgu) → 2 tane.
    viz.setLayer(0);
    expect(fat.geometry.instanceCount).toBe(2);
    // Katman 1 eklenince etek atlanır, bir gövde daha gelir → 3.
    viz.setLayer(1);
    expect(fat.geometry.instanceCount).toBe(3);
    viz.dispose();
  });

  it("gövde İNCE nesnede söndürülür — aynı yol iki kez çizilmez", () => {
    const g = ornek();
    const viz = buildVizScene(g, { mode: "viewer" });
    const renk = viz.geometry.getAttribute("color");
    const dizi = renk.array as Uint8Array;
    for (let i = 0; i < g.totalSegments; i++) {
      const alfa = dizi[i * 8 + 3];
      if (isBodyFeature(g.features[i])) expect(alfa).toBe(0); // kalın nesne çiziyor
    }
    viz.dispose();
  });

  it("KART kipinde kalın nesne kurulmaz (küçük resim ince yoldan üretilir)", () => {
    const viz = buildVizScene(ornek(), { mode: "card" });
    expect(kalinNesne(viz.scene as never)).toBeNull();
    viz.dispose();
  });

  it("setResolution çağrılabilir — kalın nesne yokken de patlamaz", () => {
    const viz = buildVizScene(ornek(), { mode: "card" });
    expect(() => viz.setResolution(800, 600)).not.toThrow();
    viz.dispose();
  });
});
