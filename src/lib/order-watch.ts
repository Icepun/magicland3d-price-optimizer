import { prisma, remotePrisma } from "./prisma";
import { matchByPriority, uniqueIndex } from "./listing-index";
import { pushToAllDevices } from "./push-notify";
import { ensureRuntimeSchema } from "./runtime-schema";
import { toDbDate } from "./sqlite-date";
import { buildFilamentAlerts, groupSpools, type SpoolLike } from "@/core/filament-groups";
import { loadFilamentSettings } from "@/lib/filament-settings";
import { ShopifyClient } from "@/services/shopify-client";
import { getShopifyCredentials } from "@/services/shopify-settings";
import { TrendyolClient } from "@/services/trendyol-client";
import { getTrendyolCredentials } from "@/services/trendyol-settings";
import { HepsiburadaClient } from "@/services/hepsiburada-client";
import { getHepsiburadaCredentials } from "@/services/hepsiburada-settings";

/**
 * Sipariş & stok izleyici — sunucu tarafında periyodik çalışır (yazıcı relay'i gibi).
 *
 * İKİ AYRI DÖNGÜ (bilinçli ayrım):
 *
 * 1) HIZLI TARAMA (90 sn) — yalnız "bildirilecek bir şey oldu mu?" sorusunu yanıtlar:
 *    son 2 günün sipariş listesi + eşleşen ürünün stok / sipariş-üzerine bilgisi, ayrıca
 *    düşük stok ve filament eşikleri. Kâr hesabı, komisyon/kargo kuralları, finans geçmişi
 *    ve pazaryeri detay çağrıları YOK.
 *    NEDEN: bildirimler eskiden yalnız ağır /api/orders gövdesi hesaplanırken doğuyordu; o da
 *    5 dakikada bir ve önbellek tazeyse hiç hesaplanmıyordu → bildirim tipik 3, en kötü 8
 *    dakika gecikiyordu. Ucuz tarama sık koşabildiği için gecikme saniyelere iner.
 *
 * 2) YAVAŞ ISITMA (5 dk) — ağır /api/orders gövdesini sıcak tutar (Siparişler sayfası anında
 *    açılsın) ve bildirim tablosunu budar. Kâr hesabının tek sahibi hâlâ o uçtur.
 *
 * Tek mutex'e saygı: hızlı tarama turu başına ~6 DB sorgusu yapar.
 */
const SCAN_MS = 90_000;
const FIRST_SCAN_MS = 20_000;
const WARM_MS = 5 * 60_000;
const FIRST_WARM_MS = 90_000;
/** Bildirim taraması yalnız SON 2 GÜNÜN siparişlerine bakar — daha eskisi zaten bildirilmiştir. */
const SCAN_WINDOW_MS = 2 * 86_400_000;
/** Tek turda telefona gidecek en fazla bildirim (birikmiş durumda telefonu bombalamamak için). */
const MAX_PUSH_PER_SCAN = 5;

/**
 * TELEFONA bildirim gönderilecek bildirim türleri.
 *
 * Kullanıcının kararı: telefona yalnız SİPARİŞLER ve YAZICI olayları (bitti/durdu/hata) düşsün.
 * Stok ve filament uyarıları bilgilendirmedir — gün içinde eşik defalarca geçilebilir ve hemen
 * müdahale gerektirmez; onlar uygulamadaki zilde kalır. (Yazıcı olaylarını relay ayrı gönderir.)
 */
const PUSHABLE_TYPES = new Set(["order-stock", "order-made"]);

let started = false;
let warming = false;
let scanning = false;
let lastPruneAt = 0;

function dbPaused(): boolean {
  return Boolean((globalThis as { __MLHUB_DB_PAUSED__?: boolean }).__MLHUB_DB_PAUSED__);
}

function baseUrl(): string {
  // main.js dinlediği portu MLHUB_PORT'a yazar; dev'de PORT/3000'e düş.
  const port = process.env.MLHUB_PORT || process.env.PORT || "3000";
  return `http://127.0.0.1:${port}`;
}

