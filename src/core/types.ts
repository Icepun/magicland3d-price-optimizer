export interface ProductCostInput {
  manualCost?: number;
  materialWeight?: number;
  printTimeHours?: number;
  materialCostPerGram?: number;
  electricityCostPerHour?: number;
  machineWearCostPerHour?: number;
  packagingCost?: number;
  laborCost?: number;
  otherCost?: number;
  wasteRate?: number;
}

export interface CommissionRuleInput {
  id: string;
  name: string;
  categoryName?: string | null;
  minPrice: number;
  maxPrice: number;
  commissionRate: number;
  fixedCommission: number;
  priority: number;
  validFrom?: Date | null;
  validTo?: Date | null;
  isActive: boolean;
}

export interface CargoRuleInput {
  id: string;
  name: string;
  platform?: string | null;
  cargoProvider?: string | null;
  categoryName?: string | null;
  minPrice: number;
  maxPrice: number;
  minDesi: number;
  maxDesi: number;
  cargoCost: number;
  priority: number;
  validFrom?: Date | null;
  validTo?: Date | null;
  isActive: boolean;
}

export interface ExpenseRuleInput {
  id: string;
  name: string;
  platform?: string | null;
  type: "fixed" | "percentage" | "per_order";
  value: number;
  categoryName?: string | null;
  minPrice: number;
  maxPrice: number;
  priority: number;
  isActive: boolean;
}

/**
 * Bir listing'e uygulanmış tek bir gider kuralı + hesaplanan TL tutarı.
 * Kâr dökümünde her gider artık tek tek kendi adıyla satır olarak gösterilir
 * ("Diğer Giderler" toplamı yerine).
 */
export interface AppliedExpenseRule extends ExpenseRuleInput {
  /** Bu kuralın bu fiyat için hesaplanmış gider tutarı (TL). */
  amount: number;
}

/**
 * Tek bir listing için kâr hesabı girdisi.
 * Recommendation/öneri sistemi yok — sadece "şu an ne kadar kâr ediyor" hesabı.
 */
export interface SimulationInput {
  salePrice: number;
  productCost: number;
  packagingCost: number;
  categoryName: string;
  desi?: number;
  commissionRules: CommissionRuleInput[];
  cargoRules: CargoRuleInput[];
  expenseRules: ExpenseRuleInput[];
  simulationDate?: Date;
  /**
   * KDV oranı (yüzde olarak, 20 = %20 KDV).
   * Belirtildiğinde salePrice KDV dahil sayılır;
   * net kâr salePrice/(1+vat/100) bazından hesaplanır.
   */
  vatRate?: number;
  /**
   * Kampanya indirim payı (yüzde). Default 0 = indirim yok.
   * Net kâr `salePrice * (1 - discountBuffer/100)` üzerinden hesaplanır.
   * Listelenen fiyat değişmez ama kâr hesabı kampanya inse bile garanti olur.
   */
  discountBuffer?: number;
  /**
   * Komisyon oranı override'ı (yüzde). Belirtilirse commissionRules'a bakmaksızın
   * doğrudan bu oranı kullanır. Platform listing'leri için lazım: Shopify sabit
   * %3.2, Trendyol kategori bazlı gibi farklı oranlar.
   */
  commissionRateOverride?: number;
  /**
   * Sabit komisyon override'ı (TL). Belirtilirse rules'tan değil bu kullanılır.
   */
  commissionFixedOverride?: number;
  /**
   * Kargo override'ı (TL). Belirtilirse cargoRules'a bakmadan bu kullanılır.
   */
  cargoCostOverride?: number;
}

export interface SimulationResult {
  /** Listelenen fiyat (KDV dahil, kampanya öncesi). */
  salePrice: number;
  /** İndirim payı uygulandıktan sonraki etkili fiyat (müşterinin ödediği). */
  effectiveSalePrice: number;
  /** effectiveSalePrice / (1 + vatRate/100) */
  salePriceExVat: number;
  vatAmount: number;
  vatRate: number;
  discountBuffer: number;
  productCost: number;
  packagingCost: number;
  commissionCost: number;
  cargoCost: number;
  fixedExpenses: number;
  variableExpenses: number;
  totalCost: number;
  netProfit: number;
  profitMargin: number;
  appliedCommissionRule?: CommissionRuleInput;
  appliedCargoRule?: CargoRuleInput;
  appliedExpenseRules: AppliedExpenseRule[];
}
