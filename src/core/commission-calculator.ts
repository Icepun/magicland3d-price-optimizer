import type { CommissionRuleInput } from "./types";
import { categoryMatchScore } from "./category";

/** Kuralın pazaryeri — boş (eski kural) Trendyol sayılır. */
export function komisyonKuraliPlatformu(rule: { platform?: string | null }): string {
  return rule.platform?.trim() || "trendyol";
}

/**
 * Uyan kurallar arasında KESİN sıra (Berke'nin onayı, 23 Kas 2026): kategori eşleşme gücü →
 * öncelik → dar fiyat bandı → kimlik. Eskiden eşitlikte listenin geliş sırası kazanıyordu; sırasız
 * okuyan ekranlarla sıralı okuyanlar (ve masaüstü ile telefon) aynı üründe farklı kural seçebiliyordu.
 */
export function komisyonKuraliSirasi(
  a: CommissionRuleInput,
  b: CommissionRuleInput,
  categoryName: string
): number {
  const aScore = categoryMatchScore(a.categoryName, categoryName);
  const bScore = categoryMatchScore(b.categoryName, categoryName);
  if (aScore !== bScore) return bScore - aScore;
  if (a.priority !== b.priority) return b.priority - a.priority;
  const aBant = a.maxPrice - a.minPrice;
  const bBant = b.maxPrice - b.minPrice;
  if (aBant !== bBant) return aBant - bBant;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function findCommissionRule(
  rules: CommissionRuleInput[],
  salePrice: number,
  categoryName: string,
  date: Date = new Date(),
  /** Verilirse yalnız o pazaryerinin kuralları uyar; verilmezse hepsi (eski davranış). */
  platform?: string
): CommissionRuleInput | undefined {
  const active = rules.filter((r) => {
    if (!r.isActive) return false;
    if (platform && komisyonKuraliPlatformu(r) !== platform) return false;
    if (salePrice < r.minPrice || salePrice > r.maxPrice) return false;
    if (r.validFrom && date < r.validFrom) return false;
    if (r.validTo && date > r.validTo) return false;
    if (r.categoryName && categoryMatchScore(r.categoryName, categoryName) === 0) {
      return false;
    }
    return true;
  });

  return active.sort((a, b) => komisyonKuraliSirasi(a, b, categoryName))[0];
}

export function calculateCommission(
  salePrice: number,
  rule: CommissionRuleInput
): number {
  return salePrice * rule.commissionRate + rule.fixedCommission;
}