/**
 * Eşleştirme anahtarını (barkod/stok kodu/ürün adı) tek biçime indirger.
 *
 * NEDEN: karşılaştırma ham metin üzerindeydi; sondaki tek bir boşluk ya da harf düzeni farkı
 * eşleşmeyi sessizce bozuyor, sipariş "maliyeti bilinmeyen" sayılıyordu. Türkçe I harfi ise ters
 * yönden ısırıyordu: "ISIK" ile "Işık" iki farklı küçük harfe düşüyordu. Dört I biçimi (I/İ/ı/i)
 * burada tek harfe indirgenir; bu yüzden yalnız I farkıyla ayrışan iki ürün "belirsiz" sayılır ve
 * kör eşleşme yerine hiç eşleşmez.
 *
 * BURADA DURUYOR ÇÜNKÜ: hem Siparişler ucu hem bu hızlı tarama aynı kuralı kullanmak zorunda,
 * ama Next rota dosyaları yalnız istek işleyicilerini dışa açabiliyor.
 */
export function normalizeMatchKey(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[İıi]/g, "I")
    .toUpperCase();
}

// ── Ortak tipler (saf yardımcılar dışarıdan test edilebilsin diye export'lu) ─────────────────

export type WatchSeverity = "critical" | "warning" | "success";

export interface WatchNotification {
  id: string;
  type: string;
  severity: WatchSeverity;
  title: string;
  body: string;
  href: string;
}

/** Eşleştirme anahtarları — türüne göre ayrı tutulur (aynı metin bir üründe barkod, ötekinde stok kodu). */
export interface ScanKeys {
  barcodes: string[];
  externalIds: string[];
  skus: string[];
}

export interface ScanLine extends ScanKeys {
  name: string;
  quantity: number;
}

export interface ScanOrder {
  platform: "shopify" | "trendyol" | "hepsiburada";
  id: string;
  orderNumber: string;
  /** Sipariş hâlâ aksiyon bekliyor mu (hazırlanacak/gönderilecek)? Kapanmış siparişe bildirim yok. */
  actionable: boolean;
  lines: ScanLine[];
}

export interface ScanProduct extends ScanKeys {
  id: string;
  name: string;
  stock: number;
  madeToOrder: boolean;
}

export interface ScanInventory {
  lowStock: Array<{ id: string; name: string; stock: number }>;
  siteOutOfStock: Array<{ productId: string; name: string }>;
  /**
   * Filament uyarıları — ZİLLE AYNI ÇEKİRDEKTEN (`buildFilamentAlerts`) gelir.
   * Burada eşik yeniden hesaplanmaz; iki uç aynı kimlikleri üretmezse zil aynı filamenti
   * iki ayrı uyarı olarak gösterir (bkz. buildInventoryNotifications başlığı).
   */
  filament: Array<{ id: string; severity: "critical" | "warning"; title: string; body: string; href: string }>;
  /** Bu turda gerçekten okunabilen uyarı türleri — temizlik yalnız bunlara dokunur. */
  readTypes: string[];
}

const PLATFORM_LABEL: Record<string, string> = {
  shopify: "Shopify",
  trendyol: "Trendyol",
  hepsiburada: "Hepsiburada",
};

/**
 * Stok/filament kaynaklı kalıcı satırların tipleri — eşik düşünce bu tipler temizlenir.
 *
 * "spool" ARTIK ÜRETİLMİYOR ama listede KALMALI: filament uyarısı gram eşiğinden kapalı-makara
 * sayısı eşiğine geçtiğinde kimlik düzeni de değişti (`spool-<makara>` → `filament-<grup>`).
 * Tip listeden çıkarılsaydı, sahada birikmiş eski `spool-…` satırları hiçbir zaman silinmez ve
 * zilde çelişkili bir ikinci filament uyarısı olarak asılı kalırdı.
 */
export const INVENTORY_TYPES = ["stock", "site-stock", "spool", "filament"];

// ── Saf yardımcılar ─────────────────────────────────────────────────────────────────────────

