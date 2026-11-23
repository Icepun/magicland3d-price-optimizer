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

  // KESİN sıra (Berke'nin onayı, 23 Kas 2026): kategorili → öncelik → dar desi bandı → dar fiyat
  // bandı → kimlik. Eşitlikte listenin geliş sırası kazanıyordu; iki uç dahil olduğu için 0–150 ve
  // 150–300 bantları tam 150 ₺'de ikisi de uyuyor, masaüstü ile telefon farklı kural seçebiliyordu.
  const sorted = active.sort((a, b) => {
    const aSpecific = a.categoryName?.trim() ? 1 : 0;
    const bSpecific = b.categoryName?.trim() ? 1 : 0;
    if (aSpecific !== bSpecific) return bSpecific - aSpecific;
    if (a.priority !== b.priority) return b.priority - a.priority;
    const aDesi = a.maxDesi - a.minDesi;
    const bDesi = b.maxDesi - b.minDesi;
    if (aDesi !== bDesi) return aDesi - bDesi;
    const aFiyat = a.maxPrice - a.minPrice;
    const bFiyat = b.maxPrice - b.minPrice;
    if (aFiyat !== bFiyat) return aFiyat - bFiyat;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return sorted[0];
}

/**
 * Kargo baremi için desi: en yakın tam sayı, en az 1 (`kargo-tarife.fiyatDesisi` ile aynı kural).
 * Sipariş kârı, Ürünler/Fiyat Lab ve elle sipariş AYNI desiyle barem arasın: Shopify baremleri
 * 0–4 / 5–10 diye tam sayı, 4,1 desi hiçbir banda uymuyor, kargo 0 sayılıyordu (onay, 23 Kas 2026).
 */
export function baremDesisi(desi: number): number {
  return Math.max(1, Math.round(Number.isFinite(desi) && desi > 0 ? desi : 1));
}
