/**
 * BOŞTA ÇİZİM YOK — sahne "kirli" bayrağı.
 *
 * İzleyicilerin çizim döngüsü koşulsuz `renderer.render()` çağırıyordu: hiçbir şey
 * değişmese bile birebir aynı kare saniyede 60 kez çiziliyordu. Electron'da
 * `backgroundThrottling: false` olduğu için pencere tepsiye alınsa bile devam ediyordu —
 * tarayıcının doğal freni bu uygulamada yok.
 *
 * Bayrak bileşende değil SAHNEDE duruyor; yani sahneyi değiştiren bir kapı eklenip
 * "kirlet" demeyi unutmak mümkün olmasın. Bu dosya tam olarak o sözleşmeyi kilitler:
 * her genel ayarlayıcı sahneyi kirletmeli, hiçbir şey yapılmadığında bayrak DÜŞMELİ.
 */
import { describe, expect, it } from "vitest";
import { buildVizScene } from "./three-scene";
import { FEATURE_OUTER, FEATURE_INFILL, FEATURE_SKIRT, type ParsedGcode } from "./viz-pack";

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

describe("sahne kirli bayrağı", () => {
  it("ilk kare her zaman çizilir", () => {
    const viz = buildVizScene(ornek(), {});
    expect(viz.kirliMi()).toBe(true);
  });

  it("okununca sıfırlanır — hiçbir şey değişmediyse ikinci kez çizim yok", () => {
    const viz = buildVizScene(ornek(), {});
    viz.kirliMi();
    expect(viz.kirliMi()).toBe(false);
    expect(viz.kirliMi()).toBe(false);
  });

  it("katman değiştirmek sahneyi kirletir", () => {
    const viz = buildVizScene(ornek(), {});
    viz.kirliMi();
    viz.setLayer(0);
    expect(viz.kirliMi()).toBe(true);
  });

  it("palet değiştirmek sahneyi kirletir", () => {
    const viz = buildVizScene(ornek(), {});
    viz.kirliMi();
    viz.setPalette({ tools: ["#00FF00"] } as Parameters<typeof viz.setPalette>[0]);
    expect(viz.kirliMi()).toBe(true);
  });

  it("yardımcı parçaları göstermek sahneyi kirletir", () => {
    const viz = buildVizScene(ornek(), {});
    viz.kirliMi();
    viz.setShowSupport(true);
    expect(viz.kirliMi()).toBe(true);
  });

  it("çözünürlük değişimi sahneyi kirletir — çizgi kalınlığı piksele bağlı", () => {
    const viz = buildVizScene(ornek(), {});
    viz.kirliMi();
    viz.setResolution(800, 600);
    expect(viz.kirliMi()).toBe(true);
  });
});
