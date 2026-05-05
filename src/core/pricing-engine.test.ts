import { describe, expect, it } from "vitest";
import { simulatePrice } from "./pricing-engine";
import { generateRecommendations } from "./recommendation-engine";
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
      minNetProfit: 20,
      minProfitMargin: 0.1,
    });

    expect(result.appliedCommissionRule?.id).toBe("commission-category");
    expect(result.commissionCost).toBe(22);
    expect(result.cargoCost).toBe(20);
    expect(result.fixedExpenses).toBe(5);
    expect(result.variableExpenses).toBe(6);
    expect(result.totalCost).toBe(143);
    expect(result.netProfit).toBe(57);
    expect(result.profitMargin).toBeCloseTo(0.285);
    expect(result.isValid).toBe(true);
  });

  it("marks prices invalid when minimum profit constraints are not met", () => {
    const result = simulatePrice({
      salePrice: 100,
      productCost: 80,
      packagingCost: 10,
      categoryName: "Gamepad Stand",
      desi: 1,
      commissionRules,
      cargoRules,
      expenseRules,
      minNetProfit: 20,
      minProfitMargin: 0.1,
    });

    expect(result.isValid).toBe(false);
    expect(result.invalidReasons.length).toBeGreaterThan(0);
  });

  it("generates a safe recommendation when a nearby price improves profit", () => {
    const output = generateRecommendations(
      {
        productCost: 80,
        packagingCost: 10,
        categoryName: "Gamepad Stand",
        desi: 1,
        commissionRules,
        cargoRules,
        expenseRules,
        minNetProfit: 0,
        minProfitMargin: 0,
      },
      149,
      { min: 149, max: 249 }
    );

    expect(output.allValid.length).toBeGreaterThan(0);
    expect(output.bestNetProfit?.result.netProfit).toBeGreaterThan(0);
    expect(output.safe?.salePrice).toBeDefined();
  });
});
