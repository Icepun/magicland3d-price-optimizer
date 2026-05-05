import { findCommissionRule, calculateCommission } from "./commission-calculator";
import { findCargoRule } from "./cargo-calculator";
import type {
  SimulationInput,
  SimulationResult,
  ExpenseRuleInput,
} from "./types";

function calculateExpenses(
  rules: ExpenseRuleInput[],
  salePrice: number,
  categoryName: string
): { fixed: number; variable: number; applied: ExpenseRuleInput[] } {
  const applicable = rules.filter((r) => {
    if (!r.isActive) return false;
    if (salePrice < r.minPrice || salePrice > r.maxPrice) return false;
    if (r.categoryName && !categoryName.toLowerCase().includes(r.categoryName.toLowerCase())) return false;
    return true;
  });

  let fixed = 0;
  let variable = 0;

  for (const rule of applicable) {
    if (rule.type === "fixed" || rule.type === "per_order") {
      fixed += rule.value;
    } else if (rule.type === "percentage") {
      variable += salePrice * rule.value;
    }
  }

  return { fixed, variable, applied: applicable };
}

export function simulatePrice(input: SimulationInput): SimulationResult {
  const {
    salePrice,
    productCost,
    packagingCost,
    categoryName,
    desi = 1,
    commissionRules,
    cargoRules,
    expenseRules,
    minNetProfit,
    minProfitMargin,
    minAllowedPrice,
    maxAllowedPrice,
    simulationDate = new Date(),
  } = input;

  const appliedCommissionRule = findCommissionRule(
    commissionRules,
    salePrice,
    categoryName,
    simulationDate
  );
  const appliedCargoRule = findCargoRule(
    cargoRules,
    salePrice,
    categoryName,
    desi,
    simulationDate
  );

  const commissionCost = appliedCommissionRule
    ? calculateCommission(salePrice, appliedCommissionRule)
    : 0;
  const cargoCost = appliedCargoRule ? appliedCargoRule.cargoCost : 0;

  const { fixed: fixedExpenses, variable: variableExpenses, applied: appliedExpenseRules } =
    calculateExpenses(expenseRules, salePrice, categoryName);

  const totalCost =
    productCost +
    packagingCost +
    commissionCost +
    cargoCost +
    fixedExpenses +
    variableExpenses;

  const netProfit = salePrice - totalCost;
  const profitMargin = salePrice > 0 ? netProfit / salePrice : 0;

  const invalidReasons: string[] = [];
  if (minNetProfit !== undefined && netProfit < minNetProfit) {
    invalidReasons.push(`Net kâr ${netProfit.toFixed(2)} TL < minimum ${minNetProfit} TL`);
  }
  if (minProfitMargin !== undefined && profitMargin < minProfitMargin) {
    invalidReasons.push(`Kâr oranı %${(profitMargin * 100).toFixed(1)} < minimum %${(minProfitMargin * 100).toFixed(1)}`);
  }
  if (minAllowedPrice !== undefined && salePrice < minAllowedPrice) {
    invalidReasons.push(`Fiyat ${salePrice} TL < minimum izin verilen ${minAllowedPrice} TL`);
  }
  if (maxAllowedPrice !== undefined && salePrice > maxAllowedPrice) {
    invalidReasons.push(`Fiyat ${salePrice} TL > maksimum izin verilen ${maxAllowedPrice} TL`);
  }

  return {
    salePrice,
    productCost,
    packagingCost,
    commissionCost,
    cargoCost,
    fixedExpenses,
    variableExpenses,
    totalCost,
    netProfit,
    profitMargin,
    isValid: invalidReasons.length === 0,
    invalidReasons,
    appliedCommissionRule,
    appliedCargoRule,
    appliedExpenseRules,
  };
}

export function simulateRange(
  baseInput: Omit<SimulationInput, "salePrice">,
  prices: number[]
): SimulationResult[] {
  return prices.map((price) =>
    simulatePrice({ ...baseInput, salePrice: price })
  );
}
