import { describe, it, expect } from "vitest";
import {
  SHOPIFY_MIN_BASKET,
  belowShopifyMinBasket,
  shopifyCargoOverride,
  platformMinOrderQty,
  platformPriceBreakpoints,
} from "./platform-rules";
import { trendyolMinQty } from "./pricing-engine";

describe("shopifyCargoOverride", () => {
  it("Shopify'da sepet minimumunun ALTINDA kargo yazılmaz (0)", () => {
    expect(shopifyCargoOverride("shopify", 0)).toBe(0);
    expect(shopifyCargoOverride("shopify", 149.99)).toBe(0);
  });

  it("Shopify'da sepet minimumu ve ÜSTÜNDE kargo kurallarına bakılır (undefined)", () => {
    expect(shopifyCargoOverride("shopify", SHOPIFY_MIN_BASKET)).toBeUndefined();
    expect(shopifyCargoOverride("shopify", 200)).toBeUndefined();
  });

  it("diğer platformlarda kural hiç devreye girmez", () => {
    expect(shopifyCargoOverride("trendyol", 10)).toBeUndefined();
    expect(shopifyCargoOverride("hepsiburada", 10)).toBeUndefined();
  });

  it("eşik tek yerde tanımlı (150₺)", () => {
    expect(SHOPIFY_MIN_BASKET).toBe(150);
  });
});

describe("platformMinOrderQty", () => {
  it("Trendyol'da çekirdek baremi sarar (yeniden yazmaz)", () => {
    for (const price of [0, 24.99, 25, 34.99, 35, 49.99, 50, 74.99, 75, 500]) {
      expect(platformMinOrderQty("trendyol", price)).toBe(trendyolMinQty(price));
    }
  });

  it("Trendyol dışındaki platformlarda 1 adet", () => {
    expect(platformMinOrderQty("shopify", 10)).toBe(1);
    expect(platformMinOrderQty("hepsiburada", 10)).toBe(1);
    expect(platformMinOrderQty("manual", 10)).toBe(1);
  });
});

describe("platformPriceBreakpoints", () => {
  it("Trendyol kırılım noktaları baremin gerçek sıçrama yerleriyle birebir", () => {
    // Barem değişirse bu test patlar → hedef-marj araması sessizce yanlış aralık taramaz.
    const jumps: number[] = [];
    for (let cent = 1; cent <= 10_000; cent++) {
      const price = cent / 100;
      if (trendyolMinQty(price) !== trendyolMinQty(price - 0.01)) jumps.push(price);
    }
    expect(platformPriceBreakpoints("trendyol")).toEqual(jumps);
  });

  it("Shopify kırılım noktası sepet minimumu", () => {
    expect(platformPriceBreakpoints("shopify")).toEqual([SHOPIFY_MIN_BASKET]);
  });

  it("kuralı olmayan platformda ek nokta yok", () => {
    expect(platformPriceBreakpoints("hepsiburada")).toEqual([]);
  });
});

/**
 * KAMPANYA EŞİĞİ — hangi fiyat sepet minimumuna girer?
 *
 * Kural: "sepet 150₺'nin altındaysa ürün tek başına satılamaz, kargo müşteriye/sepete geçer".
 * Sepet, müşterinin GERÇEKTEN ödediği tutardır → kampanyada indirim UYGULANDIKTAN sonraki fiyat.
 *
 * Bu ayrım bir kez yanlış yapıldı: eşiğe liste fiyatı sokulunca 140₺'ye düşen bir kampanyada
 * kargo hâlâ satıcıya yazılıyordu. Aşağıdaki testler doğru semantiği kilitler.
 */
describe("kampanya eşiği müşterinin ödediği tutara bakar", () => {
  const etkiliFiyat = (liste: number, indirimYuzde: number) =>
    liste * (1 - indirimYuzde / 100);

  it("indirim ürünü eşiğin altına düşürürse kargo satıcıya yazılmaz", () => {
    // 200₺ liste, %30 indirim → müşteri 140₺ ödüyor → sepet minimumunun ALTINDA.
    expect(shopifyCargoOverride("shopify", etkiliFiyat(200, 30))).toBe(0);
    expect(belowShopifyMinBasket("shopify", etkiliFiyat(200, 30))).toBe(true);
  });

  it("indirim eşiğin üstünde bırakıyorsa kargo kurallarına bakılır", () => {
    // 200₺ liste, %25 indirim → müşteri 150₺ ödüyor → eşiğin ÜSTÜNDE (dahil).
    expect(shopifyCargoOverride("shopify", etkiliFiyat(200, 25))).toBeUndefined();
    expect(belowShopifyMinBasket("shopify", etkiliFiyat(200, 25))).toBe(false);
  });

  it("kampanyasız yüzeylerde liste fiyatı zaten etkili fiyattır", () => {
    expect(shopifyCargoOverride("shopify", 149.99)).toBe(0);
    expect(shopifyCargoOverride("shopify", 150)).toBeUndefined();
  });

  it("kural yalnız Shopify'a özeldir", () => {
    expect(shopifyCargoOverride("trendyol", 100)).toBeUndefined();
    expect(shopifyCargoOverride("hepsiburada", 100)).toBeUndefined();
    expect(belowShopifyMinBasket("trendyol", 100)).toBe(false);
  });
});
