import { describe, expect, it } from "vitest";
import {
  chooseThresholdHint,
  perUnitRatio,
  thresholdCandidatePrices,
} from "./product-metrics";

describe("perUnitRatio (kâr/saat · kâr/gram)", () => {
  it("net kârı süreye böler", () => {
    expect(perUnitRatio(120, 3)).toBe(40);
  });

  it("gramaja böler", () => {
    expect(perUnitRatio(50, 25)).toBe(2);
  });

  it("süre girilmemişse null döner (arayüzde tire)", () => {
    expect(perUnitRatio(120, null)).toBeNull();
    expect(perUnitRatio(120, 0)).toBeNull();
  });

  it("kâr bilinmiyorsa null döner", () => {
    expect(perUnitRatio(null, 3)).toBeNull();
  });

  it("min sipariş adedi >1 ise paydayı da o adetle çarpar", () => {
    // 6 adetlik siparişin kârı 240₺, ürün başına 2 saat → 240 / (2×6) = 20₺/saat
    expect(perUnitRatio(240, 2, 6)).toBe(20);
  });

  it("geçersiz adet gelirse 1 kabul eder", () => {
    expect(perUnitRatio(100, 5, 0)).toBe(20);
    expect(perUnitRatio(100, 5, Number.NaN)).toBe(20);
  });
});

describe("thresholdCandidatePrices (eşiğe yakın adaylar)", () => {
  it("yalnızca mevcut fiyatın hemen üstündeki noktaları alır", () => {
    expect(thresholdCandidatePrices([100, 150, 155, 400], 149)).toEqual([150, 155]);
  });

  it("mevcut fiyatın altındaki ve çok uzaktaki noktaları eler", () => {
    expect(thresholdCandidatePrices([50, 149, 500], 149)).toEqual([]);
  });

  it("aynı noktayı bir kez döner ve sıralar", () => {
    expect(thresholdCandidatePrices([155, 150, 150.001], 149)).toEqual([150, 155]);
  });

  it("fiyat geçersizse aday üretmez", () => {
    expect(thresholdCandidatePrices([150], 0)).toEqual([]);
  });
});

describe("chooseThresholdHint (küçük zam, büyük kazanç)", () => {
  it("kural bandı lehe dönen adayı önerir", () => {
    const hint = chooseThresholdHint(149, 20, [{ price: 151, profit: 58 }]);
    expect(hint).toEqual({ targetPrice: 151, currentProfit: 20, targetProfit: 58, gain: 38 });
  });

  it("sıradan zammı (kazanç ≤ zam tutarı) gizler", () => {
    // +20₺ zam, +12₺ kâr → KDV/komisyon kesintisi kadar; anlatmaya değmez.
    expect(chooseThresholdHint(180, 30, [{ price: 200, profit: 42 }])).toBeNull();
  });

  it("küçük kazancı gizler", () => {
    expect(chooseThresholdHint(100, 10, [{ price: 100.5, profit: 13 }])).toBeNull();
  });

  it("kâr düşüren adayı önermez", () => {
    expect(chooseThresholdHint(149, 40, [{ price: 151, profit: 10 }])).toBeNull();
  });

  it("en yüksek kazançlı adayı seçer", () => {
    const hint = chooseThresholdHint(100, 10, [
      { price: 102, profit: 30 },
      { price: 105, profit: 60 },
    ]);
    expect(hint?.targetPrice).toBe(105);
    expect(hint?.gain).toBe(50);
  });

  it("kazanç eşitse daha ucuz hedefi seçer", () => {
    const hint = chooseThresholdHint(100, 10, [
      { price: 105, profit: 40 },
      { price: 102, profit: 40 },
    ]);
    expect(hint?.targetPrice).toBe(102);
  });

  it("aday yoksa null döner", () => {
    expect(chooseThresholdHint(100, 10, [])).toBeNull();
  });
});
