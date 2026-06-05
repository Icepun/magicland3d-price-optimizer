/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import {
  ShopifyClient,
  ShopifyAdminTokenMissingError,
} from "@/services/shopify-client";
import { getShopifyCredentials } from "@/services/shopify-settings";
import { TrendyolClient } from "@/services/trendyol-client";
import { getTrendyolCredentials } from "@/services/trendyol-settings";
import { HepsiburadaClient } from "@/services/hepsiburada-client";
import { getHepsiburadaCredentials } from "@/services/hepsiburada-settings";
import { simulatePrice } from "@/core/pricing-engine";
import { resolveProductCost } from "@/core/product-cost";
import { withProductCommissionRule } from "@/core/product-commission";
import { filterCargoRulesByPlatform, filterRulesByPlatform, findCargoRule } from "@/core/cargo-calculator";

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
  /** Eşleşen ürünün id'si (varsa) — siparişler sayfasından ürün detayına gitmek için. */
  productId?: string | null;
  /** Bu ürün "sipariş üzerine üretilir" mi (bildirim/etiket için). */
  madeToOrder?: boolean;
}

export interface UnifiedOrder {
  platform: "shopify" | "trendyol" | "hepsiburada";
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
  filamentCost: number; // KDV iadesine giren malzeme payı
  categoryName: string;
  desi: number | null;
  commissionRate: number | null;
  madeToOrder: boolean;
  stock: number;
}

type CommissionRules = Parameters<typeof simulatePrice>[0]["commissionRules"];
type CargoRules = Parameters<typeof simulatePrice>[0]["cargoRules"];
type ExpenseRules = Parameters<typeof simulatePrice>[0]["expenseRules"];

// ── Sunucu önbelleği (stale-while-revalidate) ──────────────────────────────────────────────
// Siparişler 3 pazaryerinden CANLI çekiliyor (1-3sn). İlk yüklemeden SONRA her açış önbellekten
// ANINDA döner; 60sn'den eskiyse arka planda tazelenir (eski veri anında gösterilir → sayfa beklemez).
// "Yenile" (?fresh=1) senkron canlı çeker. Süreç-içi bellek (Electron ana süreci tek instance).
let _ordersCache: { at: number; body: Record<string, unknown> } | null = null;
let _ordersRefreshing = false;
const ORDERS_SOFT_MS = 60_000;

export async function GET(req: NextRequest) {
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  if (!fresh && _ordersCache) {
    if (Date.now() - _ordersCache.at > ORDERS_SOFT_MS && !_ordersRefreshing) {
      _ordersRefreshing = true;
      void computeOrdersBody()
        .then((b) => { _ordersCache = { at: Date.now(), body: b }; })
        .catch(() => {})
        .finally(() => { _ordersRefreshing = false; });
    }
    return NextResponse.json(_ordersCache.body);
  }
  const body = await computeOrdersBody();
  _ordersCache = { at: Date.now(), body };
  return NextResponse.json(body);
}

