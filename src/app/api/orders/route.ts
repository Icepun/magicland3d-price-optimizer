import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import {
  ShopifyClient,
  ShopifyAdminTokenMissingError,
} from "@/services/shopify-client";
import { getShopifyCredentials } from "@/services/shopify-settings";
import { TrendyolClient } from "@/services/trendyol-client";
import { getTrendyolCredentials } from "@/services/trendyol-settings";
import { simulatePrice } from "@/core/pricing-engine";
import { resolveProductCost } from "@/core/product-cost";
import { withProductCommissionRule } from "@/core/product-commission";
import { filterCargoRulesByPlatform, filterRulesByPlatform } from "@/core/cargo-calculator";

const WINDOW_DAYS = 30;

export type OrderStatusKind =
  | "pending"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "other";

export interface UnifiedOrderItem {
  name: string;
  quantity: number;
  image: string | null;
}

export interface UnifiedOrder {
  platform: "shopify" | "trendyol";
  id: string;
  orderNumber: string;
  date: string | null;
  statusKind: OrderStatusKind;
  statusLabel: string;
  total: number;
  currency: string;
  customer: string | null;
  itemCount: number;
  items: UnifiedOrderItem[];
  image: string | null;
  profit: number | null;
  profitPartial: boolean;
  trackingNumber: string | null;
  cargoProvider: string | null;
}

interface PlatformStatus {
  ok: boolean;
  count: number;
  needsAdminToken?: boolean;
  notConfigured?: boolean;
  error?: string;
}

interface SummaryBucket {
  revenue: number;
  profit: number;
  orderCount: number;
}

const TRENDYOL_STATUS: Record<string, { kind: OrderStatusKind; label: string }> = {
  Created: { kind: "pending", label: "Yeni Sipariş" },
  Awaiting: { kind: "pending", label: "Onay Bekliyor" },
  Picking: { kind: "processing", label: "Hazırlanıyor" },
  Invoiced: { kind: "processing", label: "Faturalandı" },
  Shipped: { kind: "shipped", label: "Kargoda" },
  AtCollectionPoint: { kind: "shipped", label: "Teslim Noktasında" },
  Delivered: { kind: "delivered", label: "Teslim Edildi" },
  Cancelled: { kind: "cancelled", label: "İptal" },
  UnDelivered: { kind: "cancelled", label: "Teslim Edilemedi" },
  UnPacked: { kind: "cancelled", label: "Paket Bölündü" },
  Returned: { kind: "cancelled", label: "İade" },
  UnSupplied: { kind: "cancelled", label: "Tedarik Edilemedi" },
};

function trendyolStatus(s?: string): { kind: OrderStatusKind; label: string } {
  if (s && TRENDYOL_STATUS[s]) return TRENDYOL_STATUS[s];
  return { kind: "other", label: s || "Bilinmiyor" };
}

function shopifyStatus(
  fulfillment: string | null,
  financial: string | null,
  cancelled: boolean
): { kind: OrderStatusKind; label: string } {
  if (cancelled) return { kind: "cancelled", label: "İptal" };
  const f = (fulfillment || "").toUpperCase();
  if (f === "FULFILLED") return { kind: "shipped", label: "Gönderildi" };
  if (f === "PARTIALLY_FULFILLED") return { kind: "processing", label: "Kısmi Gönderim" };
  if (f === "IN_PROGRESS" || f === "SCHEDULED") return { kind: "processing", label: "Hazırlanıyor" };
  const fin = (financial || "").toUpperCase();
  if (fin === "REFUNDED" || fin === "PARTIALLY_REFUNDED") return { kind: "cancelled", label: "İade" };
  if (fin === "PENDING" || fin === "AUTHORIZED") return { kind: "pending", label: "Ödeme Bekliyor" };
  return { kind: "pending", label: "Hazırlanmadı" };
}

interface Matched {
  id: string;
  name: string;
  imageUrl: string | null;
  productionCost: number;
  packagingCost: number;
  categoryName: string;
  desi: number | null;
  commissionRate: number | null;
}

type CommissionRules = Parameters<typeof simulatePrice>[0]["commissionRules"];
type CargoRules = Parameters<typeof simulatePrice>[0]["cargoRules"];
type ExpenseRules = Parameters<typeof simulatePrice>[0]["expenseRules"];

