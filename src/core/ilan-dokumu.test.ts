import { describe, expect, it } from "vitest";
import { ilanGiderSatirlari } from "./ilan-dokumu";
import { simulatePrice } from "./pricing-engine";
import { resolveListingCommissionOverride } from "./product-commission";
import type { AppliedExpenseRule, ExpenseRuleInput } from "./types";

const kural = (over: Partial<AppliedExpenseRule>): AppliedExpenseRule => ({
  id: "e", name: "Platform Hizmet Bedeli", platform: "hepsiburada", type: "fixed", value: 11.4,
  categoryName: null, minPrice: 0, maxPrice: 999999, priority: 1, isActive: true, amount: 11.4,
  ...over,
});

describe("ürün ekranı kâr dökümü — gider satırları", () => {
  it("kural tutarı motorla aynıysa kural satırları aynen", () => {
    expect(ilanGiderSatirlari("trendyol", { appliedExpenseRules: [kural({ name: "PHB", amount: 13.19 })], fixedExpenses: 13.19, variableExpenses: 0, minOrderQty: 1 }))
      .toEqual([{ key: "kural-e", ad: "PHB", tutar: 13.19 }]);
  });

  it("Hepsiburada: kesilmeyen hizmet bedeli GÖSTERİLMEZ, tahsilat bedeli gösterilir", () => {
    expect(ilanGiderSatirlari("hepsiburada", { appliedExpenseRules: [kural({})], fixedExpenses: 0, variableExpenses: 2, minOrderQty: 1 }))
      .toEqual([{ key: "pazaryeri-kesintisi", ad: "Tahsilat bedeli", tutar: 2 }]);
  });

  it("satırların toplamı motorun düştüğü gidere eşit (n11 ilanı, gerçek fiyat)", () => {
    const GIDER: ExpenseRuleInput[] = [];
    const o = resolveListingCommissionOverride({ platform: "n11", commissionRate: 0, commissionFixed: null, vatRate: 20 }, { vatRate: "20" });
    const r = simulatePrice({
      salePrice: 349.99, productCost: 33.2, packagingCost: 9.22, categoryName: "Kol", desi: 1,
      commissionRules: [], cargoRules: [], expenseRules: GIDER, vatRate: 20, ...o,
    });
    const satirlar = ilanGiderSatirlari("n11", r);
    expect(satirlar).toEqual([{ key: "pazaryeri-kesintisi", ad: "Pazarlama ve hizmet bedeli", tutar: 7 }]);
    expect(satirlar.reduce((t, s) => t + s.tutar, 0)).toBeCloseTo(r.fixedExpenses + r.variableExpenses, 2);
  });

  it("oransal kural adetle çarpılır, kalan değişken gider pazaryeri kesintisi", () => {
    const s = ilanGiderSatirlari("hepsiburada", {
      appliedExpenseRules: [kural({ id: "p", name: "Ambalaj payı", type: "percentage", amount: 1.5 })],
      fixedExpenses: 0, variableExpenses: 1.5 * 3 + 6, minOrderQty: 3,
    });
    expect(s).toEqual([
      { key: "kural-p", ad: "Ambalaj payı", tutar: 4.5 },
      { key: "pazaryeri-kesintisi", ad: "Tahsilat bedeli", tutar: 6 },
    ]);
  });
});
