import { describe, expect, it } from "vitest";
import { computeOrderProfit, computeReturnLoss, type OrderProfitInput, type OrderProfitProduct } from "./order-profit";
import type { CargoRuleInput, ExpenseRuleInput } from "./types";

/**
 * Trendyol / Hepsiburada kargosu pazaryeri TARİFESİNDEN (core/kargo-tarife) — kural tablosu
 * yalnız tarife öncesi siparişlerde ve Shopify'da. Rakamlar gerçek faturalardan.
 */
const SETTINGS = { vatRate: "20" };
const EKIM = new Date("2026-10-15T10:00:00Z");
const urun = (over: Partial<OrderProfitProduct> = {}): OrderProfitProduct => ({
  id: "u", name: "u", categoryName: "Dekor", desi: 1, commissionRate: null,
  productionCost: 50, packagingCost: 10, filamentCost: 0, productionCostKnown: true,
  listing: { platform: "trendyol", commissionRate: 0.2, commissionFixed: null, cargoCost: null },
  ...over,
});
const KURAL: CargoRuleInput[] = [
  { id: "k", name: "eski", platform: null, cargoProvider: null, categoryName: null, minPrice: 0, maxPrice: 999999,
    minDesi: 0, maxDesi: 999, cargoCost: 94.2, vatIncluded: true, priority: 1, isActive: true } as CargoRuleInput,
];
const PHB: ExpenseRuleInput[] = [
  { id: "e", name: "Platform Hizmet Bedeli", platform: "trendyol", type: "fixed", value: 13.19,
    categoryName: null, minPrice: 0, maxPrice: 999999, priority: 10, isActive: true },
];

function girdi(over: Partial<OrderProfitInput> = {}): OrderProfitInput {
  const fiyat = over.orderTotal ?? 279.99;
  return {
    platform: "trendyol",
    orderTotal: fiyat,
    lines: [{ unitPrice: fiyat, quantity: 1, product: urun() }],
    commissionRules: [],
    cargoRules: KURAL,
    expenseRules: PHB,
    settings: SETTINGS,
    orderedAt: EKIM,
    ...over,
  };
}

describe("sipariş kârı — kargo tarifesi", () => {
  it("Trendyol standart barem: 78,74 + KDV = 94,49 (kural 94,20 değil)", () => {
    const r = computeOrderProfit(girdi());
    expect(r.cargoCost).toBeCloseTo(94.488, 3);
    expect(r.cargoDetail).toMatchObject({ tur: "barem", fiyat: 78.74 });
    expect(r.cargoRuleMissing).toBe(false);
  });

  it("Trendyol hızlı teslimat → avantajlı 70,41 + KDV = 84,49", () => {
    const r = computeOrderProfit(girdi({ kargo: { hizliTeslimat: true } }));
    expect(r.cargoCost).toBeCloseTo(84.492, 3);
    expect(r.cargoDetail?.tur).toBe("barem-avantajli");
  });

  it("kâr farkı yalnız kargonun KDV sonrası farkı kadar", () => {
    const standart = computeOrderProfit(girdi());
    const hizli = computeOrderProfit(girdi({ kargo: { hizliTeslimat: true } }));
    expect((hizli.profit ?? 0) - (standart.profit ?? 0)).toBeCloseTo(78.74 - 70.41, 6);
  });

  it("Hepsiburada 1 günde kargo, 199,99 → 43,99 + KDV = 52,79", () => {
    const r = computeOrderProfit(girdi({ platform: "hepsiburada", orderTotal: 199.99, kargo: { kargoyaVermeGunu: 1 } }));
    expect(r.cargoCost).toBeCloseTo(52.788, 3);
  });

  it("Hepsiburada 2 gün → desi listesi 81,99 + KDV = 98,39", () => {
    const r = computeOrderProfit(girdi({ platform: "hepsiburada", orderTotal: 339.99, kargo: { kargoyaVermeGunu: 2 } }));
    expect(r.cargoCost).toBeCloseTo(98.388, 3);
  });

  it("çok adetli sipariş birleşik desiyle (3 × 2 desi = 6 desi, 350+ → 125,60)", () => {
    const r = computeOrderProfit(girdi({
      orderTotal: 900,
      lines: [{ unitPrice: 300, quantity: 3, product: urun({ desi: 2 }) }],
    }));
    expect(r.cargoDetail).toMatchObject({ tur: "desi", desi: 6, fiyat: 125.6 });
  });

  it("tarife öncesi sipariş ve Shopify eski kuralla", () => {
    expect(computeOrderProfit(girdi({ orderedAt: new Date("2026-07-10T10:00:00Z") })).cargoCost).toBeCloseTo(94.2, 6);
    const sh = computeOrderProfit(girdi({ platform: "shopify" }));
    expect(sh.cargoCost).toBeCloseTo(94.2, 6);
    expect(sh.cargoDetail).toBeNull();
  });

  it("ilana elle girilen kargo tek ürünlü siparişte yine kazanır", () => {
    const r = computeOrderProfit(girdi({
      lines: [{ unitPrice: 279.99, quantity: 1, product: urun({ listing: { platform: "trendyol", commissionRate: 0.2, commissionFixed: null, cargoCost: 40 } }) }],
    }));
    expect(r.cargoCost).toBe(40);
    expect(r.cargoDetail).toBeNull();
  });
});

