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

/**
 * Tek bir listing için "şu an ne kadar kâr ediyor" hesabı.
 *
 * - salePrice = Trendyol/HB/Shopify'da listelenen fiyat (KDV dahil)
 * - discountBuffer > 0 ise effective fiyat = salePrice * (1 - discountBuffer/100)
 * - vatRate > 0 ise gelir = effective / (1 + vatRate/100)
 * - Komisyon: commissionRateOverride varsa onu kullan, yoksa rules
 * - Kargo: cargoCostOverride varsa onu kullan, yoksa rules
 *
 * Recommendation/öneri/simulation range yok — tek noktada net kâr.
 */
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
    simulationDate = new Date(),
    vatRate = 0,
    discountBuffer = 0,
    commissionRateOverride,
    commissionFixedOverride,
    cargoCostOverride,
  } = input;

  // Etkili fiyat (kampanya indirimi sonrası).
  const discountMultiplier = 1 - (discountBuffer || 0) / 100;
  const effectiveSalePrice = salePrice * discountMultiplier;

  // KDV ayrıştırması — etkili fiyattan.
  const vatMultiplier = 1 + (vatRate || 0) / 100;
  const salePriceExVat = vatMultiplier > 0 ? effectiveSalePrice / vatMultiplier : effectiveSalePrice;
  const vatAmount = effectiveSalePrice - salePriceExVat;

  // Komisyon — önce override, sonra rules
  let commissionCost = 0;
  let appliedCommissionRule;
  if (commissionRateOverride !== undefined || commissionFixedOverride !== undefined) {
    commissionCost =
      effectiveSalePrice * (commissionRateOverride ?? 0) + (commissionFixedOverride ?? 0);
  } else {
    appliedCommissionRule = findCommissionRule(
      commissionRules,
      effectiveSalePrice,
      categoryName,
      simulationDate
    );
    commissionCost = appliedCommissionRule
      ? calculateCommission(effectiveSalePrice, appliedCommissionRule)
      : 0;
  }

  // Kargo — önce override, sonra rules
  let cargoCost = 0;
  let appliedCargoRule;
  if (cargoCostOverride !== undefined) {
    cargoCost = cargoCostOverride;
  } else {
    appliedCargoRule = findCargoRule(
      cargoRules,
      effectiveSalePrice,
      categoryName,
      desi,
      simulationDate
    );
    cargoCost = appliedCargoRule ? appliedCargoRule.cargoCost : 0;
  }

  // Sabit ve değişken giderler (gider kuralları)
  const {
    fixed: fixedExpenses,
    variable: variableExpenses,
    applied: appliedExpenseRules,
  } = calculateExpenses(expenseRules, effectiveSalePrice, categoryName);

  // Toplam maliyet — tüm bu kalemler ex-VAT baz (KDV reclaim varsayımı)
  const totalCost =
    productCost +
    packagingCost +
    commissionCost +
    cargoCost +
    fixedExpenses +
    variableExpenses;

  // Net kâr — KDV hariç gelir - tüm maliyetler
  const netProfit = salePriceExVat - totalCost;
  const profitMargin = salePriceExVat > 0 ? netProfit / salePriceExVat : 0;

  return {
    salePrice,
    effectiveSalePrice,
    salePriceExVat,
    vatAmount,
    vatRate: vatRate || 0,
    discountBuffer: discountBuffer || 0,
    productCost,
    packagingCost,
    commissionCost,
    cargoCost,
    fixedExpenses,
    variableExpenses,
    totalCost,
    netProfit,
    profitMargin,
    appliedCommissionRule,
    appliedCargoRule,
    appliedExpenseRules,
  };
}
