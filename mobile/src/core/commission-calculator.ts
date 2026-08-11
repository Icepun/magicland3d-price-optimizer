import type { CommissionRuleInput } from "./types";
import { categoryMatchScore } from "./category";

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
    if (r.categoryName && categoryMatchScore(r.categoryName, categoryName) === 0) {
      return false;
    }
    return true;
  });

  // Sort: exact/longer category matches first, then by priority desc.
  const sorted = active.sort((a, b) => {
    const aScore = categoryMatchScore(a.categoryName, categoryName);
    const bScore = categoryMatchScore(b.categoryName, categoryName);
    if (aScore !== bScore) return bScore - aScore;
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
