import type { CargoRuleInput } from "./types";
import { categoryMatches } from "./category";

/**
 * Kuralları platforma göre filtreler. platform alanı null olan kurallar tüm
 * platformlara uygulanır. Kargo + gider kuralları için ortak kullanılır.
 */
export function filterRulesByPlatform<T extends { platform?: string | null }>(
  rules: T[],
  platform: string
): T[] {
  return rules.filter((r) => !r.platform || r.platform === platform);
}

/** @deprecated filterRulesByPlatform kullan */
export function filterCargoRulesByPlatform(
  rules: CargoRuleInput[],
  platform: string
): CargoRuleInput[] {
  return filterRulesByPlatform(rules, platform);
}

export function findCargoRule(
  rules: CargoRuleInput[],
  salePrice: number,
  categoryName: string,
  desi: number = 1,
  date: Date = new Date()
): CargoRuleInput | undefined {
  const active = rules.filter((r) => {
    if (!r.isActive) return false;
    if (salePrice < r.minPrice || salePrice > r.maxPrice) return false;
    if (desi < r.minDesi || desi > r.maxDesi) return false;
    if (r.validFrom && date < r.validFrom) return false;
    if (r.validTo && date > r.validTo) return false;
    if (!categoryMatches(r.categoryName, categoryName)) return false;
    return true;
  });

  const sorted = active.sort((a, b) => {
    const aSpecific = a.categoryName?.trim() ? 1 : 0;
    const bSpecific = b.categoryName?.trim() ? 1 : 0;
    if (aSpecific !== bSpecific) return bSpecific - aSpecific;
    return b.priority - a.priority;
  });

  return sorted[0];
}