/**
 * Sipariş satırlarını ürünlerle eşleştirip bildirim adaylarını üretir.
 *
 * Kimlikler /api/orders'ın ürettikleriyle BİREBİR aynıdır (`order-stock:` / `order-made:`) →
 * iki taraf aynı olayı iki kez bildirmez, hangisi önce görürse o yazar.
 *
 * Aynı anahtar birden çok ürüne düşerse o anahtar hiç kullanılmaz: yanlış ürün için bildirim
 * atmaktansa hiç atmamak yeğdir (ağır uç sonraki turda doğrusunu bulur).
 */
export function buildOrderNotifications(
  orders: ScanOrder[],
  products: ScanProduct[]
): WatchNotification[] {
  type Entry = { key: string; product: ScanProduct };
  const barcodeEntries: Entry[] = [];
  const externalIdEntries: Entry[] = [];
  const skuEntries: Entry[] = [];
  const nameEntries: Entry[] = [];
  const push = (bucket: Entry[], raw: string | null | undefined, product: ScanProduct) => {
    const key = normalizeMatchKey(raw);
    if (key) bucket.push({ key, product });
  };
  for (const p of products) {
    for (const b of p.barcodes) push(barcodeEntries, b, p);
    for (const e of p.externalIds) push(externalIdEntries, e, p);
    for (const s of p.skus) push(skuEntries, s, p);
    push(nameEntries, p.name, p);
  }
  const barcodeIndex = uniqueIndex(barcodeEntries, (e) => e.key);
  const externalIdIndex = uniqueIndex(externalIdEntries, (e) => e.key);
  const skuIndex = uniqueIndex(skuEntries, (e) => e.key);
  const nameIndex = uniqueIndex(nameEntries, (e) => e.key);

  const out: WatchNotification[] = [];
  const seen = new Set<string>();
  for (const order of orders) {
    if (!order.actionable) continue;
    for (const line of order.lines) {
      const candidates: Array<readonly [string, Map<string, Entry>]> = [];
      for (const b of line.barcodes) candidates.push([normalizeMatchKey(b), barcodeIndex]);
      for (const e of line.externalIds) candidates.push([normalizeMatchKey(e), externalIdIndex]);
      for (const s of line.skus) candidates.push([normalizeMatchKey(s), skuIndex]);
      // Shopify satırı barkod taşımaz → son çare ürün adı (Siparişler ucuyla aynı sıra).
      if (order.platform === "shopify") candidates.push([normalizeMatchKey(line.name), nameIndex]);
      const product = matchByPriority(candidates)?.product;
      if (!product) continue;

      const qty = line.quantity > 1 ? ` ×${line.quantity}` : "";
      const tail = `${PLATFORM_LABEL[order.platform] ?? order.platform} #${order.orderNumber}${qty}`;
      if (product.madeToOrder) {
        const id = `order-made:${order.id}:${product.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          type: "order-made",
          severity: "warning",
          title: "Sipariş üzerine üretim",
          body: `${product.name} — ${tail}`,
          href: `/products/${product.id}`,
        });
      } else if (product.stock <= 0) {
        const id = `order-stock:${order.id}:${product.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          type: "order-stock",
          severity: "critical",
          title: "Stoğu biten ürüne sipariş!",
          body: `${product.name} — ${tail} · stok yok`,
          href: `/products/${product.id}`,
        });
      }
    }
  }
  return out;
}

/**
 * Düşük stok / biten filament eşiklerini kalıcı bildirim satırına çevirir.
 *
 * Kimlikler bildirim ucundaki ANLIK uyarı kimlikleriyle aynıdır (`stock-…`, `site-stock-…`,
 * `spool-…`) → zil listesinde aynı uyarı iki kez görünmez. Eşik ilk geçildiğinde satır yazılır,
 * eşiğin altından çıkınca satır silinir (aşağıdaki resolvedInventoryIds) → tekrar düşerse
 * yeniden bildirilir, ama düştüğü sürece tek bildirim atar.
 */
