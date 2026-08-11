import type {
  PackagingComponentKey,
  PackagingScope,
} from "./packaging";

export const MANUAL_ORDER_CALCULATION_VERSION = 1;

export type ManualOrderMode = "catalog" | "freeform";

export type ManualOrderStatusKind =
  | "pending"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled";

export interface ManualOrderResolvedItem {
  id: string;
  productId: string | null;
  name: string;
  imageUrl: string | null;
  quantity: number;
  /** Gerçek sıfır maliyet ile eksik maliyeti birbirinden ayırır. */
  costKnown: boolean;
  productionCost: number;
  packagingCost: number;
  filamentCost: number;
  packagingComponents?: {
    key: PackagingComponentKey;
    scope: PackagingScope;
    cost: number;
  }[] | null;
  /**
   * Serbest kalemin maliyeti NASIL belirlendi:
   *   "manual"   → kullanıcı tek bir birim maliyet yazdı (manualUnitCost).
   *   "detailed" → filament türü/gramajı + baskı süresi girildi; maliyet katalog ürünüyle
   *                AYNI motorla hesaplandı (filament + elektrik + makine aşınması + işçilik)
   *                ve filament payı indirilecek KDV'ye girer.
   * Katalog kalemlerinde alan kullanılmaz (her zaman detaylı).
   */
  costSource?: "manual" | "detailed";
  /** Serbest kalemin desisi — sipariş kargosu bunların toplamından hesaplanır. */
  desi?: number | null;
  /** Freeform satırın kullanıcı tarafından girilen birim maliyeti. */
  manualUnitCost?: number | null;
  /** Freeform maliyet faturası varsa birim maliyetin iç KDV'si indirilebilir. */
  manualCostHasVatInvoice?: boolean;
}

export interface ManualOrderMoneyCost {
  amount: number;
  /** Gider faturası var ve tutarın iç KDV'si indirilecek KDV'ye girebilir. */
  hasVatInvoice: boolean;
}

export interface ManualOrderSelectedExpense {
  id: string;
  name: string;
  type: "fixed" | "percentage" | "per_order";
  value: number;
  /** Çözülmüş sipariş tutarı. Verilmezse type/value üzerinden hesaplanır. */
  amount?: number;
  hasVatInvoice: boolean;
}

export interface ManualOrderCustomExpense {
  id: string;
  name: string;
  amount: number;
  hasVatInvoice: boolean;
}

export interface ManualOrderCalculationInput {
  saleTotal: number;
  vatRate: number;
  mode: ManualOrderMode;
  items: ManualOrderResolvedItem[];
  includeProductCost: boolean;
  includePackaging: boolean;
  commission: ManualOrderMoneyCost;
  /**
   * Kargo tutarı (KDV dahil brüt). Custom siparişte bu değer ELLE girilmez: çağıran
   * (lib/manual-orders) kalemlerin toplam desisinden Shopify baremiyle çözer ve buraya yazar.
   *
   * NEDEN çözüm burada DEĞİL: kargo kuralları hesabın girdisi olsaydı, kural listesinin
   * tamamı her manuel siparişin kayıtlı hesabına gömülürdü (şişkinlik) ve kayıt sonradan
   * yeniden doğrulanamazdı. Bu şekilde kayıt küçük, kendine yeter ve o günkü tarife donar.
   */
  cargo: ManualOrderMoneyCost;
  /** Kargo desiden mi çözüldü (yalnız gösterim/doğrulama için taşınır). */
  cargoAuto?: boolean;
  /** Kargonun hesaplandığı toplam desi. */
  cargoDesi?: number;
  /** Otomatik kargoda hiçbir barem eşleşmedi → tutar ₺0 kaldı, kullanıcı uyarılmalı. */
  cargoRuleMissing?: boolean;
  expenseRules: ManualOrderSelectedExpense[];
  customExpenses: ManualOrderCustomExpense[];
}

