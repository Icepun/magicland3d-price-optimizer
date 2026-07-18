import { findCommissionRule, calculateCommission } from "./commission-calculator";
import { findCargoRule } from "./cargo-calculator";
import type {
  SimulationInput,
  SimulationResult,
  ExpenseRuleInput,
  AppliedExpenseRule,
} from "./types";

/** Gider eşleşme + tutar hesabı. Sipariş düzeyi SABİT gider de bunu kullanır → bant/kategori
 *  eşleşme kuralı TEK yerde kalır, iki hesap sessizce ayrışamaz. */
export function calculateExpenses(
  rules: ExpenseRuleInput[],
  salePrice: number,
  categoryName: string
): { fixed: number; variable: number; applied: AppliedExpenseRule[] } {
  const applicable = rules.filter((r) => {
    if (!r.isActive) return false;
    if (salePrice < r.minPrice || salePrice > r.maxPrice) return false;
    if (r.categoryName && !categoryName.toLowerCase().includes(r.categoryName.toLowerCase())) return false;
    return true;
  });

  let fixed = 0;
  let variable = 0;
  const applied: AppliedExpenseRule[] = [];

  for (const rule of applicable) {
    let amount = 0;
    if (rule.type === "fixed" || rule.type === "per_order") {
      amount = rule.value;
      fixed += amount;
    } else if (rule.type === "percentage") {
      amount = salePrice * rule.value;
      variable += amount;
    }
    applied.push({ ...rule, amount });
  }

  return { fixed, variable, applied };
}

/**
 * Gider kurallarını KAPSAMA göre ayırır (sınıflandırma calculateExpenses ile AYNI dalı kullanır):
 *   perUnit  = satır/adet başına (percentage — ciroyla orantılı)
 *   perOrder = siparişe BİR KEZ (fixed / per_order — ör. Platform Hizmet Bedeli)
 * Sipariş kârında sabit giderin her satırda tekrar kesilmesini önlemek için kullanılır.
 */
export function splitExpenseRulesByScope<T extends { type: string }>(
  rules: T[]
): { perUnit: T[]; perOrder: T[] } {
  const perUnit: T[] = [];
  const perOrder: T[] = [];
  for (const r of rules) {
    if (r.type === "fixed" || r.type === "per_order") perOrder.push(r);
    else if (r.type === "percentage") perUnit.push(r);
  }
  return { perUnit, perOrder };
}

/**
 * Trendyol "Minimum Sipariş Adedi" bareni: fiyat → müşterinin almak ZORUNDA olduğu min adet.
 * Trendyol satıcı panelindeki ayara göre (75₺ altı ürünlerde min adet artar). Üst sınır hariç:
 * <25₺→6, <35₺→4, <50₺→3, <75₺→2, ≥75₺→1. Yalnızca Trendyol için kullanılır.
 */
export function trendyolMinQty(price: number): number {
  if (price < 25) return 6;
  if (price < 35) return 4;
  if (price < 50) return 3;
  if (price < 75) return 2;
  return 1;
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
    vatableProductCost = 0,
    minOrderQty,
  } = input;

  // Min sipariş adedi (Trendyol bareni). >1 ise hesap N adetlik SİPARİŞ üzerinden yapılır.
  const qty = Math.max(1, Math.round(minOrderQty || 1));

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
      desi * qty, // N adetlik sipariş tek pakette → birleşik desiyle barem
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

  // SİPARİŞ bazlı toplam: per-unit kalemler (ürün/paketleme/komisyon/değişken gider) × qty;
  // KARGO ve sabit gider TEK kez (N ürün tek pakette gider). qty=1 → davranış aynı.
  const oProduct = productCost * qty;
  const oPackaging = packagingCost * qty;
  const oCommission = commissionCost * qty;
  const oVariable = variableExpenses * qty;
  const oFilament = (vatableProductCost || 0) * qty; // KDV'li malzeme payı (per-unit × qty)
  const orderRevenueExVat = salePriceExVat * qty;
  const totalCost = oProduct + oPackaging + oCommission + cargoCost + fixedExpenses + oVariable;

  // İNDİRİLECEK KDV İADESİ: komisyon + kargo + gider + filament malzemesinin İÇİNDEKİ KDV,
  // devlete ödenecek (hesaplanan) KDV'den düşülür → kâra ARTI yansır (KDV mükellefi). vatRate=0 → 0.
  const vatFactor = vatRate > 0 ? vatRate / (100 + vatRate) : 0;
  const inputVatCredit =
    (oCommission + cargoCost + fixedExpenses + oVariable + oFilament) * vatFactor;

  // Net kâr — N-adetlik siparişin KDV hariç geliri − tüm maliyetler + indirilecek KDV iadesi
  const netProfit = orderRevenueExVat - totalCost + inputVatCredit;
  const profitMargin = orderRevenueExVat > 0 ? netProfit / orderRevenueExVat : 0;

  return {
    salePrice,
    effectiveSalePrice,
    salePriceExVat, // birim (KDV hariç) gelir — sipariş geliri = salePriceExVat × minOrderQty
    vatAmount,
    vatRate: vatRate || 0,
    discountBuffer: discountBuffer || 0,
    productCost: oProduct,
    packagingCost: oPackaging,
    commissionCost: oCommission,
    cargoCost,
    fixedExpenses,
    variableExpenses: oVariable,
    totalCost,
    inputVatCredit,
    netProfit,
    profitMargin,
    minOrderQty: qty,
    appliedCommissionRule,
    appliedCargoRule,
    appliedExpenseRules,
  };
}