export function buildInventoryNotifications(inv: ScanInventory): WatchNotification[] {
  const out: WatchNotification[] = [];
  for (const p of inv.lowStock) {
    const empty = p.stock <= 0;
    out.push({
      id: `stock-${p.id}`,
      type: "stock",
      severity: empty ? "critical" : "warning",
      title: empty ? "Stok bitti" : "Stok kritik",
      body: `${p.name} — ${p.stock} adet`,
      href: `/products/${p.id}`,
    });
  }
  for (const l of inv.siteOutOfStock) {
    out.push({
      id: `site-stock-${l.productId}`,
      type: "site-stock",
      severity: "warning",
      title: "Sitede stok bitti",
      body: `${l.name} — mağaza sayfası satışa kapandı`,
      href: `/products/${l.productId}`,
    });
  }
  for (const f of inv.filament) {
    out.push({
      id: f.id,
      type: "filament",
      severity: f.severity,
      title: f.title,
      body: f.body,
      href: f.href,
    });
  }
  return out;
}

/** Şu an geçerli olan stok/filament bildirim kimlikleri — bunun dışındaki eski satırlar silinir. */
export function inventoryNotificationIds(inv: ScanInventory): string[] {
  return buildInventoryNotifications(inv).map((n) => n.id);
}

// ── Pazaryeri tarafı (ucuz liste çağrıları) ─────────────────────────────────────────────────

function keyList(...values: unknown[]): string[] {
  return values.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

/** Hepsiburada yanıtları kapsayıcı adı değiştirebiliyor — dizi nerede olursa oradan al. */
function hbRows(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  for (const key of ["items", "orders", "data", "content", "result"]) {
    if (Array.isArray(record[key])) return record[key] as Array<Record<string, unknown>>;
  }
  return [];
}

function hbText(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
}

/** Trendyol'da hâlâ aksiyon bekleyen (hazırlanacak) statüler. */
const TRENDYOL_ACTIONABLE = new Set(["Created", "Awaiting", "Picking", "Invoiced"]);

async function fetchShopifyScan(): Promise<ScanOrder[]> {
  const client = new ShopifyClient(await getShopifyCredentials());
  const list = await client.listOrders({ sinceDays: 2, limit: 50 });
  return list.map((o) => {
    const fulfillment = (o.fulfillmentStatus || "").toUpperCase();
    const financial = (o.financialStatus || "").toUpperCase();
    return {
      platform: "shopify" as const,
      id: o.id || `shopify-${o.name}`,
      orderNumber: o.name,
      actionable: !o.cancelledAt && financial !== "REFUNDED" && fulfillment !== "FULFILLED",
      lines: o.lines.map((l) => ({
        name: l.title,
        quantity: Number(l.quantity) || 1,
        barcodes: keyList(l.barcode),
        externalIds: keyList(l.variantId, l.variantId ? `shopify-variant-${l.variantId}` : null),
        skus: keyList(l.variantSku, l.sku),
      })),
    };
  });
}

async function fetchTrendyolScan(): Promise<ScanOrder[]> {
  const client = new TrendyolClient(await getTrendyolCredentials());
  const page = await client.listOrders({
    page: 0,
    size: 100,
    startDate: Date.now() - SCAN_WINDOW_MS,
    endDate: Date.now(),
  });
  return (page.content ?? []).map((o, i) => ({
    platform: "trendyol" as const,
    id: `ty-${o.id ?? o.orderNumber ?? i}`,
    orderNumber: String(o.orderNumber ?? o.id ?? "—"),
    actionable: TRENDYOL_ACTIONABLE.has(String(o.status ?? "")),
    lines: (o.lines ?? []).map((l) => ({
      name: l.productName ?? l.barcode ?? "Ürün",
      quantity: Number(l.quantity ?? 1) || 1,
      barcodes: keyList(l.barcode),
      externalIds: [],
      skus: keyList(l.sku, l.merchantSku).filter((k) => k !== "merchantSku"),
    })),
  }));
}

async function fetchHepsiburadaScan(): Promise<ScanOrder[]> {
  const client = new HepsiburadaClient(await getHepsiburadaCredentials());
  // Bu uç yalnız "paketlenecek" siparişleri KALEM kalem verir — tam da aksiyon bekleyenler.
  const rows = hbRows(await client.listOrders({ offset: 0, limit: 100 }));
  const byOrder = new Map<string, ScanOrder>();
  for (const li of rows) {
    const orderNumber = hbText(li.orderNumber, li.orderId, li.id);
    if (!orderNumber) continue;
    let order = byOrder.get(orderNumber);
    if (!order) {
      order = {
        platform: "hepsiburada",
        id: `hb-${orderNumber}`,
        orderNumber,
        actionable: true,
        lines: [],
      };
      byOrder.set(orderNumber, order);
    }
    order.lines.push({
      name: hbText(li.productName, li.name, li.title, li.barcode, li.merchantSku) || "Ürün",
      quantity: Math.max(1, Math.floor(Number(li.quantity ?? li.amount ?? 1)) || 1),
      barcodes: keyList(li.barcode),
      externalIds: keyList(li.hbSku, li.hepsiburadaSku),
      skus: keyList(li.merchantSku, li.sku, li.stockCode),
    });
  }
  return [...byOrder.values()];
}

async function fetchScanOrders(): Promise<ScanOrder[]> {
  const results = await Promise.all([
    fetchShopifyScan().catch(() => [] as ScanOrder[]),
    fetchTrendyolScan().catch(() => [] as ScanOrder[]),
    fetchHepsiburadaScan().catch(() => [] as ScanOrder[]),
  ]);
  return results.flat();
}

// ── DB tarafı ───────────────────────────────────────────────────────────────────────────────

/** Sipariş satırlarında geçen anahtarlara sahip ürünleri TEK sorguda çeker (maliyet/kural YOK). */
async function loadScanProducts(orders: ScanOrder[]): Promise<ScanProduct[]> {
  const keys = new Set<string>();
  const names = new Set<string>();
  for (const o of orders) {
    if (!o.actionable) continue;
    for (const l of o.lines) {
      for (const k of [...l.barcodes, ...l.externalIds, ...l.skus]) keys.add(k);
      if (o.platform === "shopify" && l.name) names.add(l.name);
    }
  }
  if (keys.size === 0 && names.size === 0) return [];
  const keyArray = [...keys];
  const nameArray = [...names];
  const rows = await prisma.product.findMany({
    where: {
      OR: [
        { barcode: { in: keyArray } },
        { sku: { in: keyArray } },
        { listings: { some: { externalId: { in: keyArray } } } },
        { listings: { some: { externalSku: { in: keyArray } } } },
        { listings: { some: { barcode: { in: keyArray } } } },
        ...(nameArray.length ? [{ name: { in: nameArray } }] : []),
      ],
    },
    select: {
      id: true,
      name: true,
      stock: true,
      madeToOrder: true,
      barcode: true,
      sku: true,
      listings: { select: { externalId: true, externalSku: true, barcode: true } },
    },
  });
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    stock: p.stock,
    madeToOrder: p.madeToOrder,
    barcodes: keyList(p.barcode, ...p.listings.map((l) => l.barcode)),
    externalIds: keyList(...p.listings.map((l) => l.externalId)),
    skus: keyList(p.sku, ...p.listings.map((l) => l.externalSku)),
  }));
}

