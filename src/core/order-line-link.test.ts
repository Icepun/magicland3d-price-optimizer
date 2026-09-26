import { describe, expect, it } from "vitest";
import {
  bagliUrunKimligi,
  satirBagiAnahtari,
  satirBaglariHaritasi,
} from "./order-line-link";
import { satirAnahtari } from "./order-line-cost";

describe("elle ürün bağı — satır anahtarı", () => {
  it("siparişe özel maliyetin eşleşmeyen satır anahtarıyla aynı biçimde", () => {
    const ad = "Cars - Piston Kupası";
    expect(satirBagiAnahtari(ad)).toBe(satirAnahtari({ productId: null, name: ad }));
  });

  it("boşluk, harf düzeni ve Türkçe I farkı aynı anahtara düşer", () => {
    expect(satirBagiAnahtari("  cars -  PİSTON kupasi ")).toBe(satirBagiAnahtari("Cars - Piston Kupası"));
  });

  it("boş ad anahtar üretmez", () => {
    expect(satirBagiAnahtari("   ")).toBe("");
    expect(satirBagiAnahtari(null)).toBe("");
  });
});

describe("elle ürün bağı — arama", () => {
  const baglar = satirBaglariHaritasi([
    { platform: "shopify", lineKey: satirBagiAnahtari("Cars - Piston Kupası"), productId: "p-20" },
    { platform: "trendyol", lineKey: satirBagiAnahtari("Eski Vazo"), productId: "p-vazo" },
  ]);

  it("aynı platformda aynı adı bağlı ürüne götürür", () => {
    expect(bagliUrunKimligi(baglar, "shopify", "cars - piston kupası")).toBe("p-20");
  });

  it("başka platformdaki aynı ad bağlı SAYILMAZ", () => {
    expect(bagliUrunKimligi(baglar, "trendyol", "Cars - Piston Kupası")).toBeNull();
  });

  it("manuel sipariş ve boş ad hiç bağlanmaz", () => {
    expect(bagliUrunKimligi(baglar, "manual", "Eski Vazo")).toBeNull();
    expect(bagliUrunKimligi(baglar, "trendyol", "")).toBeNull();
  });

  it("harita yoksa/boşsa null", () => {
    expect(bagliUrunKimligi(null, "shopify", "Cars - Piston Kupası")).toBeNull();
    expect(bagliUrunKimligi(new Map(), "shopify", "Cars - Piston Kupası")).toBeNull();
  });

  it("bozuk kayıtları atlar", () => {
    const h = satirBaglariHaritasi([
      { platform: "", lineKey: "n:X", productId: "p" },
      { platform: "shopify", lineKey: "", productId: "p" },
      { platform: "shopify", lineKey: "n:X", productId: "" },
    ]);
    expect(h.size).toBe(0);
  });
});