export async function GET() {
  await ensureRuntimeSchema();

  const cutoff = Date.now() - WINDOW_DAYS * 86_400_000;
  const orders: UnifiedOrder[] = [];
  let shopify: PlatformStatus = { ok: false, count: 0 };
  let trendyol: PlatformStatus = { ok: false, count: 0 };

  // Ham siparişleri çek (her platform bağımsız) ──────────────────────────────
  type RawLine = { name: string; quantity: number; unitPrice: number; image: string | null; matchKeys: string[] };
  type Raw = {
    platform: "shopify" | "trendyol";
    id: string;
    orderNumber: string;
    date: string | null;
    statusKind: OrderStatusKind;
    statusLabel: string;
    total: number;
    currency: string;
    customer: string | null;
    lines: RawLine[];
    trackingNumber: string | null;
    cargoProvider: string | null;
  };
  const raws: Raw[] = [];

  try {
    const client = new ShopifyClient(await getShopifyCredentials());
    const list = await client.listOrders({ sinceDays: WINDOW_DAYS, limit: 100 });
    for (const o of list) {
      const st = shopifyStatus(o.fulfillmentStatus, o.financialStatus, Boolean(o.cancelledAt));
      raws.push({
        platform: "shopify",
        id: o.id || `shopify-${o.name}`,
        orderNumber: o.name,
        date: o.createdAt ?? null,
        statusKind: st.kind,
        statusLabel: st.label,
        total: o.totalAmount,
        currency: o.currency,
        customer: o.customerName,
        lines: o.lines.map((l) => ({
          name: l.title,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          image: l.image,
          // Çok-anahtarlı eşleştirme: variant barcode/sku, satır sku, variant id (Listing.externalId)
          matchKeys: [
            l.barcode,
            l.variantSku,
            l.sku,
            l.variantId,
            l.variantId ? `shopify-variant-${l.variantId}` : null,
          ].filter((k): k is string => !!k),
        })),
        trackingNumber: o.trackingNumber,
        cargoProvider: o.cargoProvider,
      });
    }
    shopify = { ok: true, count: list.length };
  } catch (e) {
    if (e instanceof ShopifyAdminTokenMissingError) {
      shopify = { ok: false, count: 0, needsAdminToken: true };
    } else {
      const msg = e instanceof Error ? e.message : "Shopify siparişleri alınamadı";
      shopify = { ok: false, count: 0, notConfigured: /eksik|bulunamadı/i.test(msg), error: msg };
    }
  }

  try {
    const client = new TrendyolClient(await getTrendyolCredentials());
    const page = await client.listOrders({ size: 100 });
    for (const [i, o] of (page.content ?? []).entries()) {
      const st = trendyolStatus(o.status);
      raws.push({
        platform: "trendyol",
        id: `ty-${o.orderNumber ?? o.id ?? i}`,
        orderNumber: String(o.orderNumber ?? o.id ?? "—"),
        date: o.orderDate ? new Date(o.orderDate).toISOString() : null,
        statusKind: st.kind,
        statusLabel: st.label,
        total: Number(o.totalPrice ?? o.grossAmount ?? 0),
        currency: "TRY",
        customer: [o.customerFirstName, o.customerLastName].filter(Boolean).join(" ") || null,
        lines: (o.lines ?? []).map((l) => ({
          name: l.productName ?? l.barcode ?? "Ürün",
          quantity: Number(l.quantity ?? 1),
          unitPrice: Number(l.price ?? 0),
          image: null,
          // Trendyol order satırı barcode verir ("merchantSku" literal'i çöp → ele)
          matchKeys: [l.barcode, l.sku, l.merchantSku].filter(
            (k): k is string => !!k && k !== "merchantSku"
          ),
        })),
        trackingNumber: o.cargoTrackingNumber ? String(o.cargoTrackingNumber) : null,
        cargoProvider: o.cargoProviderName ?? null,
      });
    }
    trendyol = { ok: true, count: page.content?.length ?? 0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Trendyol siparişleri alınamadı";
    trendyol = { ok: false, count: 0, notConfigured: /eksik|bulunamadı/i.test(msg), error: msg };
  }

  // Son 30 güne filtrele (tarihsiz olanları da tut)
  const recent = raws.filter((r) => !r.date || new Date(r.date).getTime() >= cutoff);

  // Sipariş satırlarını ÜRÜNLERİMİZLE eşleştir → görsel + maliyet + kâr ──────────
  const allKeys = new Set<string>();
  for (const r of recent) {
    for (const l of r.lines) {
      for (const k of l.matchKeys) allKeys.add(k);
    }
  }

  // Tek harita: Product.barcode/sku + Listing.externalId/externalSku → ürün
  const byKey = new Map<string, Matched>();
  let commissionRules: CommissionRules = [];
  let cargoRules: CargoRules = [];
  let expenseRules: ExpenseRules = [];
  let vatRate = 0;

  if (allKeys.size > 0) {
    const keyList = [...allKeys];
    const [products, cRules, kRules, eRules, settings] = await Promise.all([
      prisma.product.findMany({
        where: {
          OR: [
            { barcode: { in: keyList } },
            { sku: { in: keyList } },
            { listings: { some: { externalId: { in: keyList } } } },
            { listings: { some: { externalSku: { in: keyList } } } },
          ],
        },
        include: { cost: { include: { filamentType: true } }, listings: true },
      }),
      prisma.commissionRule.findMany({ where: { isActive: true } }),
      prisma.cargoRule.findMany({ where: { isActive: true } }),
      prisma.expenseRule.findMany({ where: { isActive: true } }),
      prisma.appSetting.findMany(),
    ]);

    const settingsMap = Object.fromEntries(settings.map((s) => [s.key, s.value]));
    vatRate = Number(settingsMap.vatRate ?? 0);
    commissionRules = cRules as CommissionRules;
    cargoRules = kRules as CargoRules;
    expenseRules = eRules as ExpenseRules;

    for (const p of products) {
      const resolved = resolveProductCost(p.cost, settingsMap, p.cost?.filamentType?.costPerGram ?? 0);
      const m: Matched = {
        id: p.id,
        name: p.name,
        imageUrl: p.imageUrl,
        productionCost: resolved?.productionCost ?? 0,
        packagingCost: resolved?.packagingCost ?? 0,
        categoryName: p.categoryName,
        desi: p.desi,
        commissionRate: p.commissionRate,
      };
      const add = (k: string | null | undefined) => {
        if (k && !byKey.has(k)) byKey.set(k, m);
      };
      add(p.barcode);
      add(p.sku);
      for (const l of p.listings) {
        add(l.externalId);
        add(l.externalSku);
      }
    }
  }

  function profitFor(platform: "shopify" | "trendyol", m: Matched, unitPrice: number, qty: number): number | null {
    if (m.productionCost + m.packagingCost <= 0 || unitPrice <= 0) return null;
    const sim = simulatePrice({
      salePrice: unitPrice,
      productCost: m.productionCost,
      packagingCost: m.packagingCost,
      categoryName: m.categoryName,
      desi: m.desi ?? 1,
      commissionRules: withProductCommissionRule(
        { id: m.id, name: m.name, categoryName: m.categoryName, commissionRate: m.commissionRate },
        commissionRules
      ),
      cargoRules: filterCargoRulesByPlatform(cargoRules, platform),
      expenseRules: filterRulesByPlatform(expenseRules, platform),
      vatRate,
    });
    return sim.netProfit * qty;
  }

  // Zenginleştirilmiş birleşik siparişler ───────────────────────────────────
  for (const r of recent) {
    let orderProfit = 0;
    let anyProfit = false;
    let anyUnmatched = false;
    let thumb: string | null = null;

    const items: UnifiedOrderItem[] = r.lines.map((l) => {
      let m: Matched | null = null;
      for (const k of l.matchKeys) {
        const hit = byKey.get(k);
        if (hit) {
          m = hit;
          break;
        }
      }
      const image = l.image || m?.imageUrl || null;
      if (image && !thumb) thumb = image;

      if (m) {
        const p = profitFor(r.platform, m, l.unitPrice, l.quantity);
        if (p !== null) {
          orderProfit += p;
          anyProfit = true;
        } else {
          anyUnmatched = true;
        }
      } else {
        anyUnmatched = true;
      }
      return { name: l.name, quantity: l.quantity, image };
    });

    orders.push({
      platform: r.platform,
      id: r.id,
      orderNumber: r.orderNumber,
      date: r.date,
      statusKind: r.statusKind,
      statusLabel: r.statusLabel,
      total: r.total,
      currency: r.currency,
      customer: r.customer,
      itemCount: items.reduce((s, it) => s + it.quantity, 0),
      items,
      image: thumb,
      profit: anyProfit ? orderProfit : null,
      profitPartial: anyProfit && anyUnmatched,
      trackingNumber: r.trackingNumber,
      cargoProvider: r.cargoProvider,
    });
  }

  // En yeni üstte
  orders.sort((a, b) => {
    const ta = a.date ? new Date(a.date).getTime() : 0;
    const tb = b.date ? new Date(b.date).getTime() : 0;
    return tb - ta;
  });

  // Dashboard özeti (iptal/iade hariç) ──────────────────────────────────────
  const empty = (): SummaryBucket => ({ revenue: 0, profit: 0, orderCount: 0 });
  const sShopify = empty();
  const sTrendyol = empty();
  for (const o of orders) {
    if (o.statusKind === "cancelled") continue;
    const bucket = o.platform === "shopify" ? sShopify : sTrendyol;
    bucket.revenue += o.total;
    bucket.profit += o.profit ?? 0;
    bucket.orderCount += 1;
  }
  const total: SummaryBucket = {
    revenue: sShopify.revenue + sTrendyol.revenue,
    profit: sShopify.profit + sTrendyol.profit,
    orderCount: sShopify.orderCount + sTrendyol.orderCount,
  };

  return NextResponse.json({
    orders,
    summary: { days: WINDOW_DAYS, shopify: sShopify, trendyol: sTrendyol, total },
    shopify,
    trendyol,
  });
}
