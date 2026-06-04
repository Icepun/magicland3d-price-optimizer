import type { OrderItem, UnifiedOrder } from "@/lib/api/orders";
import { orderWindowCutoff } from "@/lib/api/window";

/**
 * Hepsiburada siparişleri (mobil) — masaüstü src/app/api/orders/route.ts HB bloğunun
 * RN-güvenli portu. Node API yok (Buffer/fs/net yok); fetch + globalThis.btoa kullanır.
 *
 * Auth (DOĞRULANDI, masaüstü hepsiburada-client.ts): HTTP Basic = base64(merchantId:secretKey)
 * + ZORUNLU `User-Agent: <developerUsername>` header. merchantId ayrıca path param.
 * Ortam: "live"→canlı host, aksi halde "test" (SIT).
 *
 * Siparişler TEK uçtan gelmez: /orders sadece "Open" (paketlenecek) FLAT kalem listesi verir;
 * kargoda/teslim siparişler /packages/.../{shipped|delivered|undelivered} ÖZETLERİNDE
 * (tutar/kalem YOK) → tutarlar getOrderDetail ile ayrı çekilir.
 */

const MERCHANT_ID = process.env.EXPO_PUBLIC_HEPSIBURADA_MERCHANT_ID;
const SECRET_KEY = process.env.EXPO_PUBLIC_HEPSIBURADA_SECRET_KEY;
const DEV_USERNAME = process.env.EXPO_PUBLIC_HEPSIBURADA_DEV_USERNAME;
// env: "live" → canlı; aksi (test/boş) → SIT test ortamı.
const ENV = (process.env.EXPO_PUBLIC_HEPSIBURADA_ENV || "live").toLowerCase();

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** ASCII string → base64 (RN'de Buffer yok; btoa varsa onu kullan). */
function base64(str: string): string {
  if (typeof globalThis.btoa === "function") return globalThis.btoa(str);
  let out = "";
  for (let i = 0; i < str.length; i += 3) {
    const a = str.charCodeAt(i);
    const b = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
    const c = i + 2 < str.length ? str.charCodeAt(i + 2) : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < str.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < str.length ? B64[c & 63] : "=";
  }
  return out;
}

/** Ortam bazlı OMS host (canlı vs SIT). Masaüstü hepsiburadaHosts() ile aynı. */
function omsHost(): string {
  return ENV === "live"
    ? "https://oms-external.hepsiburada.com"
    : "https://oms-external-sit.hepsiburada.com";
}

/* ── Defansif HB yardımcıları (masaüstü route.ts ile birebir) ───────────────── */

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

/** Tarih → epoch ms (mobil UnifiedOrder.date number). Çözülemezse null. */
function hbDateMs(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (v == null || v === "") continue;
    const d = new Date(typeof v === "number" ? v : String(v));
    if (!isNaN(d.getTime())) return d.getTime();
  }
  return null;
}

/** HB sipariş/detay kalemi → mobil OrderItem (tutar + eşleştirme anahtarları). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hbLineRaw(li: Record<string, any>): OrderItem {
  const qty = Math.max(1, Math.floor(hbNum(li.quantity ?? li.amount ?? 1)));
  const unit = hbNum(li.unitPrice ?? li.price) || hbNum(li.totalPrice) / qty;
  return {
    name: hbStr(li.productName, li.name, li.title, li.barcode, li.merchantSku) || "Ürün",
    quantity: qty,
    unitPrice: unit,
    matchKeys: [li.merchantSku, li.sku, li.barcode, li.stockCode, li.hepsiburadaSku].filter(
      (k): k is string => typeof k === "string" && !!k
    ),
  };
}

/** items'i en çok `limit` eşzamanlı worker ile işle (detay çağrılarını sınırla). */
async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx]);
      }
    })
  );
}

/* ── HB istek (auth header + hata) ──────────────────────────────────────────── */

function headers(): Record<string, string> {
  const token = base64(`${MERCHANT_ID}:${SECRET_KEY}`);
  return {
    Authorization: `Basic ${token}`,
    Accept: "application/json",
    // HB User-Agent'ı ZORUNLU tutuyor → developer username. Eksikse 403.
    "User-Agent": DEV_USERNAME || "MagiclandHub",
  };
}

async function hbRequest(path: string): Promise<unknown> {
  const res = await fetch(`${omsHost()}${path}`, { headers: headers() });
  const text = await res.text();
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const detail =
      typeof body === "string"
        ? body.slice(0, 200)
        : ((body as Record<string, unknown>)?.message as string) || res.statusText;
    throw new Error(`Hepsiburada API ${res.status}: ${detail}`);
  }
  return body;
}

const MID = () => encodeURIComponent(MERCHANT_ID ?? "");

/** Ödemesi tamamlanmış ("Open"/paketlenecek) siparişler. Sayfalı. */
function listOrders(params: { offset?: number; limit?: number } = {}): Promise<unknown> {
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 100;
  return hbRequest(`/orders/merchantid/${MID()}?offset=${offset}&limit=${limit}`);
}

/** Paket statü listesi (özet: OrderNumber + tarih; tutar/kalem YOK). */
function listPackages(
  status: "" | "shipped" | "delivered" | "undelivered" = "",
  params: { offset?: number; limit?: number } = {}
): Promise<unknown> {
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 100;
  const path = status ? `/packages/merchantid/${MID()}/${status}` : `/packages/merchantid/${MID()}`;
  return hbRequest(`${path}?offset=${offset}&limit=${limit}`);
}

/** Sipariş detayı (kalem + tutarlar). Özet uçların döndürmediği fiyatlar buradan. */
function getOrderDetail(orderNumber: string): Promise<unknown> {
  return hbRequest(`/orders/merchantid/${MID()}/ordernumber/${encodeURIComponent(orderNumber)}`);
}

