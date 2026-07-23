/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import {
  getOrdersCache,
  getOrdersCacheGeneration,
  setOrdersCache,
  isOrdersRefreshing,
  setOrdersRefreshing,
} from "@/lib/orders-cache";
import {
  ShopifyClient,
  ShopifyAdminTokenMissingError,
} from "@/services/shopify-client";
import { getShopifyCredentials } from "@/services/shopify-settings";
import { TrendyolClient } from "@/services/trendyol-client";
import { getTrendyolCredentials } from "@/services/trendyol-settings";
import { HepsiburadaClient } from "@/services/hepsiburada-client";
import { getHepsiburadaCredentials } from "@/services/hepsiburada-settings";
import { resolveProductCost } from "@/core/product-cost";
import { computeOrderProfit, type OrderProfitLine } from "@/core/order-profit";
import type { CommissionRuleInput, CargoRuleInput, ExpenseRuleInput } from "@/core/types";
import type { PackagingBreakdown } from "@/core/packaging";
import { pushToAllDevices } from "@/lib/push-notify";
import { persistOrderFinanceSnapshots } from "@/lib/order-finance-snapshots";
import {
  parseManualOrderBreakdown,
  parseManualOrderItems,
} from "@/lib/manual-orders";
import { kurusToTl } from "@/lib/monthly-finance";

const WINDOW_DAYS = 30;
// Aylık geçmişte geç gelen iptal/iade durumlarını yakalamak için görünür listenin
// arkasında daha geniş bir pencereyi yeniden hesaplarız. Shopify'ın standart
// read_orders erişimi son 60 günle sınırlı olduğundan güvenli ortak sınır 60 gündür.
const HISTORY_SYNC_DAYS = 60;

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
  /** Eşleşen ürünün id'si (varsa) — siparişler sayfasından ürün detayına gitmek için. */
  productId?: string | null;
  /** Bu ürün "sipariş üzerine üretilir" mi (bildirim/etiket için). */
  madeToOrder?: boolean;
}

export interface UnifiedOrder {
  platform: "shopify" | "trendyol" | "hepsiburada" | "manual";
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
  /** Maliyeti bilinmediği için kâra girmeyen satır sayısı (0 = tam hesap). */
  unmatchedCount?: number;
  /** Desisi olmadığı için kargosu 1 desi varsayılan satır sayısı. */
  missingDesiCount?: number;
  desiEstimated?: boolean;
  orderRevenueAdjustment?: number;
  trackingNumber: string | null;
  cargoProvider: string | null;
  isManual?: boolean;
  manualOrderId?: string;
  editHref?: string;
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
  /** Kârı eksik hesaplanan sipariş sayısı (maliyet girilmemiş ürün içeren). */
  incompleteOrders: number;
}

interface SummaryQuality {
  /** Döviz kuru dönüşümü olmadığı için TRY ciro/kâr toplamlarına katılmayan siparişler. */
  unsupportedCurrencyOrders: number;
  unsupportedCurrencies: Array<{ currency: string; orderCount: number }>;
}

function normalizedCurrency(currency: string | null | undefined): string {
  return currency?.trim().toUpperCase() || "TRY";
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

// ── Hepsiburada yardımcıları (yanıt şekli Test'le doğrulanana dek defansif) ──
const HB_STATUS: Record<string, { kind: OrderStatusKind; label: string }> = {
  Open: { kind: "pending", label: "Yeni Sipariş" },
  New: { kind: "pending", label: "Yeni Sipariş" },
  Packaged: { kind: "processing", label: "Paketlendi" },
  ReadyToShip: { kind: "processing", label: "Kargoya Hazır" },
  Shipped: { kind: "shipped", label: "Kargoda" },
  InTransit: { kind: "shipped", label: "Yolda" },
  Delivered: { kind: "delivered", label: "Teslim Edildi" },
  UnDelivered: { kind: "cancelled", label: "Teslim Edilemedi" },
  Cancelled: { kind: "cancelled", label: "İptal" },
  CancelledByMerchant: { kind: "cancelled", label: "İptal (Satıcı)" },
  CancelledByCustomer: { kind: "cancelled", label: "İptal (Müşteri)" },
  Returned: { kind: "cancelled", label: "İade" },
};
function hbStatus(s: string): { kind: OrderStatusKind; label: string } {
  return HB_STATUS[s] ?? { kind: "other", label: s || "Bilinmiyor" };
}
function hbNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "amount" in (v as Record<string, unknown>)) {
    return Number((v as { amount?: unknown }).amount) || 0;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function hbStr(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
}
function hbArray(o: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(o)) return o as Record<string, unknown>[];
  if (!o || typeof o !== "object") return [];
  const r = o as Record<string, unknown>;
  for (const k of keys) {
    if (Array.isArray(r[k])) return r[k] as Record<string, unknown>[];
  }
  return [];
}
function hbDate(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (v == null || v === "") continue;
    const d = new Date(typeof v === "number" ? v : String(v));
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}
/** HB sipariş/detay kalemi → RawLine şekli (tutar + eşleştirme anahtarları). */
function hbLineRaw(li: Record<string, any>): { name: string; quantity: number; unitPrice: number; image: string | null; matchKeys: string[] } {
  const qty = Math.max(1, Math.floor(hbNum(li.quantity ?? li.amount ?? 1)));
  const unit = hbNum(li.unitPrice ?? li.price) || (hbNum(li.totalPrice) / qty);
  return {
    name: hbStr(li.productName, li.name, li.title, li.barcode, li.merchantSku) || "Ürün",
    quantity: qty,
    unitPrice: unit,
    image: null,
    matchKeys: [li.merchantSku, li.hbSku, li.sku, li.barcode, li.stockCode, li.hepsiburadaSku].filter((k): k is string => typeof k === "string" && !!k),
  };
}
/** items'i en çok `limit` eşzamanlı çalışan worker ile işle (orders route'u kilitlemeden detay çek). */
async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const idx = i++; await fn(items[idx]); }
    })
  );
}

