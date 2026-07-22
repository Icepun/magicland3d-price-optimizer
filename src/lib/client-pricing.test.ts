import { describe, it, expect } from "vitest";
import { computeClientPricing, type ClientPricingInput } from "./client-pricing";
import { simulatePrice, trendyolMinQty } from "../core/pricing-engine";
import { resolveListingCommissionOverride } from "../core/product-commission";

/**
 * Parite testi: istemci-tarafı kâr hesabı (computeClientPricing) ile çekirdek simulatePrice'ın
 * DOĞRUDAN çağrısı aynı sonucu vermeli. Sunucu profit-preview/price-lab route'larındaki "glue"yu
 * (Shopify sabit komisyon override'ı, <150₺ kargo override'ı, Trendyol minOrderQty, isActive süzme)
 * burada kilitler → ileride biri yanlışlıkla değiştirirse test patlar.
 */

const SETTINGS: Record<string, string> = {
  vatRate: "20",
  shopifyCommissionRate: "3.2",
  costElectricityPerHour: "0",
  costMachineWearPerHour: "0",
  costLaborPerHour: "0",
};

const FILAMENTS = [{ id: "f1", costPerGram: 1, name: "PLA" }];

function baseInput(overrides: Partial<ClientPricingInput> = {}): ClientPricingInput {
  return {
    product: {
      id: "p1",
      name: "Test Ürün",
      categoryName: "Dekor",
      desi: null,
      currentSalePrice: 200,
      commissionRate: null,
      listings: [
        {
          id: "l-shop",
          platform: "shopify",
          salePrice: 200,
          commissionRate: null,
          commissionFixed: null,
          cargoCost: null,
          isActive: true,
        },
        {
          id: "l-ty",
          platform: "trendyol",
          salePrice: 300,
          commissionRate: null,
          commissionFixed: null,
          cargoCost: null,
          isActive: true,
        },
      ],
    },
    cost: {
      filamentTypeId: "f1",
      filamentWeight: 100, // 100g × 1₺/g = 100₺ üretim
      printTimeHours: 0,
      wasteRate: 0,
      packagingOptionId: "",
      nylonLevel: "none",
      tapeUsed: false,
      desi: 2,
    },
    filaments: FILAMENTS,
    settings: SETTINGS,
    commissionRules: [],
    cargoRules: [],
    expenseRules: [],
    ...overrides,
  };
}