/** Düşük stok / sitede tükenen / azalan filament — bildirim ucundaki eşiklerle BİREBİR aynı. */
async function loadInventory(): Promise<ScanInventory> {
  const lowStock = await prisma.product.findMany({
    // "Sipariş üzerine üretilir" ürünlerde stok TANIMI GEREĞİ 0'dır → hepsi kalıcı KRİTİK
    // "Stok bitti" satırı doğururdu ve zil sürekli kırmızı kalırdı. Panel de bunları
    // dışlıyor (api/dashboard: !madeToOrder) — aynı kural.
    where: { isActive: true, hidden: false, madeToOrder: false, stock: { lte: 1 } },
    select: { id: true, name: true, stock: true },
    take: 50,
  });
  const listings = await prisma.listing
    .findMany({
      where: {
        platform: "shopify",
        isActive: true,
        stock: { lte: 0 },
        product: { isActive: true, hidden: false, madeToOrder: false },
      },
      select: { product: { select: { id: true, name: true } } },
      take: 50,
    })
    .catch(() => null); // okunamadı → o türün satırlarına DOKUNULMAZ (aşağıya bak)
  // Zilin (/api/notifications) okuduğu ALAN LİSTESİYLE aynı — gruplama bu alanlara dayanıyor.
  const spoolRows = await prisma.filamentSpool
    .findMany({
      where: { isActive: true },
      select: {
        id: true, name: true, material: true, brand: true,
        colorName: true, colorHex: true, colorKey: true,
        totalGrams: true, remainingGrams: true, openedAt: true,
      },
    })
    .catch(() => null); // okunamadı → filament satırlarına DOKUNULMAZ
  // Eşik/susturma/izlenen grup ayarları da uyarının parçası; okunamazsa filament turu atlanır.
  const filamentSettings =
    spoolRows === null ? null : await loadFilamentSettings().catch(() => null);
  const filament =
    spoolRows && filamentSettings
      ? buildFilamentAlerts(groupSpools(spoolRows as SpoolLike[]), filamentSettings)
      : [];
  return {
    lowStock,
    siteOutOfStock: (listings ?? [])
      .filter((l) => l.product)
      .map((l) => ({ productId: l.product!.id, name: l.product!.name })),
    filament: filament.map((a) => ({
      id: a.id,
      severity: a.severity,
      title: a.title,
      body: a.body,
      href: a.href,
    })),
    // Bu turda GERÇEKTEN okunabilen türler. Okunamayan bir tür için "eşiğin üstüne çıktı"
    // sonucu çıkarılamaz — aşağıdaki temizlik yalnız bunlara dokunur.
    readTypes: [
      "stock",
      // Shopify listing okunamadıysa "sitede stok bitti" satırları çözülmüş SAYILAMAZ.
      ...(listings === null ? [] : ["site-stock"]),
      // Filament okunabildiyse eski "spool" satırları da bu turda temizlenir (kimlik düzeni değişti).
      ...(spoolRows && filamentSettings ? ["filament", "spool"] : []),
    ],
  };
}