function shopifyStatus(
  fulfillment: string | null,
  financial: string | null,
  cancelled: boolean
): { kind: OrderStatusKind; label: string } {
  if (cancelled) return { kind: "cancelled", label: "İptal" };
  // Tam iade fulfillment'tan önce değerlendirilir ve ciro/kâra girmez. Kısmi iade ise
  // currentTotalPriceSet ile kalan geliri kullanır; satır/restock ayrıntısı eksik olduğundan
  // aşağıda kârı "kısmi" işaretlenir.
  const fin = (financial || "").toUpperCase();
  if (fin === "REFUNDED") return { kind: "cancelled", label: "İade" };
  const f = (fulfillment || "").toUpperCase();
  if (f === "FULFILLED") return { kind: "shipped", label: "Gönderildi" };
  if (f === "PARTIALLY_FULFILLED") return { kind: "processing", label: "Kısmi Gönderim" };
  if (f === "IN_PROGRESS" || f === "SCHEDULED") return { kind: "processing", label: "Hazırlanıyor" };
  if (fin === "PENDING" || fin === "AUTHORIZED") return { kind: "pending", label: "Ödeme Bekliyor" };
  return { kind: "pending", label: "Hazırlanmadı" };
}

interface Matched {
  id: string;
  name: string;
  imageUrl: string | null;
  productionCost: number;
  packagingCost: number;
  packagingComponents: PackagingBreakdown["components"] | null;
  filamentCost: number; // KDV iadesine giren malzeme payı
  categoryName: string;
  desi: number | null;
  commissionRate: number | null;
  madeToOrder: boolean;
  stock: number;
  /** Platform bazlı listing override'ları (komisyon + ELLE girilen kargo) — Ürünler/Panel ile AYNI kaynak. */
  listingByPlatform: Record<string, { platform: string; commissionRate: number | null; commissionFixed: number | null; cargoCost: number | null }>;
}

type CommissionRules = CommissionRuleInput[];
type CargoRules = CargoRuleInput[];
type ExpenseRules = ExpenseRuleInput[];

// ── Sunucu önbelleği (stale-while-revalidate) ──────────────────────────────────────────────
// Siparişler 3 pazaryerinden CANLI çekiliyor (1-3sn). İlk yüklemeden SONRA her açış önbellekten
// ANINDA döner; 60sn'den eskiyse arka planda tazelenir (eski veri anında gösterilir → sayfa beklemez).
// "Yenile" (?fresh=1) senkron canlı çeker. Önbellek PAYLAŞILAN modülde (lib/orders-cache) — kargo/
// komisyon/gider değişince invalidateOrdersCache() ile düşürülür → kâr anında güncellenir.
const ORDERS_SOFT_MS = 60_000;

export async function GET(req: NextRequest) {
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  const cached = getOrdersCache();
  if (!fresh && cached) {
    if (Date.now() - cached.at > ORDERS_SOFT_MS && !isOrdersRefreshing()) {
      const generation = getOrdersCacheGeneration();
      setOrdersRefreshing(true);
      void computeOrdersBody()
        .then((b) => { setOrdersCache(b, generation); })
        .catch(() => {})
        .finally(() => { setOrdersRefreshing(false); });
    }
    return NextResponse.json(cached.body);
  }
  const generation = getOrdersCacheGeneration();
  const body = await computeOrdersBody();
  setOrdersCache(body, generation);
  return NextResponse.json(body);
}

