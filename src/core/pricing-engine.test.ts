import { describe, expect, it } from "vitest";
import { simulatePrice, trendyolMinQty } from "./pricing-engine";
import type { CargoRuleInput, CommissionRuleInput, ExpenseRuleInput } from "./types";

const commissionRules: CommissionRuleInput[] = [
  {
    id: "commission-general",
    name: "General commission",
    minPrice: 0,
    maxPrice: 999999,
    commissionRate: 0.2,
    fixedCommission: 0,
    priority: 1,
    isActive: true,
  },
  {
    id: "commission-category",
    name: "Category commission",
    categoryName: "Stand",
    minPrice: 0,
    maxPrice: 999999,
    commissionRate: 0.1,
    fixedCommission: 2,
    priority: 1,
    isActive: true,
  },
];

const cargoRules: CargoRuleInput[] = [
  {
    id: "cargo-small",
    name: "Small cargo",
    minPrice: 0,
    maxPrice: 999999,
    minDesi: 0,
    maxDesi: 2,
    cargoCost: 20,
    priority: 1,
    isActive: true,
  },
];

const expenseRules: ExpenseRuleInput[] = [
  {
    id: "expense-fixed",
    name: "Fixed fee",
    type: "fixed",
    value: 5,
    minPrice: 0,
    maxPrice: 999999,
    priority: 1,
    isActive: true,
  },
  {
    id: "expense-variable",
    name: "Variable fee",
    type: "percentage",
    value: 0.03,
    minPrice: 0,
    maxPrice: 999999,
    priority: 1,
    isActive: true,
  },
];