async function computeOrdersBody(): Promise<Record<string, unknown>> {
  await ensureRuntimeSchema();

  // Gün başına sabitlenmiş cutoff — mobil (mobile/src/lib/api/window.ts orderWindowCutoff) ile
  // BİREBİR aynı formül. İki uygulama da aynı UTC günü boyunca aynı değeri üretir → sipariş
  // sayısı/ciro/kâr ne zaman yenilenirse yenilensin eşleşir (kayan saniye sınırı yok).
  const cutoff = (Math.floor(Date.now() / 86_400_000) - WINDOW_DAYS) * 86_400_000;
  const orders: UnifiedOrder[] = [];
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
  };
  const raws: Raw[] = [];

  // Üç platformu PARALEL çek — toplam gecikme = en yavaş tek platform (sıralı toplam DEĞİL).
  // Bloklar bağımsız: her biri kendi raws'ını push'lar + kendi durum değişkenini atar (yarış yok).
  await Promise.all([
   (async () => {
   try {
    const client = new ShopifyClient(await getShopifyCredentials());
    // +1 gün: gün-başı cutoff'tan biraz daha geniş çek (superset); aşağıdaki `recent` filtresi
    // (cutoff = gün başı) tam kırpar → mobil ile aynı pencere. Shopify created_at = orderDate.
    const list = await client.listOrders({ sinceDays: WINDOW_DAYS + 1, limit: 100 });
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
    for (let chunkEnd = Date.now(); chunkEnd > cutoff; chunkEnd -= CHUNK) {
      const chunkStart = Math.max(cutoff, chunkEnd - CHUNK);
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
    for (const [on, e] of [...agg]) if (e.date && new Date(e.date).getTime() < cutoff) agg.delete(on);

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

  // Son 30 güne filtrele (tarihsiz olanları da tut)
  const recent = raws.filter((r) => !r.date || new Date(r.date).getTime() >= cutoff);

  // Sipariş satırlarını ÜRÜNLERİMİZLE eşleştir → görsel + maliyet + kâr ──────────
  const allKeys = new Set<string>();
  const shopifyNames = new Set<string>(); // Shopify barkod tutmaz → ada göre eşleştirme
  for (const r of recent) {
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
  let vatRate = 0;

  if (allKeys.size > 0 || shopifyNames.size > 0) {
    const keyList = [...allKeys];
    const nameList = [...shopifyNames];
    const [products, cRules, kRules, eRules, settings] = await Promise.all([
      prisma.product.findMany({
        where: {
          OR: [
            { barcode: { in: keyList } },
            { sku: { in: keyList } },
            { listings: { some: { externalId: { in: keyList } } } },
            { listings: { some: { externalSku: { in: keyList } } } },
            { listings: { some: { barcode: { in: keyList } } } },
            { name: { in: nameList } },
          ],
        },
        include: { cost: { include: { filamentType: { select: { costPerGram: true } } } }, listings: true },
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
        filamentCost: resolved?.filamentCost ?? 0,
        categoryName: p.categoryName,
        desi: p.desi,
        commissionRate: p.commissionRate,
        madeToOrder: p.madeToOrder,
        stock: p.stock,
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

  // Satır kârı — KARGOSUZ (cargoCostOverride: 0). Kargo gönderiye bir kez, sipariş düzeyinde
  // toplam desiye göre ayrıca düşülür (her ürün/adet için tekrar tekrar değil).
  function lineProfitNoCargo(platform: "shopify" | "trendyol" | "hepsiburada", m: Matched, unitPrice: number, qty: number): number | null {
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
      cargoCostOverride: 0,
      vatableProductCost: m.filamentCost,
    });
    return sim.netProfit * qty;
  }

  // Olay-anı bildirim adayları (stoğu biten / sipariş-üzerine ürüne sipariş).
  // Sadece AKSİYON gereken (pending/processing) + SON 7 GÜN siparişler → tekilleştirilmiş.
  const PLATFORM_LABEL: Record<string, string> = { shopify: "Shopify", trendyol: "Trendyol", hepsiburada: "Hepsiburada" };
  const notifCutoff = Date.now() - 7 * 86_400_000;
  const notifs: { id: string; type: string; severity: string; title: string; body: string; href: string }[] = [];

  // Zenginleştirilmiş birleşik siparişler ───────────────────────────────────
  for (const r of recent) {
    const actionable =
      (r.statusKind === "pending" || r.statusKind === "processing") &&
      (!r.date || new Date(r.date).getTime() >= notifCutoff);
    let orderProfit = 0;
    let anyProfit = false;
    let anyUnmatched = false;
    let thumb: string | null = null;

    let totalDesi = 0;
    let cargoCategory = "";
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

      if (m) {
        const p = lineProfitNoCargo(r.platform, m, l.unitPrice, l.quantity);
        if (p !== null) {
          orderProfit += p;
          anyProfit = true;
          totalDesi += (m.desi ?? 1) * l.quantity;
          if (!cargoCategory) cargoCategory = m.categoryName;
        } else {
          anyUnmatched = true;
        }
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
      } else {
        anyUnmatched = true;
      }
      return {
        name: l.name,
        quantity: l.quantity,
        image,
        productId: m?.id ?? null,
        madeToOrder: m?.madeToOrder ?? false,
      };
    });

    // KARGO: tüm gönderiye BİR KEZ — toplam desiye göre (ürün/adet başına tekrar değil).
    // 2 ürünlü / 2 adetli siparişte tek kargo bedeli düşülür (eski hata: her satır için ayrı).
    if (anyProfit) {
      const cargoRule = findCargoRule(
        filterCargoRulesByPlatform(cargoRules, r.platform),
        r.total,
        cargoCategory,
        totalDesi || 1
      );
      if (cargoRule) {
        // Kargo bedelini düş + içindeki indirilebilir KDV'yi iade et (kâr, KDV'siz kargoyu görür) —
        // satır kârı zaten komisyon/gider/filament KDV iadesini içeriyor; kargo gönderiye bir kez burada.
        orderProfit -= cargoRule.cargoCost;
        orderProfit += cargoRule.cargoCost * (vatRate > 0 ? vatRate / (100 + vatRate) : 0);
      }
    }

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

  // Bildirimleri kalıcılaştır — fire-and-forget (siparişler yanıtını YAVAŞLATMAZ /
  // BOZMAZ). id tekilleştirme anahtarı; SQLite "INSERT OR IGNORE" ile aynı satır bir
  // kez yazılır (Prisma createMany SQLite'ta skipDuplicates desteklemiyor). Tek round-trip.
  if (notifs.length > 0) {
    const placeholders = notifs.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params = notifs.flatMap((n) => [n.id, n.type, n.severity, n.title, n.body, n.href]);
    void prisma
      .$executeRawUnsafe(
        `INSERT OR IGNORE INTO "Notification" ("id","type","severity","title","body","href") VALUES ${placeholders}`,
        ...params
      )
      .catch(() => {/* tablo yoksa/yazma hatası → sessiz geç */});
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
  const sHepsiburada = empty();
  for (const o of orders) {
    if (o.statusKind === "cancelled") continue;
    const bucket =
      o.platform === "shopify" ? sShopify : o.platform === "trendyol" ? sTrendyol : sHepsiburada;
    bucket.revenue += o.total;
    bucket.profit += o.profit ?? 0;
    bucket.orderCount += 1;
  }
  const total: SummaryBucket = {
    revenue: sShopify.revenue + sTrendyol.revenue + sHepsiburada.revenue,
    profit: sShopify.profit + sTrendyol.profit + sHepsiburada.profit,
    orderCount: sShopify.orderCount + sTrendyol.orderCount + sHepsiburada.orderCount,
  };

  return {
    orders,
    summary: { days: WINDOW_DAYS, shopify: sShopify, trendyol: sTrendyol, hepsiburada: sHepsiburada, total },
    shopify,
    trendyol,
    hepsiburada,
  };
}
