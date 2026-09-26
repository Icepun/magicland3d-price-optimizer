import { describe, expect, it } from "vitest";
import {
  EK_FILAMENT_AZAMI,
  ekFilamentMaliyeti,
  ekFilamentleriOku,
  ekFilamentleriYaz,
  filamentFiyatHaritasi,
  toplamFilamentGrami,
} from "./filament-karisimi";
import { resolveProductCost } from "./product-cost";

/**
 * ÇOKLU FİLAMENT — "Piston Kupası'nda hem Porima X PLA hem Porima Silk PLA kullanılıyor."
 * İsteğe bağlı: çoğu ürün tek filamentle basılır; ekler boşken hiçbir şey değişmemeli.
 */
describe("ek filament kaydı", () => {
  it("bozuk/boş satırları atar, metin ve diziyi aynı okur", () => {
    const ham = [
      { filamentTypeId: "silk", gram: 20 },
      { filamentTypeId: "", gram: 5 },
      { filamentTypeId: "x", gram: 0 },
      { filamentTypeId: "y", gram: -3 },
      { filamentTypeId: "z", gram: "abc" },
      null,
    ];
    expect(ekFilamentleriOku(ham)).toEqual([{ filamentTypeId: "silk", gram: 20 }]);
    expect(ekFilamentleriOku(JSON.stringify(ham))).toEqual([{ filamentTypeId: "silk", gram: 20 }]);
    expect(ekFilamentleriOku("{bozuk")).toEqual([]);
    expect(ekFilamentleriOku(null)).toEqual([]);
  });

  it("boş liste kolonu boş bırakır (tek filament = eski davranış)", () => {
    expect(ekFilamentleriYaz([])).toBeNull();
    expect(ekFilamentleriYaz([{ filamentTypeId: "", gram: 3 }])).toBeNull();
    expect(ekFilamentleriYaz([{ filamentTypeId: "silk", gram: 20 }])).toBe('[{"filamentTypeId":"silk","gram":20}]');
  });

  it("en fazla sınır kadar satır tutulur", () => {
    const cok = Array.from({ length: EK_FILAMENT_AZAMI + 4 }, (_, i) => ({ filamentTypeId: `f${i}`, gram: 1 }));
    expect(ekFilamentleriOku(cok)).toHaveLength(EK_FILAMENT_AZAMI);
  });

  it("tutar güncel fiyattan; fiyatı bilinmeyen tür 'eksik' işaretler", () => {
    const fiyat = filamentFiyatHaritasi([
      { id: "x", costPerGram: 0.5 },
      { id: "silk", costPerGram: 0.8 },
    ]);
    expect(ekFilamentMaliyeti([{ filamentTypeId: "silk", gram: 20 }], fiyat)).toEqual({ tutar: 16, gram: 20, eksik: false });
    expect(ekFilamentMaliyeti([{ filamentTypeId: "silindi", gram: 20 }], fiyat).eksik).toBe(true);
  });

  it("toplam gram = ana + ekler", () => {
    expect(toplamFilamentGrami({ filamentWeight: 80, ekFilamentlerJson: '[{"filamentTypeId":"silk","gram":20}]' })).toBe(100);
    expect(toplamFilamentGrami({ filamentWeight: 80, ekFilamentlerJson: null })).toBe(80);
    expect(toplamFilamentGrami(null)).toBe(0);
  });
});

describe("çoklu filamentli ürün maliyeti", () => {
  const ayar = { costMachineWearPerHour: "4" };
  const fiyat = filamentFiyatHaritasi([
    { id: "x", costPerGram: 0.5 },
    { id: "silk", costPerGram: 0.8 },
  ]);
  const temel = {
    costMode: "detailed",
    manualCost: null,
    totalCost: null,
    filamentWeight: 80,
    printTimeHours: 2,
    wasteRate: 0.1,
    packagingOptionId: null,
    nylonLevel: null,
    tapeUsed: null,
  };

  it("ek filament malzeme payına girer; fire ORTAK orandan hepsine uygulanır", () => {
    const tek = resolveProductCost(temel, ayar, 0.5, fiyat)!;
    const cift = resolveProductCost(
      { ...temel, ekFilamentlerJson: '[{"filamentTypeId":"silk","gram":20}]' },
      ayar,
      0.5,
      fiyat
    )!;
    // Malzeme: 80×0,5 = 40 → 40 + 20×0,8 = 56
    expect(tek.filamentCost).toBeCloseTo(40);
    expect(cift.filamentCost).toBeCloseTo(56);
    // Üretim: (malzeme + aşınma 2×4) × 1,1
    expect(tek.productionCost).toBeCloseTo((40 + 8) * 1.1);
    expect(cift.productionCost).toBeCloseTo((56 + 8) * 1.1);
    expect(cift.productionCostKnown).toBe(true);
  });

  it("ekin fiyatı bilinmiyorsa maliyet TAM sayılmaz (kâr şişik görünmesin)", () => {
    const r = resolveProductCost(
      { ...temel, ekFilamentlerJson: '[{"filamentTypeId":"silindi","gram":20}]' },
      ayar,
      0.5,
      fiyat
    )!;
    expect(r.productionCostKnown).toBe(false);
  });

  it("ekler boşken sonuç tek filamentle birebir aynı", () => {
    const a = resolveProductCost(temel, ayar, 0.5, fiyat)!;
    const b = resolveProductCost({ ...temel, ekFilamentlerJson: "" }, ayar, 0.5, new Map())!;
    expect(b).toEqual(a);
  });
});