describe("iade edilen siparişin zararı", () => {
  it("Trendyol paneliyle birebir: 98,34 + 98,34 + 13,19 = 209,87 brüt (559,98 · 1 desi)", () => {
    const z = computeReturnLoss(girdi({ orderTotal: 559.98, lines: [{ unitPrice: 279.99, quantity: 2, product: urun({ desi: 0.5 }) }] }));
    expect(z.outboundCargo).toBeCloseTo(98.34, 2);
    expect(z.returnCargo).toBeCloseTo(98.34, 2);
    expect(z.serviceFee).toBeCloseTo(13.19, 2);
    expect(z.outboundCargo + z.returnCargo + z.serviceFee).toBeCloseTo(209.87, 2);
    // Kâra etkisi KDV indirimi düşülmüş tutar.
    expect(z.loss).toBeCloseTo(209.87 / 1.2, 2);
    expect(z.inputVatCredit).toBeCloseTo(209.87 / 6, 2);
  });

  it("Trendyol barem siparişinde dönüş desi listesinden (gidiş 94,49 · dönüş 98,34)", () => {
    const z = computeReturnLoss(girdi({ orderTotal: 259.99 }));
    expect(z.outboundCargo).toBeCloseTo(94.49, 2);
    expect(z.returnCargo).toBeCloseTo(98.34, 2);
    expect(z.returnDetail?.tur).toBe("desi");
  });

  it("Hepsiburada: dönüş gidişle aynı (43,99 + 43,99), hizmet bedeli orderFee'den", () => {
    const z = computeReturnLoss(girdi({ platform: "hepsiburada", orderTotal: 199.99, orderFee: 0, kargo: { kargoyaVermeGunu: 1 } }));
    expect(z.outboundCargo).toBeCloseTo(52.79, 2);
    expect(z.returnCargo).toBeCloseTo(52.79, 2);
    expect(z.serviceFee).toBe(0);
  });

  it("gerçek kayıtlar tahminin yerine geçer", () => {
    const z = computeReturnLoss(girdi({ orderTotal: 259.99 }), { outboundCargo: 94.49, returnCargo: 98.34, serviceFee: 13.19 });
    expect(z.outboundActual && z.returnActual && z.serviceFeeActual).toBe(true);
    expect(z.outboundDetail).toBeNull();
    expect(z.loss).toBeCloseTo((94.49 + 98.34 + 13.19) / 1.2, 6);
  });

  it("ürün eşleşmese de kargo zararı hesaplanır (desi 1 sayılır)", () => {
    const z = computeReturnLoss(girdi({ orderTotal: 149.99, lines: [{ unitPrice: 149.99, quantity: 1, product: null }] }));
    expect(z.outboundCargo).toBeCloseTo(73.33 * 1.2, 2);
    expect(z.returnCargo).toBeCloseTo(81.95 * 1.2, 2);
  });

  it("tarife öncesi siparişte kargo kuralından (iki yön aynı)", () => {
    const z = computeReturnLoss(girdi({ orderedAt: new Date("2026-07-10T10:00:00Z") }));
    expect(z.outboundCargo).toBeCloseTo(94.2, 6);
    expect(z.returnCargo).toBeCloseTo(94.2, 6);
  });
});
