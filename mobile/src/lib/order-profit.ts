import { simulatePrice } from "@core/pricing-engine";
import { resolveProductCost } from "@core/product-cost";
import {
  withProductCommissionRule,
  resolveListingCommissionOverride,
} from "@core/product-commission";
import {
  filterCargoRulesByPlatform,
  filterRulesByPlatform,
} from "@core/cargo-calculator";

import type { ProductDetail } from "@/lib/db/product-detail";
import type { Rules } from "@/lib/profit";
import type { UnifiedOrder } from "@/lib/api/orders";

export interface MatchedProduct {
  imageUrl: string | null;
  name: string;
  detail: ProductDetail;
}

/** Çok-anahtarlı ürün haritası: Product.barcode/sku + Listing.externalId/externalSku → ürün. */
export function buildProductMap(products: ProductDetail[]): Map<string, ProductDetail> {
  const m = new Map<string, ProductDetail>();
  const add = (k: string | null | undefined, p: ProductDetail) => {
    if (k && !m.has(k)) m.set(k, p);
  };
  for (const p of products) {
    add(p.barcode, p);
    add(p.sku, p);
    for (const l of p.listings) {
      add(l.externalId, p);
      add(l.externalSku, p);
    }
  }
  return m;
}

/** Bir sipariş satırını aday anahtarlarıyla ürüne eşle. */
function matchLine(
  keys: string[] | undefined,
  productMap: Map<string, ProductDetail>
): ProductDetail | undefined {
  for (const k of keys ?? []) {
    const p = productMap.get(k);
    if (p) return p;
  }
  return undefined;
}
export { matchLine };

export interface OrderProfit {
  revenue: number;
  profit: number | null; // null = hiç eşleşme/maliyet yok
  partial: boolean; // bazı satırlar eşleşmedi
  /** kapak görseli: tek farklı ürün varsa onun fotosu */
  image: string | null;
  distinctCount: number; // farklı ürün sayısı
  totalQty: number; // toplam adet
}

export function computeOrderProfit(
  order: UnifiedOrder,
  productMap: Map<string, ProductDetail>,
  rules: Rules,
  settings: Record<string, string>
): OrderProfit {
  const vatRate = Number(settings.vatRate ?? 0);
  let profit = 0;
  let matched = 0;
  let unknown = false;
  let totalQty = 0;
  let image: string | null = null;

  for (const line of order.items) {
    totalQty += line.quantity;
    const p = matchLine(line.matchKeys, productMap);
    if (p && !image) image = p.imageUrl;
    if (!p) {
      unknown = true;
      continue;
    }
    const resolved = resolveProductCost(
      p.cost ? { ...p.cost, tapeUsed: !!p.cost.tapeUsed } : null,
      settings,
      p.cost?.costPerGram ?? 0
    );
    if (!resolved || resolved.productionCost <= 0) {
      unknown = true;
      continue;
    }
    const listing = p.listings.find((l) => l.platform === order.platform);
    const sim = simulatePrice({
      salePrice: line.unitPrice || listing?.salePrice || p.currentSalePrice,
      productCost: resolved.productionCost,
      packagingCost: resolved.packagingCost,
      categoryName: p.categoryName,
      desi: p.desi ?? 1,
      commissionRules: withProductCommissionRule(p, rules.commission),
      cargoRules: filterCargoRulesByPlatform(rules.cargo, order.platform),
      expenseRules: filterRulesByPlatform(rules.expense, order.platform),
      vatRate,
      ...(listing
        ? resolveListingCommissionOverride(listing, settings)
        : order.platform === "shopify"
          ? { commissionRateOverride: Number(settings.shopifyCommissionRate ?? 3.2) / 100 }
          : {}),
      cargoCostOverride: listing?.cargoCost ?? undefined,
    });
    profit += sim.netProfit * line.quantity;
    matched++;
  }

  const distinctCount = order.items.length;
  return {
    revenue: order.total,
    profit: matched === 0 ? null : profit,
    partial: unknown,
    image: distinctCount === 1 ? image : null,
    distinctCount,
    totalQty,
  };
}
