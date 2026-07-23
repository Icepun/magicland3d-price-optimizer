import { resolveProductCost } from "@core/product-cost";
import { computeOrderProfit as computeCore, type OrderProfitLine } from "@core/order-profit";

import type { ProductDetail } from "@/lib/db/product-detail";
import type { Rules } from "@/lib/profit";
import type { UnifiedOrder } from "@/lib/api/orders";

export interface MatchedProduct {
  imageUrl: string | null;
  name: string;
  detail: ProductDetail;
}

/** Türkçe-duyarlı ad normalizasyonu (masaüstü orders route normName ile birebir). */
const normName = (s: string | null | undefined) =>
  (s ?? "").toLocaleLowerCase("tr-TR").replace(/\s+/g, " ").trim();

export interface ProductMap {
  byKey: Map<string, ProductDetail>;
  /** Shopify ad-eşleştirme (Shopify barkod tutmaz): normalize ad → ürün; aynı ad çoklu ürün → null (belirsiz). */
  byName: Map<string, ProductDetail | null>;
}

/** Ürün dizisi kimliğine göre harita önbelleği: aynı react-query dizi referansı için harita BİR KEZ
 *  kurulur (Panel + Siparişler + Raporlar + detay aynı ["match-products"] dizisini paylaşır —
 *  eskiden her ekran 424 ürün × ~5 Map insert'i ayrı ayrı tekrarlıyordu). */
const pmCache = new WeakMap<ProductDetail[], ProductMap>();
export function getProductMap(products: ProductDetail[]): ProductMap {
  let pm = pmCache.get(products);
  if (!pm) {
    pm = buildProductMap(products);
    pmCache.set(products, pm);
  }
  return pm;
}

/** Çok-anahtarlı ürün haritası: Product.barcode/sku + Listing.externalId/externalSku → ürün,
 *  + Shopify için ada göre eşleştirme (masaüstü orders route ile birebir). */
export function buildProductMap(products: ProductDetail[]): ProductMap {
  const byKey = new Map<string, ProductDetail>();
  const byName = new Map<string, ProductDetail | null>();
  const add = (k: string | null | undefined, p: ProductDetail) => {
    if (k && !byKey.has(k)) byKey.set(k, p);
  };
  for (const p of products) {
    add(p.barcode, p);
    add(p.sku, p);
    for (const l of p.listings) {
      add(l.externalId, p);
      add(l.externalSku, p);
      add(l.barcode, p); // platform-bazlı listing barkodu (Trendyol/HB barkodu) — masaüstü byKey ile birebir
    }
    const nk = normName(p.name);
    if (nk) byName.set(nk, byName.has(nk) ? null : p);
  }
  return { byKey, byName };
}

/** Bir sipariş satırını aday anahtarlarıyla ürüne eşle. */
function matchLine(
  keys: string[] | undefined,
  byKey: Map<string, ProductDetail>
): ProductDetail | undefined {
  for (const k of keys ?? []) {
    const p = byKey.get(k);
    if (p) return p;
  }
  return undefined;
}
export { matchLine };

/** Satır eşleştirme (anahtar + Shopify ad-fallback) — computeOrderProfit ile AYNI mantık.
 *  Sipariş detay ekranı da bunu kullansın ki "kâr hesaplandı ama satır eşleşmedi" çelişkisi olmasın. */
export function matchOrderLine(
  line: { matchKeys?: string[]; name: string },
  platform: UnifiedOrder["platform"],
  pm: ProductMap
): ProductDetail | undefined {
  let p = matchLine(line.matchKeys, pm.byKey);
  if (!p && platform === "shopify") {
    const named = pm.byName.get(normName(line.name));
    if (named) p = named;
  }
  return p;
}

export interface OrderProfit {
  revenue: number;
  profit: number | null; // null = hiç eşleşme/maliyet yok
  partial: boolean; // bazı satırlar eşleşmedi
  /** kapak görseli: tek farklı ürün varsa onun fotosu */
  image: string | null;
  distinctCount: number; // farklı ürün sayısı
  totalQty: number; // toplam adet
  /** Maliyeti bilinmeyen satırların cirosu — kâra girmedi (uyarı için). */
  unmatchedRevenue: number;
  missingDesiCount: number;
  desiEstimated: boolean;
  orderRevenueAdjustment: number;
}

export function computeOrderProfit(
  order: UnifiedOrder,
  pm: ProductMap,
  rules: Rules,
  settings: Record<string, string>
): OrderProfit {
  // Kâr hesabının TAMAMI @core/order-profit'te — masaüstü /api/orders ile AYNI fonksiyon.
  // (Eski mobil kopya: listing komisyonunu uygulamıyordu + sabit gideri adet başına tekrar
  //  kesiyordu → telefondaki kârlar masaüstünden şişik çıkıyordu.)
  let image: string | null = null;
  const lines: OrderProfitLine[] = order.items.map((line) => {
    const p = matchOrderLine(line, order.platform, pm);
    if (p && !image) image = p.imageUrl;
    const resolved = p
      ? resolveProductCost(
          p.cost ? { ...p.cost, tapeUsed: !!p.cost.tapeUsed } : null,
          settings,
          p.cost?.costPerGram ?? 0
        )
      : null;
    return {
      unitPrice: line.unitPrice,
      quantity: line.quantity,
      product:
        p && resolved
          ? {
              id: p.id,
              name: p.name,
              categoryName: p.categoryName,
              desi: p.desi,
              commissionRate: p.commissionRate,
              productionCost: resolved.productionCost,
              packagingCost: resolved.packagingCost,
              packagingComponents: resolved.packagingBreakdown?.components ?? null,
              filamentCost: resolved.filamentCost,
              listing: p.listings.find((l) => l.platform === order.platform) ?? null,
            }
          : null,
    };
  });

  const r = computeCore({
    platform: order.platform,
    orderTotal: order.total,
    lines,
    commissionRules: rules.commission,
    cargoRules: rules.cargo,
    expenseRules: rules.expense,
    settings,
  });

  const distinctCount = order.items.length;
  return {
    revenue: order.total,
    profit: r.profit,
    partial: r.partial || !!order.financialPartial,
    image: distinctCount === 1 ? image : null,
    distinctCount,
    totalQty: r.totalQty,
    unmatchedRevenue: r.unmatchedRevenue,
    missingDesiCount: r.missingDesiLines,
    desiEstimated: r.desiEstimated,
    orderRevenueAdjustment: r.orderRevenueAdjustment,
  };
}
