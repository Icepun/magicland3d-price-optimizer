import type { CommissionRuleInput } from "./types";

export function findCommissionRule(
  rules: CommissionRuleInput[],
  salePrice: number,
  categoryName: string,
  date: Date = new Date()
): CommissionRuleInput | undefined {
  const active = rules.filter((r) => {
    if (!r.isActive) return false;
    if (salePrice < r.minPrice || salePrice > r.maxPrice) return false;
    if (r.validFrom && date < r.validFrom) return false;
    if (r.validTo && date > r.validTo) return false;
    return true;
  });

  // Sort: category-specific first, then by priority desc
  const sorted = active.sort((a, b) => {
    const aSpecific = a.categoryName
      ? categoryName
          .toLowerCase()
          .includes(a.categoryName.toLowerCase())
        ? 1
        : 0
      : 0;
    const bSpecific = b.categoryName
      ? categoryName
          .toLowerCase()
          .includes(b.categoryName.toLowerCase())
        ? 1
        : 0
      : 0;
    if (aSpecific !== bSpecific) return bSpecific - aSpecific;
    return b.priority - a.priority;
  });

  return sorted[0];
}

export function calculateCommission(
  salePrice: number,
  rule: CommissionRuleInput
): number {
  return salePrice * rule.commissionRate + rule.fixedCommission;
}