describe("computeClientPricing", () => {
  it("maliyet yoksa hasCost=false (preview + priceLab)", () => {
    const input = baseInput({
      cost: { ...baseInput().cost, filamentWeight: 0, filamentTypeId: "" },
    });
    const { preview, priceLab } = computeClientPricing(input);
    expect(preview.hasCost).toBe(false);
    expect(preview.platforms.every((p) => p.result === null)).toBe(true);
    expect(priceLab.hasCost).toBe(false);
  });

  it("Shopify önizleme sonucu, doğrudan simulatePrice ile BİREBİR aynı (glue paritesi)", () => {
    const input = baseInput();
    const { preview } = computeClientPricing(input);
    const shop = preview.platforms.find((p) => p.platform === "shopify");
    expect(shop?.result).not.toBeNull();

    const expected = simulatePrice({
      salePrice: 200,
      productCost: 100,
      packagingCost: 0,
      categoryName: "Dekor",
      desi: 2, // cost.desi ?? product.desi ?? 1
      commissionRules: [], // product.commissionRate null → ürün-kuralı eklenmez
      cargoRules: [],
      expenseRules: [],
      vatRate: 20,
      ...resolveListingCommissionOverride(
        { platform: "shopify", commissionRate: null, commissionFixed: null },
        SETTINGS
      ),
      cargoCostOverride: undefined, // 200 ≥ 150 → özel override yok
      minOrderQty: 1,
      vatableProductCost: 100, // filament malzeme = 100g × 1₺ (KDV iadesine girer)
    });
    expect(shop?.result).toEqual(expected);
  });

  it("Shopify <150₺ → kargo override 0 (sepet paylaşımı)", () => {
    const input = baseInput();
    input.product.listings[0].salePrice = 120; // <150
    input.product.currentSalePrice = 120;
    const { preview } = computeClientPricing(input);
    const shop = preview.platforms.find((p) => p.platform === "shopify");

    const expected = simulatePrice({
      salePrice: 120,
      productCost: 100,
      packagingCost: 0,
      categoryName: "Dekor",
      desi: 2,
      commissionRules: [],
      cargoRules: [],
      expenseRules: [],
      vatRate: 20,
      ...resolveListingCommissionOverride(
        { platform: "shopify", commissionRate: null, commissionFixed: null },
        SETTINGS
      ),
      cargoCostOverride: 0,
      minOrderQty: 1,
      vatableProductCost: 100, // filament malzeme = 100g × 1₺ (KDV iadesine girer)
    });
    expect(shop?.result).toEqual(expected);
  });

  it("Trendyol minOrderQty uygulanır", () => {
    const input = baseInput();
    const { preview } = computeClientPricing(input);
    const ty = preview.platforms.find((p) => p.platform === "trendyol");
    expect(ty?.result?.minOrderQty).toBe(trendyolMinQty(300));
  });

  it("pasif listing önizlemeye girmez (isActive süzme)", () => {
    const input = baseInput();
    input.product.listings[1].isActive = false; // Trendyol pasif
    const { preview } = computeClientPricing(input);
    expect(preview.platforms.find((p) => p.platform === "trendyol")).toBeUndefined();
    expect(preview.platforms).toHaveLength(1);
  });

  it("Fiyat Lab: hasCost olunca hedef marjlar + Shopify kampanya döner", () => {
    const { priceLab } = computeClientPricing(baseInput());
    expect(priceLab.hasCost).toBe(true);
    expect(priceLab.targets?.length).toBeGreaterThan(0);
    expect(priceLab.targets?.[0].rows).toHaveLength(4); // 20/30/40/50
    expect(priceLab.campaign?.rows).toHaveLength(5); // 10/15/20/25/30
  });

  it("Fiyat Lab mevcut marjları canlı önizlemeyle aynı platform kurallarıyla hesaplar", () => {
    const input = baseInput({
      cargoRules: [
        {
          id: "cargo",
          name: "Kargo",
          minPrice: 0,
          maxPrice: 999999,
          minDesi: 0,
          maxDesi: 999,
          cargoCost: 30,
          priority: 1,
          isActive: true,
        },
      ],
    });
    input.product.listings[0].salePrice = 120; // Shopify <150 → kargo 0
    input.product.listings[1].salePrice = 50; // Trendyol → minOrderQty 2

    const { preview, priceLab } = computeClientPricing(input);
    for (const platform of ["shopify", "trendyol"]) {
      const previewMargin = preview.platforms.find((p) => p.platform === platform)?.result
        ?.profitMargin;
      const labMargin = priceLab.targets?.find((p) => p.platform === platform)?.currentMargin;
      expect(labMargin).toBeCloseTo(previewMargin ?? Number.NaN, 10);
    }

    expect(
      preview.platforms.find((p) => p.platform === "shopify")?.result?.cargoCost
    ).toBe(0);
    expect(
      preview.platforms.find((p) => p.platform === "trendyol")?.result?.minOrderQty
    ).toBe(2);
  });

  it("pasif komisyon kuralı hesaba katılmaz (isActive süzme)", () => {
    // Trendyol için %50'lik PASİF bir kural → uygulanmamalı; aktif kural yokken komisyon 0 kalır.
    const input = baseInput({
      commissionRules: [
        {
          id: "c-passive",
          name: "pasif",
          categoryName: "",
          minPrice: 0,
          maxPrice: 999999,
          commissionRate: 0.5,
          fixedCommission: 0,
          priority: 1,
          isActive: false,
        },
      ],
    });
    const { preview } = computeClientPricing(input);
    const ty = preview.platforms.find((p) => p.platform === "trendyol");
    expect(ty?.result?.commissionCost).toBe(0);
  });
});
