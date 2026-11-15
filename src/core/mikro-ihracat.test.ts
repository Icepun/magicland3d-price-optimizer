/**
 * MİKRO İHRACAT (Trendyol `micro: true`) — satış KDV'den istisna.
 * Gerçek vaka 15 Kas 2026: 166 paketin 6'sı mikro (5 SA, 1 AZ); kâr her birinde satıştan %20 KDV
 * düşülerek hesaplanıyordu (382,49 ₺'lik siparişte ~64 ₺ eksik kâr).
 */
import { describe, expect, it } from "vitest";
import { trendyolMikroIhracat, ulkeAdi } from "./mikro-ihracat";
import { computeOrderProfit, type OrderProfitInput, type OrderProfitProduct } from "./order-profit";
import type { CargoRuleInput, ExpenseRuleInput } from "./types";

describe("trendyolMikroIhracat", () => {
  it("micro=true → müşterinin ülkesi (büyük harf); yurt içi → null", () => {
    expect(trendyolMikroIhracat({ micro: true, orderCountryCode: "sa" })).toEqual({ ulke: "SA" });
    expect(trendyolMikroIhracat({ micro: false, orderCountryCode: "TR" })).toBeNull();
    expect(trendyolMikroIhracat({ orderCountryCode: "SA" })).toBeNull();
    expect(trendyolMikroIhracat(null)).toBeNull();
  });

  it("ülke kodu yoksa/bozuksa yine mikro sayılır, ülke bilinmez", () => {
    expect(trendyolMikroIhracat({ micro: true })).toEqual({ ulke: null });
    expect(trendyolMikroIhracat({ micro: true, orderCountryCode: "SAU" })).toEqual({ ulke: null });
  });

  it("ülke adı; listede olmayan kod olduğu gibi", () => {
    expect(ulkeAdi("SA")).toBe("Suudi Arabistan");
    expect(ulkeAdi("az")).toBe("Azerbaycan");
    expect(ulkeAdi("ZZ")).toBe("ZZ");
    expect(ulkeAdi(null)).toBeNull();
  });
});

const URUN: OrderProfitProduct = {
  id: "p",
  name: "Vazo",
  categoryName: "Dekor",
  desi: 1,
  commissionRate: null,
  productionCost: 60,
  packagingCost: 12,
  filamentCost: 20,
  productionCostKnown: true,
  listing: { platform: "trendyol", commissionRate: 0.2, commissionFixed: null, cargoCost: null },
};
const KARGO: CargoRuleInput[] = [
  { id: "c", name: "TEX", platform: "trendyol", cargoProvider: null, categoryName: null, minPrice: 0,
    maxPrice: 999999, minDesi: 0, maxDesi: 10, cargoCost: 60, priority: 1, isActive: true } as CargoRuleInput,
];
const GIDER: ExpenseRuleInput[] = [
  { id: "e", name: "Hizmet", platform: "trendyol", type: "fixed", value: 13.19, categoryName: null,
    minPrice: 0, maxPrice: 999999, priority: 1, isActive: true },
];

function hesapla(saleVatExempt?: boolean, orderTotal = 382.49) {
  const girdi: OrderProfitInput = {
    platform: "trendyol",
    orderTotal,
    lines: [{ unitPrice: 382.49, quantity: 1, product: URUN }],
    commissionRules: [],
    cargoRules: KARGO,
    expenseRules: GIDER,
    settings: { vatRate: "20" },
    saleVatExempt,
  };
  return computeOrderProfit(girdi);
}

describe("mikro ihracatta kâr", () => {
  it("satıştan KDV ayrılmaz: hesaplanan KDV 0, kâr tam KDV payı kadar yüksek", () => {
    const yurtIci = hesapla();
    const mikro = hesapla(true);
    expect(yurtIci.outputVat).toBeCloseTo(382.49 - 382.49 / 1.2, 6);
    expect(mikro.outputVat).toBe(0);
    expect((mikro.profit ?? 0) - (yurtIci.profit ?? 0)).toBeCloseTo(382.49 - 382.49 / 1.2, 6);
  });

  it("girdilerin KDV'si (komisyon, kargo, paketleme, gider, malzeme) yine indirilir", () => {
    const yurtIci = hesapla();
    const mikro = hesapla(true);
    expect(mikro.inputVatCredit).toBeGreaterThan(0);
    expect(mikro.inputVatCredit).toBeCloseTo(yurtIci.inputVatCredit, 6);
    expect(mikro.estimatedCommission).toBeCloseTo(yurtIci.estimatedCommission, 6);
    expect(mikro.cargoCost).toBeCloseTo(yurtIci.cargoCost, 6);
  });

  it("sipariş toplamı ile satır farkı (indirim/kargo geliri) da KDV'siz sayılır", () => {
    const yurtIci = hesapla(false, 400);
    const mikro = hesapla(true, 400);
    expect(mikro.orderRevenueAdjustmentNet - yurtIci.orderRevenueAdjustmentNet).toBeCloseTo(
      (400 - 382.49) - (400 - 382.49) / 1.2,
      6
    );
  });

  it("bayrak verilmezse eski hesap birebir aynı", () => {
    expect(hesapla(undefined).profit).toBe(hesapla(false).profit);
  });
});
