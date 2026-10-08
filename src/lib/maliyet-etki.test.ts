import { describe, expect, it } from "vitest";

import { maliyetEtkisi } from "./maliyet-etki";

const u = (id: string, kar: Record<string, number | null>) => ({
  id,
  name: `Ürün ${id}`,
  platforms: Object.entries(kar).map(([platform, netProfit]) => ({ platform, netProfit })),
});

describe("maliyet ayarı etki önizlemesi", () => {
  it("değişen ilanları sayar, ortalama farkı ve zarara geçenleri bulur", () => {
    const once = [u("a", { shopify: 50, trendyol: 2 }), u("b", { shopify: 30 }), u("c", { trendyol: 10 })];
    const sonra = [u("a", { shopify: 48, trendyol: -1 }), u("b", { shopify: 30 }), u("c", { trendyol: 7 })];
    const o = maliyetEtkisi(once, sonra);
    expect(o.etkilenenUrun).toBe(2);
    expect(o.etkilenenIlan).toBe(3);
    expect(o.ortalamaFark).toBeCloseTo((-2 - 3 - 3) / 3, 10);
    expect(o.zarargaGecen).toBe(1);
    expect(o.karaGecen).toBe(0);
    expect(o.enCok[0].fark).toBe(-3);
  });

  it("kârı bilinmeyen ilan karşılaştırılmaz; değişiklik yoksa ortalama null", () => {
    const o = maliyetEtkisi([u("a", { shopify: null })], [u("a", { shopify: 10 })]);
    expect(o.etkilenenIlan).toBe(0);
    expect(o.ortalamaFark).toBeNull();
  });

  it("en çok etkilenenler ürün başına tek satır", () => {
    const once = [u("a", { shopify: 50, trendyol: 40, hepsiburada: 30 }), u("b", { shopify: 20 })];
    const sonra = [u("a", { shopify: 47.5, trendyol: 37.5, hepsiburada: 27 }), u("b", { shopify: 19 })];
    const o = maliyetEtkisi(once, sonra);
    expect(o.enCok.map((s) => s.id)).toEqual(["a", "b"]);
    expect(o.enCok[0].fark).toBe(-3);
  });

  it("yuvarlama gürültüsü değişiklik sayılmaz", () => {
    expect(maliyetEtkisi([u("a", { shopify: 10 })], [u("a", { shopify: 10.001 })]).etkilenenIlan).toBe(0);
  });
});