/**
 * Yeni bildirimleri yazar ve YALNIZ ilk kez görülen kritikleri telefona gönderir.
 * Var olan kimlikleri önce okuruz: `INSERT OR IGNORE` tek başına "yeni miydi?" bilgisini vermiyor,
 * o bilgi olmadan da her turda aynı olay telefona tekrar tekrar düşerdi.
 */
async function persistNotifications(rows: WatchNotification[]): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  const existing = await prisma.notification
    .findMany({ where: { id: { in: ids } }, select: { id: true } })
    .catch(() => [] as Array<{ id: string }>);
  const known = new Set(existing.map((e) => e.id));
  const fresh = rows.filter((r) => !known.has(r.id));
  if (fresh.length === 0) return;

  // createdAt AÇIKÇA yazılır: kolon boş bırakılınca SQLite'ın DEFAULT CURRENT_TIMESTAMP değeri
  // giriyor ("2026-08-13 07:00:00"). Prisma'nın yazdığı ISO biçimden farklı bir metin ve metin
  // sıralamasında boşluk 'T'den küçük → bu satırlar zil listesinin en dibine düşüyordu.
  const simdi = toDbDate(new Date());
  for (let i = 0; i < fresh.length; i += 50) {
    const chunk = fresh.slice(i, i + 50);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = chunk.flatMap((n) => [
      n.id,
      n.type,
      n.severity,
      n.title,
      n.body,
      n.href,
      simdi,
    ]);
    await prisma
      .$executeRawUnsafe(
        `INSERT OR IGNORE INTO "Notification" ("id","type","severity","title","body","href","createdAt") VALUES ${placeholders}`,
        ...params
      )
      .catch(() => 0);
  }

  // TELEFONA yalnız SİPARİŞ olayları gider (yazıcı olaylarını relay ayrıca gönderir).
  // Kullanıcının kararı: stok/filament uyarıları telefonu meşgul etmesin, zilde kalsın —
  // bunlar "hemen müdahale" gerektirmiyor ve gün içinde tekrar tekrar eşik geçebiliyor.
  const pushable = fresh
    .filter((n) => n.severity === "critical" && PUSHABLE_TYPES.has(n.type))
    .slice(0, MAX_PUSH_PER_SCAN);
  for (const n of pushable) {
    await pushToAllDevices(n.title, n.body).catch(() => {});
  }
}

