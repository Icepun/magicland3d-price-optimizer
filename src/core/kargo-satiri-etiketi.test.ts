/**
 * Dökümdeki KARGO satırı her zaman "kaç desiden hesaplandı"yı söyler (Berke, 24 Kas 2026: "kargoyu
 * kaç desi hesapladığını anlamıyorum"). Masaüstü Siparişler ve telefon aynı çekirdek metnini kullanır.
 */
import { describe, expect, it } from "vitest";
import { computeOrderProfit, kargoSatiriEtiketi, type OrderProfitInput, type OrderProfitLine } from "./order-profit";
import type { CargoRuleInput } from "./types";

const urun = (desi: number | null): OrderProfitLine["product"] => ({
  id: "p", name: "Ürün", categoryName: "Dekor", desi, commissionRate: null,
  productionCost: 40, packagingCost: 8, packagingComponents: null, filamentCost: 0, productionCostKnown: true,
  listing: null,
});

const shopifyBaremi = (min: number, max: number, cost: number): CargoRuleInput => ({
  id: `k${min}`, name: `${min}-${max} Desi`, platform: "shopify", categoryName: null,
  minPrice: 0, maxPrice: 999999, minDesi: min, maxDesi: max, cargoCost: cost, priority: 10, isActive: true,
});

function shopify(lines: OrderProfitLine[]): OrderProfitInput {
  return {
    platform: "shopify",
    orderTotal: lines.reduce((t, l) => t + l.unitPrice * l.quantity, 0),
    lines,
    commissionRules: [],
    cargoRules: [shopifyBaremi(0, 4, 115), shopifyBaremi(5, 10, 145)],
    expenseRules: [],
    settings: { vatRate: "20", shopifyCommissionRate: "6.29" },
    orderedAt: new Date("2026-11-24T12:00:00+03:00"),
  };
}

describe("kargo satırı etiketi", () => {
  it("Shopify (kural): toplam desi + kuralın bandı", () => {
    // 4 ürün × 1,3 desi = 5,2 → 5 desi → 5–10 baremi (145 ₺).
    const r = computeOrderProfit(shopify([{ unitPrice: 300, quantity: 4, product: urun(1.3) }]));
    expect(r.cargoDesi).toBe(5);
    expect(r.cargoBand).toEqual({ minDesi: 5, maxDesi: 10 });
    expect(kargoSatiriEtiketi(r)).toBe("5 desi · 5–10 desi baremi");
  });

  it("desi tahmin edildiyse başında ~", () => {
    const r = computeOrderProfit(shopify([{ unitPrice: 300, quantity: 1, product: urun(null) }]));
    expect(r.desiEstimated).toBe(true);
    expect(kargoSatiriEtiketi(r)).toBe("~1 desi · 0–4 desi baremi");
  });

  it("pazaryeri tarifesi: sabit fiyatlı baremde de desi yazar", () => {
    const r = computeOrderProfit({ ...shopify([{ unitPrice: 250, quantity: 1, product: urun(2), orderCommissionRate: 0.2 }]), platform: "trendyol" });
    expect(r.cargoDetail).not.toBeNull();
    expect(kargoSatiriEtiketi(r)).toMatch(/ · 2 desi$/);
  });

  it("gerçek fatura: pazaryerinin kestiği desi; bilinmiyorsa yalnız rozet", () => {
    const r = computeOrderProfit(shopify([{ unitPrice: 300, quantity: 1, product: urun(2) }]));
    expect(kargoSatiriEtiketi({ ...r, actualCargo: 90 }, { kesilenDesi: 3 })).toBe("3 desi kesildi");
    expect(kargoSatiriEtiketi({ ...r, actualCargo: 90 })).toBeNull();
  });

  it("ilana elle girilen kargo bunu söyler", () => {
    const tekUrun = urun(2)!;
    const r = computeOrderProfit(
      shopify([{ unitPrice: 300, quantity: 1, product: { ...tekUrun, listing: { platform: "shopify", commissionRate: null, commissionFixed: null, cargoCost: 60 } } }])
    );
    expect(r.cargoDesi).toBeNull();
    expect(kargoSatiriEtiketi(r)).toBe("ilana girilen kargo");
  });
});
