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
  type: "fixed" | "percentage" | "per_order";
  value: number;
  categoryName?: string | null;
  minPrice: number;
  maxPrice: number;
  priority: number;
  isActive: boolean;
}

export interface SimulationInput {
  salePrice: number;
  productCost: number;
  packagingCost: number;
  categoryName: string;
  desi?: number;
  commissionRules: CommissionRuleInput[];
  cargoRules: CargoRuleInput[];
  expenseRules: ExpenseRuleInput[];
  minNetProfit?: number;
  minProfitMargin?: number;
  minAllowedPrice?: number;
  maxAllowedPrice?: number;
  simulationDate?: Date;
}

export interface SimulationResult {
  salePrice: number;
  productCost: number;
  packagingCost: number;
  commissionCost: number;
  cargoCost: number;
  fixedExpenses: number;
  variableExpenses: number;
  totalCost: number;
  netProfit: number;
  profitMargin: number;
  isValid: boolean;
  invalidReasons: string[];
  appliedCommissionRule?: CommissionRuleInput;
  appliedCargoRule?: CargoRuleInput;
  appliedExpenseRules: ExpenseRuleInput[];
}

export interface RecommendationCandidate {
  salePrice: number;
  result: SimulationResult;
  type: "bestNetProfit" | "bestMargin" | "safe";
  reason: string;
}

export interface RecommendationOutput {
  bestNetProfit?: RecommendationCandidate;
  bestMargin?: RecommendationCandidate;
  safe?: RecommendationCandidate;
  allValid: SimulationResult[];
}

export const PSYCHOLOGICAL_PRICES = [
  49, 79, 99, 119, 139, 149, 169, 179, 189, 199, 219, 229, 249, 269, 279, 289,
  299, 319, 329, 339, 349, 369, 379, 389, 399, 419, 429, 449, 469, 479, 499,
  519, 529, 549, 569, 579, 599, 619, 629, 649, 679, 699, 749, 799, 849, 899,
  949, 999, 1099, 1199, 1299, 1399, 1499, 1599, 1699, 1799, 1899, 1999,
];