async function computeOrdersBody(): Promise<Record<string, unknown>> {
  await ensureRuntimeSchema();

  // Gün başına sabitlenmiş cutoff — mobil (mobile/src/lib/api/window.ts orderWindowCutoff) ile
  // BİREBİR aynı formül. İki uygulama da aynı UTC günü boyunca aynı değeri üretir → sipariş
  // sayısı/ciro/kâr ne zaman yenilenirse yenilensin eşleşir (kayan saniye sınırı yok).
  const cutoff = (Math.floor(Date.now() / 86_400_000) - WINDOW_DAYS) * 86_400_000;
  const historyCutoff =
    (Math.floor(Date.now() / 86_400_000) - HISTORY_SYNC_DAYS) * 86_400_000;
  const orders: UnifiedOrder[] = [];
  const manualOrdersPromise = prisma.manualOrder.findMany({
    where: { orderedAt: { gte: new Date(historyCutoff) } },
    orderBy: { orderedAt: "desc" },
  });
  let shopify: PlatformStatus = { ok: false, count: 0 };
  let trendyol: PlatformStatus = { ok: false, count: 0 };
  let hepsiburada: PlatformStatus = { ok: false, count: 0 };

  // Ham siparişleri çek (her platform bağımsız) ──────────────────────────────
  type RawLine = { name: string; quantity: number; unitPrice: number; image: string | null; matchKeys: string[] };
  type Raw = {
    platform: "shopify" | "trendyol" | "hepsiburada";
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
    /** Kısmi iade veya API satır sınırı nedeniyle hesaplanan kâr kesin değildir. */
    forceProfitPartial?: boolean;
  };
  const raws: Raw[] = [];

  // Üç platformu PARALEL çek — toplam gecikme = en yavaş tek platform (sıralı toplam DEĞİL).
  // Bloklar bağımsız: her biri kendi raws'ını push'lar + kendi durum değişkenini atar (yarış yok).
  await Promise.all([
   (async () => {
   try {
    const client = new ShopifyClient(await getShopifyCredentials());
    // +1 gün: gün-başı historyCutoff'tan biraz daha geniş çek (superset); aşağıdaki
    // historyRows filtresi tam kırpar. Shopify created_at = orderDate.
    const list = await client.listOrders({ sinceDays: HISTORY_SYNC_DAYS + 1, limit: 100 });
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
        forceProfitPartial:
          o.linesTruncated ||
          (o.financialStatus || "").toUpperCase() === "PARTIALLY_REFUNDED",
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
   })(),
   (async () => {
   try {
    const client = new TrendyolClient(await getTrendyolCredentials());
    // Trendyol /orders (shipmentPackages): statü filtresi YOK → TÜM statüler (oluşturuldu/kargoda/
    // teslim/iptal) gelir. Ama tek sayfa size:100 son-100'le sınırlıydı → 30 günde 100+ sipariş varsa
    // eksik çekiyordu (kâr yanlış). Çözüm: son 30 günü 14 GÜNLÜK pencerelerle (Trendyol startDate/endDate
    // aralık limiti ≤2 hafta) tara + her pencerede sayfala. (Route ayrıca orderDate'e göre 30 güne kırpar.)
    const CHUNK = 14 * 86_400_000;
    const seenTy = new Set<string>();
    let tyCount = 0;
    for (let chunkEnd = Date.now(); chunkEnd > historyCutoff; chunkEnd -= CHUNK) {
      const chunkStart = Math.max(historyCutoff, chunkEnd - CHUNK);
      for (let pageNo = 0; pageNo < 50; pageNo++) {
        const page = await client.listOrders({ page: pageNo, size: 100, startDate: chunkStart, endDate: chunkEnd });
        const content = page.content ?? [];
        for (const [i, o] of content.entries()) {
          const key = String(o.id ?? o.orderNumber ?? `${chunkEnd}-${pageNo}-${i}`);
          if (seenTy.has(key)) continue; // pencere sınırı çakışması olursa çift sayma
          seenTy.add(key);
          const st = trendyolStatus(o.status);
          raws.push({
            platform: "trendyol",
            id: `ty-${o.id ?? o.orderNumber ?? key}`,
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
          tyCount++;
        }
        if (content.length < 100) break; // son sayfa
      }
    }
    trendyol = { ok: true, count: tyCount };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Trendyol siparişleri alınamadı";
    trendyol = { ok: false, count: 0, notConfigured: /eksik|bulunamadı/i.test(msg), error: msg };
  }
   })(),
   (async () => {
   try {
    const client = new HepsiburadaClient(await getHepsiburadaCredentials());
    // HB siparişleri TEK uçta gelmez: /orders sadece "Open" (paketlenecek) verir; kargoda/teslim
    // siparişler /packages/.../{shipped|delivered|undelivered} ÖZETLERİNDE (tutar YOK) → detay ayrı çekilir.
    type HbAgg = { status: string; date: string | null; customer: string | null; lines: RawLine[] | null };
    const agg = new Map<string, HbAgg>();

    // a) Open siparişler — /orders FLAT kalem listesi (orderNumber tekrar eder) → orderNumber'a göre grupla.
    const openRes = await client.listOrders({ limit: 100 });
    for (const li of hbArray(openRes, ["items", "orders", "data", "content", "result"]) as Record<string, any>[]) {
      const on = hbStr(li.orderNumber, li.orderId, li.id);
      if (!on) continue;
      let e = agg.get(on);
      if (!e) {
        e = { status: hbStr(li.status) || "Open", date: hbDate(li.orderDate, li.createdDate), customer: hbStr(li.customerName) || null, lines: [] };
        agg.set(on, e);
      }
      (e.lines as RawLine[]).push(hbLineRaw(li));
    }

    // b) Paket özetleri (paketlenmiş / kargoda / teslim / teslim-edilemedi) — OrderNumber + tarih topla.
    const pkgStatuses: Array<["" | "shipped" | "delivered" | "undelivered", string]> =
      [["", "Packaged"], ["shipped", "Shipped"], ["delivered", "Delivered"], ["undelivered", "UnDelivered"]];
    const pkgResults = await Promise.all(
      pkgStatuses.map(async ([s]) => {
        const items: Record<string, any>[] = [];
        for (let off = 0; off < 3000; off += 100) {
          const arr = hbArray(await client.listPackages(s, { offset: off, limit: 100 }), ["items", "data", "content", "result"]);
          if (!arr.length) break;
          items.push(...(arr as Record<string, any>[]));
          if (arr.length < 100) break;
        }
        return items;
      })
    );
    for (const [idx, pkgs] of pkgResults.entries()) {
      const [statusCode, label] = pkgStatuses[idx];
      // Statüsüz /packages ucu = paketlenecek/gönderime-hazır/kargoda (status "Open" vb.). Bu uç
      // OrderNumber YERİNE packageNumber/id kullanır VE kalem+tutarı `items` içinde TAM verir →
      // ayrı bir status'a göre değil, doğrudan tam sipariş olarak işlenir (detay fetch GEREKMEZ).
      const isFullOrder = statusCode === "";
      for (const p of pkgs) {
        if (isFullOrder) {
          const key = hbStr(p.packageNumber, p.id, p.OrderNumber, p.orderNumber);
          if (!key || agg.has(key)) continue;
          agg.set(key, {
            status: hbStr(p.status) || label,
            date: hbDate(p.orderDate, p.CreatedDate, p.PackageReadyDate),
            customer: hbStr(p.recipientName, p.customerName) || null,
            lines: (hbArray(p, ["items", "lines", "orderItems"]) as Record<string, any>[]).map(hbLineRaw),
          });
        } else {
          const on = hbStr(p.OrderNumber, p.orderNumber, Array.isArray(p.OrderNumbers) ? p.OrderNumbers[0] : "");
          if (!on || agg.has(on)) continue;
          agg.set(on, { status: label, date: hbDate(p.DeliveredDate, p.ShippedDate, p.UndeliveredDate, p.CreatedDate, p.orderDate, p.PackageReadyDate), customer: null, lines: null });
        }
      }
    }

    // 30 güne filtrele (tarihsizleri tut) — detay çekmeden ÖNCE (gereksiz detay çağrısı olmasın).
    for (const [on, e] of [...agg]) {
      if (e.date && new Date(e.date).getTime() < historyCutoff) agg.delete(on);
    }

    // c) Tutarı olmayan (özetten gelen) siparişlerin kalem/tutar detayını PARALEL çek (concurrency 8, cap 250).
    const needDetail = [...agg.entries()].filter(([, e]) => e.lines === null).map(([on]) => on).slice(0, 250);
    await mapLimit(needDetail, 8, async (on) => {
      try {
        const d = (await client.getOrderDetail(on)) as Record<string, any>;
        const e = agg.get(on);
        if (!e) return;
        e.lines = (hbArray(d, ["items", "lineItems", "details", "lines", "orderItems"]) as Record<string, any>[]).map(hbLineRaw);
        e.customer = e.customer ?? (hbStr((d.customer ?? {}).name, d.customerName) || null);
        // Sipariş VERME tarihini tercih et (kargo/teslim tarihi değil) → liste + 30g penceresi hep
        // sipariş tarihine göre. Paketten gelen tarih (ShippedDate/DeliveredDate) bununla ezilir.
        const od = hbDate(d.orderDate, d.createdDate);
        if (od) e.date = od;
      } catch { /* detay alınamadı → o sipariş kalemsiz (kârsız) görünür, listede kalır */ }
    });

    // d) Birleşik raws.
    for (const [on, e] of agg) {
      const st = hbStatus(e.status);
      const lines = e.lines ?? [];
      raws.push({
        platform: "hepsiburada",
        id: `hb-${on}`,
        orderNumber: on,
        date: e.date,
        statusKind: st.kind,
        statusLabel: st.label,
        total: lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0),
        currency: "TRY",
        customer: e.customer,
        lines,
        trackingNumber: null,
        cargoProvider: null,
      });
    }
    hepsiburada = { ok: true, count: agg.size };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Hepsiburada siparişleri alınamadı";
    hepsiburada = { ok: false, count: 0, notConfigured: /eksik|bulunamadı/i.test(msg), error: msg };
  }
   })(),
  ]);

  // Finans geçmişi için son 60 günü yeniden değerlendir (tarihsiz olanları da tut).
  // Kullanıcıya dönen liste/özet aşağıda yine son 30 güne kırpılır.
  const historyRows = raws.filter(
    (r) => !r.date || new Date(r.date).getTime() >= historyCutoff
  );

  // Sipariş satırlarını ÜRÜNLERİMİZLE eşleştir → görsel + maliyet + kâr ──────────
  const allKeys = new Set<string>();
  const shopifyNames = new Set<string>(); // Shopify barkod tutmaz → ada göre eşleştirme
  for (const r of historyRows) {
    for (const l of r.lines) {
      for (const k of l.matchKeys) allKeys.add(k);
      if (r.platform === "shopify" && l.name) shopifyNames.add(l.name);
    }
  }

  // Tek harita: Product.barcode/sku + Listing.externalId/externalSku/barcode → ürün
  const byKey = new Map<string, Matched>();
  // Shopify ad-eşleştirme haritası (null = çakışma: aynı ad birden çok üründe → eşleştirme).
  const byName = new Map<string, Matched | null>();
  const normName = (s: string | null | undefined) =>
    (s ?? "").toLocaleLowerCase("tr-TR").replace(/\s+/g, " ").trim();
  let commissionRules: CommissionRules = [];
  let cargoRules: CargoRules = [];
  let expenseRules: ExpenseRules = [];
  // Shopify global komisyon oranı resolveListingCommissionOverride içinde buradan okunur → dış kapsam.
  let settingsMap: Record<string, string | undefined> = {};

  if (allKeys.size > 0 || shopifyNames.size > 0) {
    const keyList = [...allKeys];
    const normalizedShopifyNames = new Set([...shopifyNames].map(normName));
    // SQLite/Prisma `name IN (...)` ham büyük-küçük harf ve boşluk farklarını kaçırıyordu.
    // Önce yalnız id+ad tarayıp Türkçe-normalize eşleşen küçük id listesini çıkar.
    const nameMatchedIds =
      normalizedShopifyNames.size > 0
        ? (
            await prisma.product.findMany({
              select: { id: true, name: true },
            })
          )
            .filter((product) => normalizedShopifyNames.has(normName(product.name)))
            .map((product) => product.id)
        : [];
    const [products, cRules, kRules, eRules, settings] = await Promise.all([
      prisma.product.findMany({
        where: {
          OR: [
            { barcode: { in: keyList } },
            { sku: { in: keyList } },
            { listings: { some: { externalId: { in: keyList } } } },
            { listings: { some: { externalSku: { in: keyList } } } },
            { listings: { some: { barcode: { in: keyList } } } },
            { id: { in: nameMatchedIds } },
          ],
        },
        include: { cost: { include: { filamentType: { select: { costPerGram: true } } } }, listings: true },
      }),
      prisma.commissionRule.findMany({ where: { isActive: true } }),
      prisma.cargoRule.findMany({ where: { isActive: true } }),
      prisma.expenseRule.findMany({ where: { isActive: true } }),
      prisma.appSetting.findMany(),
    ]);

    settingsMap = Object.fromEntries(settings.map((s) => [s.key, s.value]));
    commissionRules = cRules as CommissionRules;
    cargoRules = kRules as CargoRules;
    expenseRules = eRules as ExpenseRules;

    for (const p of products) {
      const resolved = resolveProductCost(p.cost, settingsMap, p.cost?.filamentType?.costPerGram ?? 0);
      // Listing komisyon override'ı platform bazlı taşınır (Ürünler/Panel ile AYNI kaynak).
      const listingByPlatform: Matched["listingByPlatform"] = {};
      for (const l of p.listings) {
        listingByPlatform[l.platform] = {
          platform: l.platform,
          commissionRate: l.commissionRate,
          commissionFixed: l.commissionFixed,
          cargoCost: l.cargoCost, // elle girilen kargo — Ürünler bunu kullanıyordu, Siparişler yok sayıyordu
        };
      }
      const m: Matched = {
        id: p.id,
        name: p.name,
        imageUrl: p.imageUrl,
        productionCost: resolved?.productionCost ?? 0,
        packagingCost: resolved?.packagingCost ?? 0,
        packagingComponents: resolved?.packagingBreakdown?.components ?? null,
        filamentCost: resolved?.filamentCost ?? 0,
        categoryName: p.categoryName,
        desi: p.desi,
        commissionRate: p.commissionRate,
        madeToOrder: p.madeToOrder,
        stock: p.stock,
        listingByPlatform,
      };
      const add = (k: string | null | undefined) => {
        if (k && !byKey.has(k)) byKey.set(k, m);
      };
      add(p.barcode);
      add(p.sku);
      for (const l of p.listings) {
        add(l.externalId);
        add(l.externalSku);
        add(l.barcode); // platform-bazlı barkod (her platformda farklı olabilir)
      }
      // Shopify ad-eşleştirme: aynı ad birden çok üründe varsa null (belirsiz → eşleştirme).
      const nk = normName(p.name);
      if (nk) byName.set(nk, byName.has(nk) ? null : m);
    }
  }

  // NOT: Sipariş kârının TAMAMI @/core/order-profit → computeOrderProfit içinde (masaüstü + mobil
  // AYNI fonksiyon). Adet başına: ürün/paketleme/komisyon/yüzdesel gider. Siparişe BİR KEZ: kargo +
  // SABİT gider (Platform Hizmet Bedeli — kullanıcı teyidi: sipariş başına kesiliyor).

  // Olay-anı bildirim adayları (stoğu biten / sipariş-üzerine ürüne sipariş).
  // Sadece AKSİYON gereken (pending/processing) + SON 7 GÜN siparişler → tekilleştirilmiş.
  const PLATFORM_LABEL: Record<string, string> = { shopify: "Shopify", trendyol: "Trendyol", hepsiburada: "Hepsiburada" };
  const notifCutoff = Date.now() - 7 * 86_400_000;
  const notifs: { id: string; type: string; severity: string; title: string; body: string; href: string }[] = [];

  // Zenginleştirilmiş birleşik siparişler ───────────────────────────────────
  for (const r of historyRows) {
    const actionable =
      (r.statusKind === "pending" || r.statusKind === "processing") &&
      (!r.date || new Date(r.date).getTime() >= notifCutoff);
    let thumb: string | null = null;
    const profitLines: OrderProfitLine[] = [];
    const items: UnifiedOrderItem[] = r.lines.map((l) => {
      let m: Matched | null = null;
      for (const k of l.matchKeys) {
        const hit = byKey.get(k);
        if (hit) {
          m = hit;
          break;
        }
      }
      // Anahtarlar tutmadı + Shopify ise: ürün adıyla eşleştir (Shopify barkod tutmaz).
      if (!m && r.platform === "shopify") {
        const named = byName.get(normName(l.name));
        if (named) m = named;
      }
      const image = l.image || m?.imageUrl || null;
      if (image && !thumb) thumb = image;

      // Kâr hesabı için satırı topla — hesabın tamamı aşağıda computeOrderProfit'te (tek çağrı).
      profitLines.push({
        unitPrice: l.unitPrice,
        quantity: l.quantity,
        product: m
          ? {
              id: m.id, name: m.name, categoryName: m.categoryName,
              desi: m.desi, commissionRate: m.commissionRate,
              productionCost: m.productionCost, packagingCost: m.packagingCost,
              packagingComponents: m.packagingComponents,
              filamentCost: m.filamentCost,
              listing: m.listingByPlatform[r.platform] ?? null,
            }
          : null,
      });

      if (m) {
        // Bildirim: aktif siparişte sipariş-üzerine ürün → üretim hatırlatıcı (uyarı);
        // değilse stok 0/negatif → acil (sattık ama gönderemiyoruz).
        if (actionable) {
          const qty = l.quantity > 1 ? ` ×${l.quantity}` : "";
          const tail = `${PLATFORM_LABEL[r.platform]} #${r.orderNumber}${qty}`;
          if (m.madeToOrder) {
            notifs.push({
              id: `order-made:${r.id}:${m.id}`,
              type: "order-made",
              severity: "warning",
              title: "Sipariş üzerine üretim",
              body: `${m.name} — ${tail}`,
              href: `/products/${m.id}`,
            });
          } else if (m.stock <= 0) {
            notifs.push({
              id: `order-stock:${r.id}:${m.id}`,
              type: "order-stock",
              severity: "critical",
              title: "Stoğu biten ürüne sipariş!",
              body: `${m.name} — ${tail} · stok yok`,
              href: `/products/${m.id}`,
            });
          }
        }
      }
      return {
        name: l.name,
        quantity: l.quantity,
        image,
        productId: m?.id ?? null,
        madeToOrder: m?.madeToOrder ?? false,
      };
    });

    // Kâr hesabının TAMAMI çekirdekte (masaüstü + mobil aynı fonksiyon): adet başına ürün/
    // komisyon/yüzdesel gider; siparişe BİR KEZ kargo + SABİT gider (Platform Hizmet Bedeli).
    const pr = computeOrderProfit({
      platform: r.platform,
      orderTotal: r.total,
      lines: profitLines,
      commissionRules,
      cargoRules,
      expenseRules,
      settings: settingsMap,
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
      profit: pr.profit,
      profitPartial: pr.partial || Boolean(r.forceProfitPartial),
      unmatchedCount: pr.unmatchedLines,
      missingDesiCount: pr.missingDesiLines,
      desiEstimated: pr.desiEstimated,
      orderRevenueAdjustment: pr.orderRevenueAdjustment,
      trackingNumber: r.trackingNumber,
      cargoProvider: r.cargoProvider,
    });
  }

  // Manuel siparişler kendi kalıcı finans snapshot'larını aynı ManualOrder satırında taşır.
  // Platform siparişlerinin canlı hesap hattına veya OrderFinanceSnapshot'a sokulmazlar.
  const manualOrders = await manualOrdersPromise;
  for (const manual of manualOrders) {
    try {
      const storedItems = parseManualOrderItems(manual.itemsJson).items;
      const storedBreakdown = parseManualOrderBreakdown(
        manual.breakdownJson
      ).breakdown;
      const items: UnifiedOrderItem[] = storedItems.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        image: item.imageUrl,
        productId: item.productId,
        madeToOrder: false,
      }));
      const image =
        storedItems.length === 1 ? storedItems[0]?.imageUrl ?? null : null;
      orders.push({
        platform: "manual",
        id: manual.id,
        orderNumber: manual.orderNumber,
        date: manual.orderedAt.toISOString(),
        statusKind: manual.statusKind as OrderStatusKind,
        statusLabel:
          manual.statusKind === "pending"
            ? "Bekliyor"
            : manual.statusKind === "processing"
              ? "Hazırlanıyor"
              : manual.statusKind === "shipped"
                ? "Gönderildi"
                : manual.statusKind === "delivered"
                  ? "Teslim Edildi"
                  : "İptal",
        total: kurusToTl(manual.revenueKurus),
        currency: manual.currency,
        customer: manual.customerName,
        itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
        items,
        image,
        profit:
          manual.profitKurus == null
            ? null
            : kurusToTl(manual.profitKurus),
        profitPartial: manual.profitPartial,
        unmatchedCount: storedBreakdown.missingCostItems,
        missingDesiCount: 0,
        desiEstimated: false,
        orderRevenueAdjustment: 0,
        trackingNumber: null,
        cargoProvider: null,
        isManual: true,
        manualOrderId: manual.id,
        editHref: `/api/manual-orders/${manual.id}`,
      });
    } catch (error) {
      console.error(
        `[manual-order] ${manual.id} okunamadı:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  // Bildirimleri kalıcılaştır — fire-and-forget (siparişler yanıtını YAVAŞLATMAZ / BOZMAZ).
  // ÖNCE hangileri GERÇEKTEN yeni tespit edilir → yalnız yeniler eklenir ve KRİTİK olanlar
  // (stoğu biten ürüne sipariş) telefona da push'lanır. Eski INSERT OR IGNORE tek başına
  // "yeni mi?" bilgisini vermiyordu → mobil push hiç yoktu ve tekrar-push riski olurdu.
  if (notifs.length > 0) {
    void (async () => {
      try {
        const existing = await prisma.notification.findMany({
          where: { id: { in: notifs.map((n) => n.id) } },
          select: { id: true },
        });
        const known = new Set(existing.map((e) => e.id));
        const fresh = notifs.filter((n) => !known.has(n.id));
        if (fresh.length === 0) return;
        const placeholders = fresh.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
        const params = fresh.flatMap((n) => [n.id, n.type, n.severity, n.title, n.body, n.href]);
        await prisma.$executeRawUnsafe(
          `INSERT OR IGNORE INTO "Notification" ("id","type","severity","title","body","href") VALUES ${placeholders}`,
          ...params
        );
        // Kritik iş olayı telefona da düşsün (baskı-bitti gibi) — yalnız İLK kez görülenler.
        for (const n of fresh.filter((f) => f.severity === "critical")) {
          await pushToAllDevices(n.title, n.body).catch(() => {});
        }
      } catch { /* tablo yoksa/yazma hatası → sessiz geç */ }
    })();
  }

  // En yeni üstte
  orders.sort((a, b) => {
    const ta = a.date ? new Date(a.date).getTime() : 0;
    const tb = b.date ? new Date(b.date).getTime() : 0;
    return tb - ta;
  });

  // Canlı 30 günlük pencereyi kalıcı finans geçmişine işle. Bu kayıtlar sonraki aylarda
  // platform API'sinin penceresinden çıksa da raporların geçmişini korur. Finans geçmişi
  // yazılamazsa sipariş ekranını bozmayız; sonraki senkron yeniden dener.
  let financeHistory: {
    ok: boolean;
    syncedOrders: number;
    syncDays: number;
    error?: string;
  };
  try {
    await persistOrderFinanceSnapshots(orders);
    financeHistory = {
      ok: true,
      syncedOrders: orders.filter(
        (order) => order.platform !== "manual" && Boolean(order.date)
      ).length,
      syncDays: HISTORY_SYNC_DAYS,
    };
  } catch (error) {
    console.error("[finance-snapshot] Sipariş finans geçmişi yazılamadı:", error);
    financeHistory = {
      ok: false,
      syncedOrders: 0,
      syncDays: HISTORY_SYNC_DAYS,
      error:
        error instanceof Error
          ? error.message
          : "Sipariş finans geçmişi kaydedilemedi.",
    };
  }

  const visibleOrders = orders.filter(
    (order) => !order.date || new Date(order.date).getTime() >= cutoff
  );

  // Dashboard özeti (iptal/iade hariç) ──────────────────────────────────────
  const empty = (): SummaryBucket => ({ revenue: 0, profit: 0, orderCount: 0, incompleteOrders: 0 });
  const sShopify = empty();
  const sTrendyol = empty();
  const sHepsiburada = empty();
  const sManual = empty();
  const unsupportedCurrencies = new Map<string, number>();
  for (const o of visibleOrders) {
    if (o.statusKind === "cancelled") continue;
    const currency = normalizedCurrency(o.currency);
    // Farklı para birimlerini kur dönüşümü olmadan TL toplamına eklemek yanlış sonuç üretir.
    // Sipariş listede kendi para birimiyle kalır; yalnızca 30 günlük TL özeti dışında tutulur.
    if (currency !== "TRY") {
      unsupportedCurrencies.set(currency, (unsupportedCurrencies.get(currency) ?? 0) + 1);
      continue;
    }
    const bucket =
      o.platform === "shopify"
        ? sShopify
        : o.platform === "trendyol"
          ? sTrendyol
          : o.platform === "hepsiburada"
            ? sHepsiburada
            : sManual;
    bucket.revenue += o.total;
    bucket.profit += o.profit ?? 0;
    bucket.orderCount += 1;
    // Maliyeti girilmemiş ürün içeren sipariş → toplam kâr EKSİK; UI uyarı gösterir.
    if (o.profit == null || o.profitPartial) bucket.incompleteOrders += 1;
  }
  const total: SummaryBucket = {
    revenue:
      sShopify.revenue +
      sTrendyol.revenue +
      sHepsiburada.revenue +
      sManual.revenue,
    profit:
      sShopify.profit +
      sTrendyol.profit +
      sHepsiburada.profit +
      sManual.profit,
    orderCount:
      sShopify.orderCount +
      sTrendyol.orderCount +
      sHepsiburada.orderCount +
      sManual.orderCount,
    incompleteOrders:
      sShopify.incompleteOrders +
      sTrendyol.incompleteOrders +
      sHepsiburada.incompleteOrders +
      sManual.incompleteOrders,
  };
  const quality: SummaryQuality = {
    unsupportedCurrencyOrders: [...unsupportedCurrencies.values()].reduce(
      (sum, count) => sum + count,
      0
    ),
    unsupportedCurrencies: [...unsupportedCurrencies.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, orderCount]) => ({ currency, orderCount })),
  };

  return {
    orders: visibleOrders,
    summary: {
      days: WINDOW_DAYS,
      shopify: sShopify,
      trendyol: sTrendyol,
      hepsiburada: sHepsiburada,
      manual: sManual,
      total,
      quality,
    },
    shopify,
    trendyol,
    hepsiburada,
    financeHistory,
  };
}
