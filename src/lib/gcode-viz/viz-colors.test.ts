/**
 * Görselleştirme renk/gövde kuralları.
 *
 * NEDEN VARLAR: model siyah-beyaz basılıyordu ama ekranda turuncu-mavi görünüyordu — çünkü
 * segmentler basıldıkları KAFAYA göre değil, yalnız çizim tipine göre renklendiriliyordu.
 * Ayrıca dolgu, destek ve etek de gövdeyle aynı kalınlıkta çizildiği için kart görselinde
 * baskı ilerlemesi gözle ayırt edilemiyordu (doluluk baskı boyunca birkaç puan oynuyordu).
 *
 * Testler üç kuralı kilitler: (1) gerçek filament renkleri kullanılır, (2) koyu zeminde
 * kaybolmayacak bir parlaklık tabanı vardır, (3) kart kipinde yalnız gövde çizilir.
 */
import { describe, expect, it } from "vitest";
import { vizColorTable } from "./three-scene";
import {
  FEATURE_OUTER, FEATURE_INNER, FEATURE_INFILL, FEATURE_SUPPORT, FEATURE_SOLID, FEATURE_SKIRT,
  type ParsedGcode,
} from "./viz-pack";

function fakeGeom(over: Partial<ParsedGcode> = {}): ParsedGcode {
  return {
    positions: new Float32Array(0),
    features: new Uint8Array(0),
    tools: new Uint8Array(0),
    layerRanges: [],
    bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 },
    totalSegments: 0,
    scannedSegments: 0,
    toolCount: 1,
    filamentColors: [],
    fileSize: 0,
    thinLevel: 0,
    ...over,
  };
}

const lum = (rgb: Float32Array, i: number) => 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];

describe("segment renkleri araçtan gelir", () => {
  it("iki kafalı baskıda her kafa KENDİ filament rengini alır", () => {
    const g = fakeGeom({ toolCount: 2, filamentColors: ["#000000", "#FFFFFF"] });
    const { rgb, toolCount } = vizColorTable(g);
    expect(toolCount).toBe(2);
    const black = FEATURE_OUTER * toolCount + 0;
    const white = FEATURE_OUTER * toolCount + 1;
    expect(lum(rgb, white)).toBeGreaterThan(lum(rgb, black));
  });

  it("dışarıdan verilen palet dosyadaki renklerin ÜSTÜNDE tutulur", () => {
    const g = fakeGeom({ toolCount: 1, filamentColors: ["#FFFFFF"] });
    const { rgb } = vizColorTable(g, { palette: { toolColors: ["#FF0000"] } });
    const i = FEATURE_OUTER;
    expect(rgb[i * 3]).toBeGreaterThan(0.8);      // kırmızı bileşen baskın
    expect(rgb[i * 3 + 1]).toBeLessThan(0.5);
  });

  it("siyah filament koyu zeminde kaybolmayacak kadar açılır", () => {
    const g = fakeGeom({ toolCount: 1, filamentColors: ["#000000"] });
    const { rgb } = vizColorTable(g);
    expect(lum(rgb, FEATURE_OUTER)).toBeGreaterThan(0.35);
  });

  it("renk bilinmiyorsa çizim tipine göre yedek renk kullanılır", () => {
    const g = fakeGeom({ toolCount: 1, filamentColors: [] });
    const { rgb } = vizColorTable(g);
    // Dış duvar turuncu yedeğe düşer — kırmızı bileşen mavi bileşenden yüksek.
    expect(rgb[FEATURE_OUTER * 3]).toBeGreaterThan(rgb[FEATURE_OUTER * 3 + 2]);
  });
});

describe("gövde baskınlığı", () => {
  it("kart kipinde dolgu/destek/etek HİÇ çizilmez, gövde tam görünür", () => {
    const g = fakeGeom({ toolCount: 1, filamentColors: ["#FFAA00"] });
    const { alpha } = vizColorTable(g, { mode: "card" });
    expect(alpha[FEATURE_OUTER]).toBe(1);
    expect(alpha[FEATURE_INNER]).toBe(1);
    expect(alpha[FEATURE_SOLID]).toBe(1);
    expect(alpha[FEATURE_INFILL]).toBe(0);
    expect(alpha[FEATURE_SUPPORT]).toBe(0);
    expect(alpha[FEATURE_SKIRT]).toBe(0);
  });

  it("izleyicide dolgu/destek soluk kalır ama görünür", () => {
    const g = fakeGeom({ toolCount: 1, filamentColors: ["#FFAA00"] });
    const { alpha } = vizColorTable(g, { mode: "viewer" });
    expect(alpha[FEATURE_OUTER]).toBe(1);
    expect(alpha[FEATURE_INFILL]).toBeGreaterThan(0);
    expect(alpha[FEATURE_INFILL]).toBeLessThan(0.5);
  });

  it("dış duvar iç duvardan parlaktır (siluet öne çıksın)", () => {
    const g = fakeGeom({ toolCount: 1, filamentColors: ["#FFFFFF"] });
    const { rgb } = vizColorTable(g);
    expect(lum(rgb, FEATURE_OUTER)).toBeGreaterThan(lum(rgb, FEATURE_INNER));
    expect(lum(rgb, FEATURE_SOLID)).toBeGreaterThan(lum(rgb, FEATURE_INFILL));
  });
});
