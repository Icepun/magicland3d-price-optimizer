import { describe, expect, it } from "vitest";
import { simulatePrice } from "./pricing-engine";
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
    expect(result.netProfit).toBeCloseTo(51.8, 5);
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
});