/**
 * Eşiğin üstüne çıkan ürün/makaraların bildirim satırını sil → tekrar düşerse yeniden bildirilir.
 *
 * ⚠️ YALNIZ bu turda GERÇEKTEN okunabilen türlere dokunur. Site-stok sorgusu geçici bir hatada
 * boş dönebiliyor; tüm türleri kapsayan bir silme, o turda okunamayan türün TAMAMINI "çözüldü"
 * sayıp kullanıcının okuduğu uyarıları siliyordu — sonraki turda hepsi okunmamış olarak geri
 * doğuyor ve zil tekrar kırmızıya dönüyordu.
 */
async function clearResolvedInventory(
  validIds: string[],
  readTypes: string[]
): Promise<void> {
  if (readTypes.length === 0) return;
  await prisma.notification
    .deleteMany({ where: { type: { in: readTypes }, id: { notIn: validIds } } })
    .catch(() => ({ count: 0 }));
}

// ── Turlar ──────────────────────────────────────────────────────────────────────────────────

/** HIZLI TUR — bildirim doğuran tek yol budur; kâr hesabına hiç dokunmaz. */
async function scanTick(): Promise<void> {
  if (scanning || dbPaused()) return;
  scanning = true;
  try {
    await ensureRuntimeSchema();
    const orders = await fetchScanOrders();
    if (dbPaused()) return; // ağ çekimi sürerken uyku geldiyse DB'ye dokunma
    const rows: WatchNotification[] = [];
    if (orders.some((o) => o.actionable)) {
      const products = await loadScanProducts(orders);
      rows.push(...buildOrderNotifications(orders, products));
    }
    const inventory = await loadInventory();
    rows.push(...buildInventoryNotifications(inventory));
    await persistNotifications(rows);
    await clearResolvedInventory(inventoryNotificationIds(inventory), inventory.readTypes);
  } catch {
    /* ağ yok / pazaryeri meşgul — sonraki tur dener */
  } finally {
    scanning = false;
  }
}

/** YAVAŞ TUR — Siparişler gövdesini sıcak tutar + bildirim tablosunu budar. */
async function warmTick(): Promise<void> {
  if (warming || dbPaused()) return;
  warming = true;
  try {
    // Gövde bayatsa arka planda tazelenir; taze ise anında döner. Bildirim üretimi artık buna
    // BAĞLI DEĞİL (hızlı tur yapıyor) → burada zorla yeniden hesaplatmaya gerek yok.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30_000);
    try {
      await fetch(`${baseUrl()}/api/orders`, { signal: ctrl.signal, cache: "no-store" });
    } finally {
      clearTimeout(t);
    }

    // Budama (~6 saatte bir): tablo sonsuz büyüyordu + bayat sipariş bildirimleri kalıcı
    // "okunmamış kritik" olarak asılı kalıyordu.
    if (Date.now() - lastPruneAt > 6 * 60 * 60_000) {
      lastPruneAt = Date.now();
      const now = Date.now();
      // 1) Okunmuşlar 30 gün sonra silinir.
      await remotePrisma.notification
        .deleteMany({
          where: { acknowledgedAt: { not: null, lt: new Date(now - 30 * 86_400_000) } },
        })
        .catch(() => {});
      // 2) 7 günden eski sipariş bildirimleri otomatik okundu (aday penceresiyle aynı — sipariş
      //    çoktan kargolandı; sonsuza dek kırmızı rozet üretmesin).
      await remotePrisma.notification
        .updateMany({
          where: {
            type: { in: ["order-stock", "order-made"] },
            acknowledgedAt: null,
            createdAt: { lt: new Date(now - 7 * 86_400_000) },
          },
          data: { acknowledgedAt: new Date() },
        })
        .catch(() => {});
    }
  } catch {
    /* ağ yok / sunucu meşgul — sonraki tur dener */
  } finally {
    warming = false;
  }
}

export function startOrderWatch(): void {
  if (started) return;
  started = true;
  setTimeout(() => { void scanTick(); }, FIRST_SCAN_MS);
  setInterval(() => { void scanTick(); }, SCAN_MS);
  setTimeout(() => { void warmTick(); }, FIRST_WARM_MS);
  setInterval(() => { void warmTick(); }, WARM_MS);
}