describe("pricing engine", () => {
  it("calculates commission, cargo, expenses, profit, and margin", () => {
    const result = simulatePrice({
      salePrice: 200,
      productCost: 80,
      packagingCost: 10,
      categoryName: "Gamepad Stand",
      desi: 1,
      commissionRules,
      cargoRules,
      expenseRules,
    });

    expect(result.appliedCommissionRule?.id).toBe("commission-category");
    expect(result.commissionCost).toBe(22); // 200 * 0.1 + 2
    expect(result.cargoCost).toBe(20);
    expect(result.fixedExpenses).toBe(5);
    expect(result.variableExpenses).toBe(6);
    // Her gider kuralı tek tek kendi tutarıyla raporlanır (UI'da adıyla satır olur)
    expect(result.appliedExpenseRules).toHaveLength(2);
    expect(
      result.appliedExpenseRules.find((e) => e.id === "expense-fixed")?.amount
    ).toBe(5);
    expect(
      result.appliedExpenseRules.find((e) => e.id === "expense-variable")?.amount
    ).toBe(6);
    expect(result.totalCost).toBe(143);
    expect(result.netProfit).toBe(57);
    expect(result.profitMargin).toBeCloseTo(0.285);
  });

  it("KDV uygulanmadığında (vatRate=0) salePrice ve salePriceExVat eşit", () => {
    const result = simulatePrice({
      salePrice: 200,
      productCost: 80,
      packagingCost: 10,
      categoryName: "Gamepad Stand",
      desi: 1,
      commissionRules,
      cargoRules,
      expenseRules,
    });

    expect(result.salePrice).toBe(200);
    expect(result.effectiveSalePrice).toBe(200);
    expect(result.salePriceExVat).toBe(200);
    expect(result.vatAmount).toBe(0);
    expect(result.vatRate).toBe(0);
    expect(result.netProfit).toBe(57);
  });

  it("KDV %20 ile net kâr KDV hariç bazdan hesaplanır", () => {
    // salePrice=240 (KDV dahil) → exVat=200 → maliyet 80+10+commission+cargo+expense
    const result = simulatePrice({
      salePrice: 240,
      productCost: 80,
      packagingCost: 10,
      categoryName: "Gamepad Stand",
      desi: 1,
      commissionRules,
      cargoRules,
      expenseRules,
      vatRate: 20,
    });

    expect(result.salePrice).toBe(240);
    expect(result.effectiveSalePrice).toBe(240);
    expect(result.salePriceExVat).toBeCloseTo(200, 5);
    expect(result.vatAmount).toBeCloseTo(40, 5);
    expect(result.vatRate).toBe(20);
    // Commission category rule: 240 * 0.1 + 2 = 26
    expect(result.commissionCost).toBeCloseTo(26, 5);
    // Total: 80 + 10 + 26 + 20 + 5 + 240*0.03 = 148.2
    expect(result.totalCost).toBeCloseTo(148.2, 5);
    // İndirilecek KDV: paketleme 10 + komisyon 26 + kargo 20 + sabit 5 + değişken 7.2.
    expect(result.inputVatCredit).toBeCloseTo(11.3666667, 5);
    expect(result.netProfit).toBeCloseTo(63.1666667, 5);
  });

  it("KDV hariç kargo tarifesini brüte çevirir, KDV'yi yalnız bir kez iade eder", () => {
    const result = simulatePrice({
      salePrice: 240,
      productCost: 0,
      packagingCost: 0,
      categoryName: "Dekor",
      commissionRules: [],
      cargoRules: [
        {
          ...cargoRules[0],
          cargoCost: 100,
          vatIncluded: false,
        },
      ],
      expenseRules: [],
      vatRate: 20,
    });

    expect(result.cargoCost).toBeCloseTo(120, 5);
    expect(result.inputVatCredit).toBeCloseTo(20, 5);
    expect(result.netProfit).toBeCloseTo(100, 5);
  });

  it("vatableProductCost (filament) indirilecek KDV iadesine katılır", () => {
    const result = simulatePrice({
      salePrice: 240,
      productCost: 80,
      packagingCost: 10,
      categoryName: "Gamepad Stand",
      desi: 1,
      commissionRules,
      cargoRules,
      expenseRules,
      vatRate: 20,
      vatableProductCost: 60, // 80 üretim maliyetinin 60'ı filament (KDV'li alınmış)
    });
    // base = paketleme 10 + komisyon 26 + kargo 20 + sabit 5 + değişken 7.2 + filament 60.
    expect(result.inputVatCredit).toBeCloseTo(21.3666667, 5);
    expect(result.netProfit).toBeCloseTo(73.1666667, 5);
  });

  it("vatRate=0 iken KDV iadesi 0 (geriye dönük uyumluluk)", () => {
    const result = simulatePrice({
      salePrice: 200,
      productCost: 80,
      packagingCost: 10,
      categoryName: "Gamepad Stand",
      desi: 1,
      commissionRules,
      cargoRules,
      expenseRules,
      vatableProductCost: 50,
    });
    expect(result.inputVatCredit).toBe(0);
    expect(result.netProfit).toBe(57); // eski davranış korunur
  });

  it("discountBuffer kampanya indirimi sonrası gerçek kâr verir", () => {
    // salePrice=200 listelenmiş, %10 kampanya indirim payı
    // effective=180, exVat (KDV %20)=150, costs=...
    const result = simulatePrice({
      salePrice: 200,
      productCost: 80,
      packagingCost: 10,
      categoryName: "Gamepad Stand",
      desi: 1,
      commissionRules,
      cargoRules,
      expenseRules,
      vatRate: 20,
      discountBuffer: 10,
    });

    expect(result.salePrice).toBe(200);
    expect(result.effectiveSalePrice).toBeCloseTo(180, 5);
    expect(result.salePriceExVat).toBeCloseTo(150, 5);
    expect(result.discountBuffer).toBe(10);
  });

  it("commissionRateOverride ve cargoCostOverride platform-spesifik hesap için", () => {
    const result = simulatePrice({
      salePrice: 200,
      productCost: 80,
      packagingCost: 10,
      categoryName: "Gamepad Stand",
      desi: 1,
      commissionRules: [],
      cargoRules: [],
      expenseRules: [],
      commissionRateOverride: 0.12, // Hepsiburada %12
      cargoCostOverride: 35, // sabit 35 TL kargo
    });

    expect(result.appliedCommissionRule).toBeUndefined();
    expect(result.appliedCargoRule).toBeUndefined();
    expect(result.commissionCost).toBeCloseTo(24, 5); // 200 * 0.12
    expect(result.cargoCost).toBe(35);
    // totalCost = 80 + 10 + 24 + 35 = 149
    expect(result.totalCost).toBe(149);
    expect(result.netProfit).toBe(51);
  });

  it("trendyolMinQty fiyat baremini doğru uygular (üst sınır hariç)", () => {
    expect(trendyolMinQty(0)).toBe(6);
    expect(trendyolMinQty(24.99)).toBe(6);
    expect(trendyolMinQty(25)).toBe(4);
    expect(trendyolMinQty(34.99)).toBe(4);
    expect(trendyolMinQty(35)).toBe(3);
    expect(trendyolMinQty(49.99)).toBe(3);
    expect(trendyolMinQty(50)).toBe(2);
    expect(trendyolMinQty(74.99)).toBe(2);
    expect(trendyolMinQty(75)).toBe(1);
    expect(trendyolMinQty(199.99)).toBe(1);
  });

  it("minOrderQty>1: gelir+ürün+komisyon+değişken gider ×N, KARGO ve sabit gider TEK kez", () => {
    // 50₺ × 3 adet. Birim: commission 50*0.1+2=7, variable 50*0.03=1.5. desi*qty=0.5*3=1.5 → kargo 20.
    const result = simulatePrice({
      salePrice: 50,
      productCost: 10,
      packagingCost: 2,
      categoryName: "Gamepad Stand",
      desi: 0.5,
      commissionRules,
      cargoRules,
      expenseRules,
      minOrderQty: 3,
    });

    expect(result.minOrderQty).toBe(3);
    expect(result.cargoCost).toBe(20); // TEK kez (3× değil)
    expect(result.fixedExpenses).toBe(5); // TEK kez
    expect(result.productCost).toBe(30); // 10 × 3
    expect(result.packagingCost).toBe(6); // 2 × 3
    expect(result.commissionCost).toBe(21); // 7 × 3
    expect(result.variableExpenses).toBe(4.5); // 1.5 × 3
    // totalCost = 30 + 6 + 21 + 20 + 5 + 4.5 = 86.5 ; gelir 150 → kâr 63.5
    expect(result.totalCost).toBeCloseTo(86.5, 5);
    expect(result.netProfit).toBeCloseTo(63.5, 5);
  });

  it("paketleme kapsamlarında yalnız ürün başına kalemi adetle çarpar", () => {
    const result = simulatePrice({
      salePrice: 100,
      productCost: 10,
      packagingCost: 10,
      packagingUnitCost: 3,
      packagingOrderCost: 2,
      packagingShipmentCost: 5,
      categoryName: "Dekor",
      commissionRules: [],
      cargoRules: [],
      expenseRules: [],
      minOrderQty: 3,
    });

    expect(result.productCost).toBe(30);
    expect(result.packagingCost).toBe(16);
    expect(result.netProfit).toBe(254);
  });

  it("desi 0 ise kargo hesabında güvenli 1 desi kullanır", () => {
    const result = simulatePrice({
      salePrice: 100,
      productCost: 10,
      packagingCost: 0,
      categoryName: "Dekor",
      desi: 0,
      commissionRules: [],
      cargoRules: [
        {
          id: "one-desi",
          name: "1 desi",
          minPrice: 0,
          maxPrice: 999999,
          minDesi: 1,
          maxDesi: 1,
          cargoCost: 20,
          priority: 1,
          isActive: true,
        },
      ],
      expenseRules: [],
    });

    expect(result.cargoCost).toBe(20);
  });
});