export interface ManualOrderBreakdown {
  grossRevenue: number;
  netRevenue: number;
  outputVat: number;
  productCost: number;
  packagingCost: number;
  commissionCost: number;
  cargoCost: number;
  expenseRulesCost: number;
  customExpensesCost: number;
  totalCost: number;
  inputVatCredit: number;
  netProfit: number | null;
  profitPartial: boolean;
  missingCostItems: number;
  profitMargin: number | null;
  /** Kargo desiden mi hesaplandı (true) yoksa elle mi girildi (false). */
  cargoAuto: boolean;
  /** Kargonun hesaplandığı toplam desi (autoCargo açıkken). */
  cargoDesi: number;
  /** autoCargo açık ama hiçbir barem eşleşmedi → kargo ₺0 sayıldı, kullanıcı UYARILMALI. */
  cargoRuleMissing: boolean;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function safeQuantity(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
}

function selectedExpenseAmount(
  expense: ManualOrderSelectedExpense,
  grossRevenue: number
): number {
  if (expense.amount != null) return nonNegative(expense.amount);
  if (expense.type === "percentage") {
    return nonNegative(grossRevenue * expense.value);
  }
  return nonNegative(expense.value);
}

/**
 * Manuel siparişin kalıcı finans anlık görüntüsünü hesaplar.
 *
 * - Satış ve tüm dış giderler KDV dahil tutardır.
 * - Ürün filament payı ile paketleme, mevcut sipariş kâr motoruyla aynı şekilde
 *   indirilecek KDV üretir.
 * - Manuel komisyon/kargo/kural/özel gider yalnız `hasVatInvoice` seçildiyse
 *   indirilecek KDV üretir.
 * - Eksik maliyet sıfır sayılmaz. Kullanıcı maliyeti açıkça hariç tutarsa
 *   `includeProductCost=false` olur ve sonuç tam hesap kabul edilir.
 */
export function calculateManualOrder(
  input: ManualOrderCalculationInput
): ManualOrderBreakdown {
  const grossRevenue = nonNegative(input.saleTotal);
  const vatRate = nonNegative(input.vatRate);
  const vatMultiplier = 1 + vatRate / 100;
  const vatFactor = vatRate > 0 ? vatRate / (100 + vatRate) : 0;
  const netRevenue = grossRevenue / vatMultiplier;
  const outputVat = grossRevenue - netRevenue;

  let productCost = 0;
  let filamentCost = 0;
  let freeformVatableCost = 0;
  let missingCostItems = 0;

  // Kargo baremi için toplam desi — kalem maliyeti hariç tutulsa bile kargo hesaplanır.
  let totalDesi = 0;
  for (const item of input.items) {
    const quantity = safeQuantity(item.quantity);
    if (item.desi != null && Number.isFinite(item.desi) && item.desi >= 0) {
      totalDesi += item.desi * quantity;
    }
  }

  for (const item of input.items) {
    const quantity = safeQuantity(item.quantity);
    if (!input.includeProductCost) continue;

    // Katalog kalemi HER ZAMAN detaylıdır. Serbest kalem ise ya tek bir birim maliyetle
    // ya da filament/süre girdileriyle (katalogla aynı motor) hesaplanmış olabilir.
    const detailed = input.mode === "catalog" || item.costSource === "detailed";
    const unitCost = detailed ? item.productionCost : item.manualUnitCost;
    if (!item.costKnown || unitCost == null || !Number.isFinite(unitCost)) {
      missingCostItems++;
      continue;
    }

    productCost += nonNegative(unitCost) * quantity;
    if (detailed) {
      // Filament payı faturalı malzemedir → indirilecek KDV'ye girer (katalogla birebir).
      filamentCost += nonNegative(item.filamentCost) * quantity;
    } else if (item.manualCostHasVatInvoice) {
      freeformVatableCost += nonNegative(unitCost) * quantity;
    }
  }

  let packagingCost = 0;
  if (input.includePackaging && input.mode === "catalog") {
    const sharedPackaging = new Map<
      PackagingComponentKey,
      { scope: Exclude<PackagingScope, "per_unit">; cost: number }
    >();
    for (const item of input.items) {
      const quantity = safeQuantity(item.quantity);
      const components = item.packagingComponents;
      if (!components?.length) {
        packagingCost += nonNegative(item.packagingCost) * quantity;
        continue;
      }

      for (const component of components) {
        const cost = nonNegative(component.cost);
        if (component.scope === "per_unit") {
          packagingCost += cost * quantity;
          continue;
        }
        const current = sharedPackaging.get(component.key);
        if (!current || cost > current.cost) {
          sharedPackaging.set(component.key, {
            scope: component.scope,
            cost,
          });
        }
      }
    }
    packagingCost += [...sharedPackaging.values()].reduce(
      (sum, component) => sum + component.cost,
      0
    );
  }

  const commissionCost = nonNegative(input.commission.amount);

  const cargoCost = nonNegative(input.cargo.amount);
  const resolvedExpenseRules = input.expenseRules.map((expense) => ({
    ...expense,
    resolvedAmount: selectedExpenseAmount(expense, grossRevenue),
  }));
  const expenseRulesCost = resolvedExpenseRules.reduce(
    (sum, expense) => sum + expense.resolvedAmount,
    0
  );
  const customExpensesCost = input.customExpenses.reduce(
    (sum, expense) => sum + nonNegative(expense.amount),
    0
  );
  const totalCost =
    productCost +
    packagingCost +
    commissionCost +
    cargoCost +
    expenseRulesCost +
    customExpensesCost;

  const vatableExternalCost =
    (input.commission.hasVatInvoice ? commissionCost : 0) +
    (input.cargo.hasVatInvoice ? cargoCost : 0) +
    resolvedExpenseRules.reduce(
      (sum, expense) =>
        sum + (expense.hasVatInvoice ? expense.resolvedAmount : 0),
      0
    ) +
    input.customExpenses.reduce(
      (sum, expense) =>
        sum + (expense.hasVatInvoice ? nonNegative(expense.amount) : 0),
      0
    );
  const inputVatCredit =
    (filamentCost +
      freeformVatableCost +
      packagingCost +
      vatableExternalCost) *
      vatFactor;
  const profitPartial = missingCostItems > 0;
  const netProfit = profitPartial
    ? null
    : netRevenue - totalCost + inputVatCredit;

  return {
    grossRevenue,
    netRevenue,
    outputVat,
    productCost,
    packagingCost,
    commissionCost,
    cargoCost,
    expenseRulesCost,
    customExpensesCost,
    totalCost,
    inputVatCredit,
    netProfit,
    profitPartial,
    missingCostItems,
    profitMargin:
      netProfit == null || netRevenue <= 0 ? null : netProfit / netRevenue,
    cargoAuto: input.cargoAuto === true,
    cargoDesi: input.cargoDesi ?? totalDesi,
    cargoRuleMissing: input.cargoRuleMissing === true,
  };
}