/* ── Birleştirme (masaüstü route.ts HB bloğunun birebir portu) ──────────────── */

type HbAgg = { status: string; date: number | null; customer: string | null; lines: OrderItem[] | null };

export async function getHepsiburadaOrders(): Promise<UnifiedOrder[]> {
  // Kimlik bilgisi eksikse sessizce boş (trendyol.ts/shopify.ts gibi).
  if (!MERCHANT_ID || !SECRET_KEY || !DEV_USERNAME) return [];

  const cutoff = orderWindowCutoff();
  const agg = new Map<string, HbAgg>();

  // a) Open siparişler — /orders FLAT kalem listesi (orderNumber tekrar eder) → grupla.
  const openRes = await listOrders({ limit: 100 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const li of hbArray(openRes, ["items", "orders", "data", "content", "result"]) as Record<string, any>[]) {
    const on = hbStr(li.orderNumber, li.orderId, li.id);
    if (!on) continue;
    let e = agg.get(on);
    if (!e) {
      e = {
        status: hbStr(li.status) || "Open",
        date: hbDateMs(li.orderDate, li.createdDate),
        customer: hbStr(li.customerName) || null,
        lines: [],
      };
      agg.set(on, e);
    }
    (e.lines as OrderItem[]).push(hbLineRaw(li));
  }

  // b) Paket özetleri (paketlenmiş / kargoda / teslim / teslim-edilemedi) — OrderNumber + tarih.
  const pkgStatuses: Array<["" | "shipped" | "delivered" | "undelivered", string]> = [
    ["", "Packaged"],
    ["shipped", "Shipped"],
    ["delivered", "Delivered"],
    ["undelivered", "UnDelivered"],
  ];
  const pkgResults = await Promise.all(
    pkgStatuses.map(async ([s]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items: Record<string, any>[] = [];
      for (let off = 0; off < 3000; off += 100) {
        const arr = hbArray(await listPackages(s, { offset: off, limit: 100 }), ["items", "data", "content", "result"]);
        if (!arr.length) break;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        items.push(...(arr as Record<string, any>[]));
        if (arr.length < 100) break;
      }
      return items;
    })
  );
  for (const [idx, pkgs] of pkgResults.entries()) {
    const [statusCode, label] = pkgStatuses[idx];
    // Statüsüz /packages ucu (paketlenecek/gönderime-hazır/kargoda) TAM sipariş verir: kalem+tutar
    // `items` içinde gelir → packageNumber/id anahtarıyla DOĞRUDAN işlenir (detay fetch GEREKMEZ).
    // (Masaüstü v0.19.56: önceden sadece teslim edilenler görünüyordu.)
    const isFullOrder = statusCode === "";
    for (const p of pkgs) {
      if (isFullOrder) {
        const key = hbStr(p.packageNumber, p.id, p.OrderNumber, p.orderNumber);
        if (!key || agg.has(key)) continue;
        agg.set(key, {
          status: hbStr(p.status) || label,
          date: hbDateMs(p.orderDate, p.CreatedDate, p.PackageReadyDate),
          customer: hbStr(p.recipientName, p.customerName) || null,
          lines: (hbArray(p, ["items", "lines", "orderItems"]) as Record<string, unknown>[]).map(hbLineRaw),
        });
      } else {
        const on = hbStr(p.OrderNumber, p.orderNumber, Array.isArray(p.OrderNumbers) ? p.OrderNumbers[0] : "");
        if (!on || agg.has(on)) continue;
        agg.set(on, {
          status: label,
          date: hbDateMs(p.DeliveredDate, p.ShippedDate, p.UndeliveredDate, p.CreatedDate, p.orderDate, p.PackageReadyDate),
          customer: null,
          lines: null,
        });
      }
    }
  }

  // 30 güne filtrele (tarihsizleri tut) — detay çekmeden ÖNCE (gereksiz çağrı olmasın).
  for (const [on, e] of [...agg]) if (e.date != null && e.date < cutoff) agg.delete(on);

  // c) Tutarı olmayan (özetten gelen) siparişlerin detayını PARALEL çek (concurrency 8, cap 250).
  const needDetail = [...agg.entries()].filter(([, e]) => e.lines === null).map(([on]) => on).slice(0, 250);
  await mapLimit(needDetail, 8, async (on) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = (await getOrderDetail(on)) as Record<string, any>;
      const e = agg.get(on);
      if (!e) return;
      e.lines = (hbArray(d, ["items", "lineItems", "details", "lines", "orderItems"]) as Record<string, unknown>[]).map(
        hbLineRaw
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      e.customer = e.customer ?? (hbStr((d.customer ?? {}).name, d.customerName) || null);
      // Sipariş VERME tarihini tercih et (kargo/teslim değil) → liste + 30g penceresi sipariş tarihine
      // göre (masaüstü v0.19.58). Paketten gelen ShippedDate/DeliveredDate bununla ezilir.
      const od = hbDateMs(d.orderDate, d.createdDate);
      if (od != null) e.date = od;
    } catch {
      /* detay alınamadı → o sipariş kalemsiz (kârsız) görünür, listede kalır */
    }
  });

  // d) Birleşik UnifiedOrder'lar (mobil şekil: date = epoch ms, total = Σ unitPrice*qty).
  const orders: UnifiedOrder[] = [];
  for (const [on, e] of agg) {
    const lines = e.lines ?? [];
    orders.push({
      id: `hb-${on}`,
      platform: "hepsiburada",
      orderNumber: on,
      date: e.date ?? Date.now(),
      status: e.status, // ham etiket: Open/Packaged/Shipped/Delivered/UnDelivered → statusInfo() çevirir
      customer: e.customer,
      total: lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0),
      items: lines,
    });
  }
  return orders;
}
