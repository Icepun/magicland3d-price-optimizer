import { computeProductProfit, type Rules } from "@/lib/profit";
import type { ProductDetail } from "@/lib/db/product-detail";

export interface PlatformSummary {
  platform: "shopify" | "trendyol";
  listingCount: number;
  totalProfit: number;
  avgMargin: number;
  lossCount: number;
}

export interface DashboardSummary {
  totalProducts: number;
  outOfStock: number;
  missingCost: number;
  totalProfit: number;
  lossListings: number;
  platforms: PlatformSummary[];
}

/** Masaüstü /api/dashboard ile aynı toplama mantığı (@core ile per-listing kâr). */
export function computeDashboard(
  products: ProductDetail[],
  rules: Rules,
  settings: Record<string, string>
): DashboardSummary {
  const acc: Record<string, { profit: number; margin: number; count: number; loss: number }> = {
    shopify: { profit: 0, margin: 0, count: 0, loss: 0 },
    trendyol: { profit: 0, margin: 0, count: 0, loss: 0 },
  };
  let outOfStock = 0;
  let missingCost = 0;
  let totalProfit = 0;
  let lossListings = 0;

  for (const p of products) {
    if (p.stock <= 0) outOfStock++;
    const profit = computeProductProfit(p, rules, settings);
    if (!profit.hasCost) {
      missingCost++;
      continue;
    }
    for (const pl of profit.platforms) {
      const m = acc[pl.platform];
      if (!m) continue;
      m.profit += pl.result.netProfit;
      m.margin += pl.result.profitMargin;
      m.count++;
      totalProfit += pl.result.netProfit;
      if (pl.result.netProfit < 0) {
        m.loss++;
        lossListings++;
      }
    }
  }

  const platforms: PlatformSummary[] = (["shopify", "trendyol"] as const).map((plat) => ({
    platform: plat,
    listingCount: acc[plat].count,
    totalProfit: acc[plat].profit,
    avgMargin: acc[plat].count > 0 ? acc[plat].margin / acc[plat].count : 0,
    lossCount: acc[plat].loss,
  }));

  return {
    totalProducts: products.length,
    outOfStock,
    missingCost,
    totalProfit,
    lossListings,
    platforms,
  };
}
