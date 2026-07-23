export interface PriceRange {
  minPrice: number;
  maxPrice: number;
}

/** Kuralın devreye girdiği ve çıktığı kuruşları arama bölme noktalarına çevirir. */
export function collectRulePriceBreakpoints(
  ...ruleGroups: readonly (readonly PriceRange[])[]
): number[] {
  const points: number[] = [];
  for (const rules of ruleGroups) {
    for (const rule of rules) {
      if (Number.isFinite(rule.minPrice)) points.push(rule.minPrice);
      if (Number.isFinite(rule.maxPrice)) points.push(rule.maxPrice + 0.01);
    }
  }
  return points;
}

/**
 * Hedef marjı sağlayan en düşük fiyatı kuruş hassasiyetinde bulur.
 *
 * Kargo/komisyon/minimum-adet eşiklerinde marj aşağı sıçrayabildiği için bütün aralıkta tek
 * binary search doğru değildir. Önce kural eşiklerine göre sabit aralıklara böler, sonra her
 * aralığı küçük fiyattan büyüğe arar.
 */
export function findMinimumPriceForMargin({
  marginAt,
  targetMargin,
  breakpoints = [],
  minPrice = 0.5,
  maxPrice = 100_000,
}: {
  marginAt: (price: number) => number;
  targetMargin: number;
  breakpoints?: number[];
  minPrice?: number;
  maxPrice?: number;
}): number | null {
  const meetsTarget = (margin: number) => margin >= targetMargin - 1e-12;
  const minCent = Math.max(0, Math.ceil(minPrice * 100 - 1e-7));
  const maxCent = Math.floor(maxPrice * 100 + 1e-7);
  if (maxCent < minCent) return null;

  const cuts = new Set<number>([minCent, maxCent + 1]);
  for (const point of breakpoints) {
    if (!Number.isFinite(point)) continue;
    const cent = Math.round(point * 100);
    if (cent > minCent && cent <= maxCent) cuts.add(cent);
  }
  const sorted = [...cuts].sort((a, b) => a - b);

  for (let index = 0; index < sorted.length - 1; index++) {
    let lo = sorted[index];
    let hi = sorted[index + 1] - 1;
    if (lo > hi) continue;

    if (meetsTarget(marginAt(lo / 100))) return lo / 100;
    if (!meetsTarget(marginAt(hi / 100))) continue;

    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (meetsTarget(marginAt(mid / 100))) hi = mid;
      else lo = mid + 1;
    }
    if (meetsTarget(marginAt(lo / 100))) return lo / 100;
  }

  return null;
}
