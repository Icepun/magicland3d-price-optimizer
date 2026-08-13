/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from "next/server";
import { prisma, remotePrisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import {
  computeOrdersShared,
  getOrdersCache,
  isOrdersRefreshing,
  setOrdersRefreshing,
} from "@/lib/orders-cache";
import { jsonError } from "@/lib/api-error";
import {
  ShopifyClient,
  ShopifyAdminTokenMissingError,
} from "@/services/shopify-client";
import { getShopifyCredentials } from "@/services/shopify-settings";
import { TrendyolClient, type TrendyolOrder } from "@/services/trendyol-client";
import { getTrendyolCredentials } from "@/services/trendyol-settings";
import {
  HepsiburadaClient,
  type HbClaimKind,
} from "@/services/hepsiburada-client";
import { getHepsiburadaCredentials } from "@/services/hepsiburada-settings";
import { resolveProductCost } from "@/core/product-cost";
import { trendyolDateToIso } from "@/core/trendyol-date";
import { buildTrendyolWindows } from "@/lib/trendyol-windows";
import { resolveOrderProfit, type OrderProfitLine } from "@/core/order-profit";
import type { CommissionRuleInput, CargoRuleInput, ExpenseRuleInput } from "@/core/types";
import type { PackagingBreakdown } from "@/core/packaging";
import { pushToAllDevices } from "@/lib/push-notify";
import {
  lastOrderFinanceSnapshotWrite,
  orderFinanceSnapshotWriteInFlight,
  scheduleOrderFinanceSnapshots,
  type FinanceSnapshotItem,
} from "@/lib/order-finance-snapshots";
import { bustFinanceCachesAfterOrderSnapshots } from "@/lib/cache-busting";
import { matchByPriority, uniqueIndex } from "@/lib/listing-index";
import { toDbDate } from "@/lib/sqlite-date";
// Eşleştirme anahtarı sadeleştirmesi TEK yerde: hızlı bildirim taraması da aynısını kullanır,
// iki taraf ayrı kural yazarsa aynı sipariş burada eşleşip orada eşleşmez.
import { normalizeMatchKey } from "@/lib/order-watch";
import { swr } from "@/lib/route-cache";
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
  /**
   * Bu satır kâra GİRMEDİ: ürün hiç eşleşmedi VEYA eşleşti ama maliyeti girilmemiş.
   * Koşul çekirdekle BİREBİR (order-profit.ts: !p || productionCost + packagingCost <= 0) —
   * "N siparişte maliyet eksik" uyarısının satır bazındaki karşılığı. productId varsa
   * kullanıcı doğrudan o ürünün maliyet ekranına gidebilir.
   */
  costMissing?: boolean;
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
  profitSource: "calculated" | "platform" | "manual";
  estimatedCommission: number;
  actualCommission: number | null;
  /** Maliyeti bilinmediği için kâra girmeyen satır sayısı (0 = tam hesap). */
  unmatchedCount?: number;
  /** Desisi olmadığı için kargosu 1 desi varsayılan satır sayısı. */
  missingDesiCount?: number;
  desiEstimated?: boolean;
  orderRevenueAdjustment?: number;
  /** Satıştan doğan (hesaplanan) KDV — kalıcı finans geçmişine taşınır. */
  outputVat?: number | null;
  /** Girdilerden indirilecek KDV — aynı motor çıktısı. */
  inputVatCredit?: number | null;
  trackingNumber: string | null;
  cargoProvider: string | null;
  /**
   * Siparişin kalem/tutar bilgisi platformdan alınamadı. Listede görünür ama ciro/kâr
   * toplamlarına ve finans geçmişine GİRMEZ — yoksa ₺0'lık sahte bir sipariş gibi sayılır.
   */
  dataIncomplete?: boolean;
  /**
   * Pazaryeri tanımadığımız bir durum adı gönderdi. Satış mı iade mi bilmiyoruz → ciro/kâr
   * toplamlarına ve kalıcı finans geçmişine GİRMEZ; listede kalır ve sayısı kullanıcıya
   * gösterilir (BİLİNMEYEN ≠ SIFIR, ama bilinmeyen ≠ satış da değil).
   */
  statusUnknown?: boolean;
  /** Bu siparişte iade/iptal edilmiş kalem sayısı (tutar platformdan geldiği gibi kalır). */
  returnedLineCount?: number;
  isManual?: boolean;
  manualOrderId?: string;
  editHref?: string;
}

interface PlatformStatus {
  ok: boolean;
  count: number;
  needsAdminToken?: boolean;
  /**
   * Bu pazaryeri hiç kurulmamış (kimlik bilgisi yok) — HATA DEĞİL, ayrı durum.
   * ⚠️ Bu bilgi kimlik bilgisi okuma adımından gelir; hata METNİNE bakılarak türetilmez.
   * (Eskiden mesajda "bulunamadı" geçen GERÇEK hatalar da "kurulu değil" sanılıyor ve
   * ekranda tek bir uyarı bile kalmıyordu.)
   */
  notConfigured?: boolean;
  error?: string;
  /**
   * Bu kaynaktan gelen ama bilgisi eksik kalan sipariş sayısı (detayı alınamadı, tek seferde
   * çekilebilecek sınırı aştı ya da manuel kaydı okunamadı). 0/undefined = veri tam.
   */
  incompleteCount?: number;
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
  /** Kalem/tutar bilgisi alınamadığı için ciro/kâr toplamlarına katılmayan siparişler. */
  incompleteDataOrders: number;
  /** Durumu tanınmadığı için toplamların dışında tutulan siparişler. */
  unknownStatusOrders: number;
  /** Hangi durum adı kaç siparişte geldi (kullanıcı bunu bize iletebilsin diye ham adıyla). */
  unknownStatuses: Array<{ status: string; orderCount: number }>;
  /** İçinde iade edilmiş kalem bulunan sipariş sayısı (ciro platformdan geldiği gibi). */
  partialReturnOrders: number;
  /**
   * Verisi ALINAMAYAN kaynakların adları. Boş değilse toplamlar EKSİK bir veriyle
   * hesaplanmıştır — arayüz bunu rakamın yanında açıkça söyler.
   */
  missingSources: string[];
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
  UnDeliveredAndReturned: { kind: "cancelled", label: "İade" },
  // "Paket Bölündü" bir İPTAL DEĞİL: sipariş birden çok pakete ayrılıyor, satış duruyor.
  // İptal kovasında olması hem ciroyu düşürüyor hem satır bazlı iade sayacını yanıltıyordu.
  UnPacked: { kind: "processing", label: "Paket Bölündü" },
  Repack: { kind: "processing", label: "Yeniden Paketleniyor" },
  Returned: { kind: "cancelled", label: "İade" },
  UnSupplied: { kind: "cancelled", label: "Tedarik Edilemedi" },
};

/**
 * Tanımadığımız durum "Diğer" olur ve `unknown` işaretini taşır.
 *
 * 🔴 Eskiden yalnız "Diğer" etiketi verilip sipariş ciroya TAM ekleniyordu: pazaryeri iade
 * anlamına gelen yeni bir durum adı gönderdiğinde iade, ciroda satış gibi duruyordu. Artık
 * bilinmeyen durum toplamlara girmez ve sayısı ekranda görünür.
 */
/**
 * Kimlik bilgisi hatası "kurulu değil" mi, yoksa GERÇEK bir arıza mı?
 *
 * Ayarlar katmanı iki farklı şey için de fırlatıyor: bilgiler hiç girilmemişse ("… eksik")
 * ve girilmiş ama ÇÖZÜLEMİYORSA ("… okunamadi", şifreleme anahtarı değişmiş/bozulmuş).
 * İkincisi sessizce "bağlı değil" sayılırsa hiçbir uyarı çıkmaz ve eksik ciro tam sanılır —
 * bu turda kapatılan hatanın ta kendisi. Yalnız "eksik" kurulmamış sayılır.
 */
function isMissingCredentialError(error: unknown): boolean {
  return /eksik/i.test(error instanceof Error ? error.message : String(error ?? ""));
}

/** Kullanıcıya taşınacak hata metni. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Bilinmeyen hata");
}

function trendyolStatus(s?: string): {
  kind: OrderStatusKind;
  label: string;
  unknown?: boolean;
} {
  if (s && TRENDYOL_STATUS[s]) return TRENDYOL_STATUS[s];
  return { kind: "other", label: s || "Bilinmiyor", unknown: true };
}

/**
 * Satır bazlı iade mi? (Çok kalemli siparişte tek kalemin iadesi.)
 *
 * PAKET durum tablosu KULLANILMAZ: orada "Paket Bölündü" ve "Tedarik Edilemedi" gibi iade
 * OLMAYAN durumlar da var; onlarla yorumlayınca hiç iade olmayan normal siparişlerde
 * "N ürün iade edilmiş" uyarısı çıkıyordu. Yalnız gerçekten iadeyi anlatan satır durumları.
 */
const TRENDYOL_RETURNED_LINE_STATUS = new Set(["Returned", "UnDeliveredAndReturned"]);
function isReturnedLineStatus(status?: string): boolean {
  return Boolean(status && TRENDYOL_RETURNED_LINE_STATUS.has(status));
}

// ── Hepsiburada yardımcıları (yanıt şekli Test'le doğrulanana dek defansif) ──
const HB_STATUS: Record<string, { kind: OrderStatusKind; label: string }> = {
  Open: { kind: "pending", label: "Yeni Sipariş" },
  New: { kind: "pending", label: "Yeni Sipariş" },
  Packaged: { kind: "processing", label: "Paketlendi" },
  ReadyToShip: { kind: "processing", label: "Kargoya Hazır" },
  Shipped: { kind: "shipped", label: "Kargoda" },
  // Aynı duruma iki ad verilmesin: "Yolda" da kargodaki siparişti, ekranda iki farklı
  // isim görünüyordu.
  InTransit: { kind: "shipped", label: "Kargoda" },
  Delivered: { kind: "delivered", label: "Teslim Edildi" },
  UnDelivered: { kind: "cancelled", label: "Teslim Edilemedi" },
  Cancelled: { kind: "cancelled", label: "İptal" },
  CancelledByMerchant: { kind: "cancelled", label: "İptal (Satıcı)" },
  CancelledByCustomer: { kind: "cancelled", label: "İptal (Müşteri)" },
  Returned: { kind: "cancelled", label: "İade" },
};
function hbStatus(s: string): {
  kind: OrderStatusKind;
  label: string;
  unknown?: boolean;
} {
  // Trendyol ile aynı kural: tanımadığımız durum ciroya sessizce giremez.
  return HB_STATUS[s] ?? { kind: "other", label: s || "Bilinmiyor", unknown: true };
}

// Manuel sipariş durumları. Tanımadığımız bir durum daha önce "İptal" etiketiyle görünüyor ama
// ciroya dahil ediliyordu → ekrandaki iki rakam birbirini tutmuyordu. Artık "Diğer" olarak
// gösterilir ve ciroya dahil edilmeye devam eder (yalnız gerçek iptaller dışarıda kalır).
// NOT: Pazaryerlerinin AKSİNE burada bilinmeyen durum toplamdan çıkarılmaz — bu kaydı kullanıcı
// kendi eliyle girdi; onu "belki iadedir" diye ciro dışına almak kendi satışını gizlerdi.
// ⚠️ Etiketler manuel sipariş penceresindeki durum listesiyle AYNI olmak zorunda
// (components/orders/ManualOrderDialog.tsx): kullanıcı orada seçtiği adı burada aynen görmeli.
const MANUAL_STATUS: Record<string, { kind: OrderStatusKind; label: string }> = {
  pending: { kind: "pending", label: "Bekleyen" },
  processing: { kind: "processing", label: "Hazırlanıyor" },
  shipped: { kind: "shipped", label: "Gönderildi" },
  delivered: { kind: "delivered", label: "Teslim Edildi" },
  cancelled: { kind: "cancelled", label: "İptal" },
};
function manualStatus(s: string): { kind: OrderStatusKind; label: string } {
  return MANUAL_STATUS[s] ?? { kind: "other", label: "Diğer" };
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
/**
 * ⚠️ SİPARİŞİN VERİLİŞ ANI — teslim/kargo/iade tarihi DEĞİL.
 *
 * Bu alan hem ekranda "sipariş saati" olarak yazılıyor hem de listenin sıralama ölçütü.
 * Bir yol yanlışlıkla `DeliveredDate`i öne alıyordu: teslim edilmiş Hepsiburada siparişleri
 * "teslim edildiği saatte verilmiş" gibi görünüyor ve kronolojik sırada yanlış yere düşüyordu.
 * Kullanıcı bunu "veriliş saati bazen yanlış geliyor" diye bildirdi ("bazen", çünkü yalnız
 * durum filtreli listeden gelen siparişler etkileniyordu).
 *
 * Kural: ÖNCE sipariş/oluşturulma tarihi; teslim-kargo-iade damgaları ASLA öne alınmaz.
 */
function hbDate(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (v == null || v === "") continue;
    const d = new Date(typeof v === "number" ? v : String(v));
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}
/**
 * Sipariş satırı + ürünlerimizle eşleştirme anahtarları.
 * Anahtarlar TÜRÜNE göre ayrı tutulur: aynı metin bir üründe barkod, başka bir üründe stok kodu
 * olabiliyor. Tür bilgisi olmadan "ilk gelen kazanıyor" ve satır yanlış ürüne bağlanıyordu.
 */
type RawLine = {
  name: string;
  quantity: number;
  unitPrice: number;
  image: string | null;
  barcodes: string[];
  /** Platform ürün/varyant kimliği (Listing.externalId ile eşleşir). */
  externalIds: string[];
  skus: string[];
};

const matchKeyList = (...values: unknown[]): string[] =>
  values.filter((v): v is string => typeof v === "string" && v.trim().length > 0);

/** HB sipariş/detay kalemi → RawLine şekli (tutar + eşleştirme anahtarları). */
function hbLineRaw(li: Record<string, any>): RawLine {
  const qty = Math.max(1, Math.floor(hbNum(li.quantity ?? li.amount ?? 1)));
  const unit = hbNum(li.unitPrice ?? li.price) || (hbNum(li.totalPrice) / qty);
  return {
    name: hbStr(li.productName, li.name, li.title, li.barcode, li.merchantSku) || "Ürün",
    quantity: qty,
    unitPrice: unit,
    image: null,
    barcodes: matchKeyList(li.barcode),
    externalIds: matchKeyList(li.hbSku, li.hepsiburadaSku),
    skus: matchKeyList(li.merchantSku, li.sku, li.stockCode),
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
  // "Hazırlanmadı" aynı durumun ikinci adıydı; her yerde "Bekleyen" kullanılıyor.
  return { kind: "pending", label: "Bekleyen" };
}

interface Matched {
  id: string;
  name: string;
  imageUrl: string | null;
  productionCost: number;
  packagingCost: number;
  packagingComponents: PackagingBreakdown["components"] | null;
  filamentCost: number; // KDV iadesine giren malzeme payı
  /** Üretim maliyeti gerçekten girilmiş mi — paketleme tutarı bunu maskeleyemez. */
  productionCostKnown: boolean;
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
// komisyon/gider değişince bustProfitInputCaches() ile düşürülür (lib/cache-busting). O yardımcı
// products:/dashboard: gövdelerini de düşürür; yalnız burayı düşürmek YETMEZ, çünkü Ürünler ve
// Panel kârı kendi SWR gövdelerinden okur ve o gövdeler diske de yazılır.
const ORDERS_SOFT_MS = 60_000;

// ── Çekim ilerlemesi ────────────────────────────────────────────────────────────────────────
// Üç pazaryeri CANLI çekildiği için bekleme 10-20 saniyeyi bulabiliyor ve ekranda yalnız akan
// bir çizgi vardı: ne kadar kaldığı belli değildi. Burada her kaynak bittikçe durumu işaretlenir;
// arayüz `GET /api/orders?stage=1` ile "3/4 kaynak alındı" diyebiliyor. Bu uç veritabanına ve
// pazaryerlerine HİÇ dokunmaz (yalnız bellekteki durumu okur) → beklerken sorulması bedava.
type OrdersSourceKey = "shopify" | "trendyol" | "hepsiburada" | "manual";
type OrdersSourceState = "pending" | "done" | "error" | "skipped";
const ORDERS_SOURCE_KEYS: OrdersSourceKey[] = [
  "shopify",
  "trendyol",
  "hepsiburada",
  "manual",
];
interface OrdersFetchStage {
  runId: number;
  startedAt: number;
  finishedAt: number | null;
  sources: Record<OrdersSourceKey, { state: OrdersSourceState; count: number }>;
}

function emptyStageSources(): OrdersFetchStage["sources"] {
  return {
    shopify: { state: "pending", count: 0 },
    trendyol: { state: "pending", count: 0 },
    hepsiburada: { state: "pending", count: 0 },
    manual: { state: "pending", count: 0 },
  };
}

let ordersFetchStage: OrdersFetchStage = {
  runId: 0,
  startedAt: 0,
  finishedAt: 0,
  sources: emptyStageSources(),
};

function beginOrdersFetchStage(): number {
  const runId = ordersFetchStage.runId + 1;
  ordersFetchStage = {
    runId,
    startedAt: Date.now(),
    finishedAt: null,
    sources: emptyStageSources(),
  };
  return runId;
}

/** Geç kalan eski bir turun işareti güncel turu bozmasın diye runId karşılaştırılır. */
function markOrdersSource(
  runId: number,
  key: OrdersSourceKey,
  state: OrdersSourceState,
  count = 0
): void {
  if (ordersFetchStage.runId !== runId) return;
  ordersFetchStage.sources[key] = { state, count };
}

function finishOrdersFetchStage(runId: number): void {
  if (ordersFetchStage.runId !== runId) return;
  ordersFetchStage.finishedAt = Date.now();
}

function ordersFetchStageSnapshot() {
  const sources = ORDERS_SOURCE_KEYS.map((key) => ({
    key,
    ...ordersFetchStage.sources[key],
  }));
  return {
    runId: ordersFetchStage.runId,
    active: ordersFetchStage.startedAt > 0 && ordersFetchStage.finishedAt == null,
    startedAt: ordersFetchStage.startedAt || null,
    total: sources.length,
    completed: sources.filter((s) => s.state !== "pending").length,
    sources,
  };
}

// EŞZAMANLI HESAP TEKİLLEŞTİRME + NESİL KORUMASI: Panel, Siparişler, Raporlar ve order-watch
// aynı anda tetikleyebiliyor; hepsi lib/orders-cache içindeki computeOrdersShared'ı paylaşır.
// Burada AYRI bir kopya vardı ve o kopya nesli gözetmiyordu: kullanıcı hesap sürerken kargo/
// komisyon/gider kuralını değiştirip "Yenile"ye bastığında DEVAM EDEN eski hesap dönüyor ve
// önbelleğe de yazılıyordu (doğru rakam için iki kez yenilemek gerekiyordu). Yayınlama kararı
// artık tek yerde: sonuç eskimişse yayınlanmaz, hesap yeni kurallarla baştan koşar.
export async function GET(req: NextRequest) {
  try {
    const params = new URL(req.url).searchParams;
    // Sadece "nerede kaldı" sorusu: bellekteki ilerleme durumu. Veritabanına ve pazaryerlerine
    // dokunmadığı için çekim sürerken saniyede bir sorulabilir.
    if (params.get("stage") === "1") {
      return NextResponse.json(ordersFetchStageSnapshot(), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const fresh = params.get("fresh") === "1";
    const cached = getOrdersCache();
    if (!fresh && cached) {
      if (Date.now() - cached.at > ORDERS_SOFT_MS && !isOrdersRefreshing()) {
        setOrdersRefreshing(true);
        void computeOrdersShared(computeOrdersBody)
          .catch(() => {})
          .finally(() => { setOrdersRefreshing(false); });
      }
      return NextResponse.json(cached.body);
    }
    return NextResponse.json(await computeOrdersShared(computeOrdersBody));
  } catch (error) {
    return jsonError(error);
  }
}

async function computeOrdersBody(): Promise<Record<string, unknown>> {
  const runId = beginOrdersFetchStage();
  try {
    return await computeOrdersBodyInner(runId);
  } finally {
    finishOrdersFetchStage(runId);
  }
}

async function computeOrdersBodyInner(
  runId: number
): Promise<Record<string, unknown>> {
  await ensureRuntimeSchema();

  // Gün başına sabitlenmiş cutoff — mobil (mobile/src/lib/api/window.ts orderWindowCutoff) ile
  // BİREBİR aynı formül. İki uygulama da aynı UTC günü boyunca aynı değeri üretir → sipariş
  // sayısı/ciro/kâr ne zaman yenilenirse yenilensin eşleşir (kayan saniye sınırı yok).
  const cutoff = (Math.floor(Date.now() / 86_400_000) - WINDOW_DAYS) * 86_400_000;
  const historyCutoff =
    (Math.floor(Date.now() / 86_400_000) - HISTORY_SYNC_DAYS) * 86_400_000;
  const orders: UnifiedOrder[] = [];
  // Hata BURADA yakalanır: sonuç ancak pazaryeri çekimi bittikten sonra bekleniyor ve o aralıkta
  // sahipsiz kalan bir reddetme tüm hesabı düşürüyordu.
  type ManualOrderRow = Awaited<
    ReturnType<typeof remotePrisma.manualOrder.findMany>
  >[number];
  const manualOrdersPromise: Promise<{
    rows: ManualOrderRow[];
    error: string | null;
  }> = remotePrisma.manualOrder
    .findMany({
      where: { orderedAt: { gte: new Date(historyCutoff) } },
      orderBy: { orderedAt: "desc" },
    })
    .then((rows) => {
      markOrdersSource(runId, "manual", "done", rows.length);
      return { rows, error: null };
    })
    .catch((error: unknown) => {
      markOrdersSource(runId, "manual", "error");
      return {
        rows: [] as ManualOrderRow[],
        error:
          error instanceof Error ? error.message : "Manuel siparişler okunamadı",
      };
    });
  let shopify: PlatformStatus = { ok: false, count: 0 };
  let trendyol: PlatformStatus = { ok: false, count: 0 };
  let hepsiburada: PlatformStatus = { ok: false, count: 0 };
  // Manuel siparişler de kendi durumunu taşır: okunamayan TEK kayıt yüzünden üç pazaryerinden
  // yeni çekilmiş bütün veriyi çöpe atmıyoruz (aşağıya bkz.).
  let manualSource: PlatformStatus = { ok: true, count: 0 };

  // Ham siparişleri çek (her platform bağımsız) ──────────────────────────────
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
    /** Kalem/tutar bilgisi hiç alınamadı → ciro/kâr toplamlarına ve finans geçmişine girmez. */
    dataIncomplete?: boolean;
    /** Durum adı tanınmadı → toplamlara ve finans geçmişine girmez, sayısı gösterilir. */
    statusUnknown?: boolean;
    /** İade/iptal işaretli kalem sayısı (paket tutarına dokunulmaz). */
    returnedLineCount?: number;
  };
  const raws: Raw[] = [];
  /** Yerel tamponu ana listeye aktar (spread yerine döngü: binlerce satırda argüman sınırı yok). */
  const commitRaws = (rows: Raw[]) => {
    for (const row of rows) raws.push(row);
  };

  // Üç platformu PARALEL çek — toplam gecikme = en yavaş tek platform (sıralı toplam DEĞİL).
  // Bloklar bağımsız: her biri kendi durum değişkenini atar (yarış yok).
  //
  // 🔴 YARIM ÇEKİM = SESSİZ YANLIŞ VERİ: satırlar eskiden döngünün İÇİNDE ortak listeye
  // ekleniyordu. Ortada bir hata olursa platform kartı "alınamadı" derken özette o platformun
  // EKSİK cirosu duruyor, kullanıcı da onu tam sanıyordu. Artık her platform önce kendi yerel
  // tamponunu doldurur; yalnızca çekim SORUNSUZ bittiğinde tampon ortak listeye aktarılır.
  await Promise.all([
   (async () => {
   const buffer: Raw[] = [];
   // Kimlik bilgisi adımı AYRI. Burada "eksik" hatası = kurulu değil; başka her hata (ör.
   // kayıtlı anahtar çözülemiyor) GERÇEK arızadır ve kullanıcıya gösterilir.
   let credentials: Awaited<ReturnType<typeof getShopifyCredentials>>;
   try {
     credentials = await getShopifyCredentials();
   } catch (error) {
     if (isMissingCredentialError(error)) {
       shopify = { ok: false, count: 0, notConfigured: true };
       markOrdersSource(runId, "shopify", "skipped");
     } else {
       shopify = { ok: false, count: 0, error: errorMessage(error) };
       markOrdersSource(runId, "shopify", "error");
     }
     return;
   }
   try {
    const client = new ShopifyClient(credentials);
    // +1 gün: gün-başı historyCutoff'tan biraz daha geniş çek (superset); aşağıdaki
    // historyRows filtresi tam kırpar. Shopify created_at = orderDate.
    const list = await client.listOrders({ sinceDays: HISTORY_SYNC_DAYS + 1, limit: 100 });
    for (const o of list) {
      const st = shopifyStatus(o.fulfillmentStatus, o.financialStatus, Boolean(o.cancelledAt));
      buffer.push({
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
          barcodes: matchKeyList(l.barcode),
          externalIds: matchKeyList(
            l.variantId,
            l.variantId ? `shopify-variant-${l.variantId}` : null
          ),
          skus: matchKeyList(l.variantSku, l.sku),
        })),
        trackingNumber: o.trackingNumber,
        cargoProvider: o.cargoProvider,
        forceProfitPartial:
          o.linesTruncated ||
          (o.financialStatus || "").toUpperCase() === "PARTIALLY_REFUNDED",
      });
    }
    commitRaws(buffer);
    shopify = { ok: true, count: buffer.length };
    markOrdersSource(runId, "shopify", "done", buffer.length);
  } catch (e) {
    if (e instanceof ShopifyAdminTokenMissingError) {
      shopify = { ok: false, count: 0, needsAdminToken: true };
      markOrdersSource(runId, "shopify", "skipped");
    } else {
      shopify = {
        ok: false,
        count: 0,
        error: e instanceof Error ? e.message : "Shopify siparişleri alınamadı",
      };
      markOrdersSource(runId, "shopify", "error");
    }
  }
   })(),
   (async () => {
   const buffer: Raw[] = [];
   let credentials: Awaited<ReturnType<typeof getTrendyolCredentials>>;
   try {
     credentials = await getTrendyolCredentials();
   } catch (error) {
     // "Kurulu değil" ile "kurulu ama OKUNAMIYOR" ayrı şeyler. Kayıtlı anahtar çözülemezse
     // (şifreleme anahtarı değişmiş / dosya bozulmuş) bu GERÇEK bir hatadır: sessizce
     // "bağlı değil" sayılırsa uyarı hiç çıkmaz ve eksik ciro tam sanılır.
     if (isMissingCredentialError(error)) {
       trendyol = { ok: false, count: 0, notConfigured: true };
       markOrdersSource(runId, "trendyol", "skipped");
     } else {
       trendyol = { ok: false, count: 0, error: errorMessage(error) };
       markOrdersSource(runId, "trendyol", "error");
     }
     return;
   }
   try {
    const client = new TrendyolClient(credentials);
    // Trendyol /orders (shipmentPackages): statü filtresi YOK → TÜM statüler (oluşturuldu/kargoda/
    // teslim/iptal) gelir. Ama tek sayfa size:100 son-100'le sınırlıydı → 30 günde 100+ sipariş varsa
    // eksik çekiyordu (kâr yanlış). Çözüm: pencereyi 14 GÜNLÜK dilimlere (Trendyol startDate/endDate
    // aralık limiti ≤2 hafta — AŞILAMAZ) böl + her dilimde sayfala. (Route ayrıca orderDate'e göre
    // görünür pencereye kırpar.)
    //
    // ⏱️ Dilimler BİRBİRİNDEN BAĞIMSIZ: eskiden 60 gün = 5 dilim SIRAYLA çekiliyordu, yani beş ayrı
    // bekleme. Artık aynı anda (sınırlı sayıda) çekiliyorlar; toplam bekleme en yavaş dilime iner.
    // Eşzamanlılık sınırı Trendyol servis limitine takılmamak için bilinçli olarak düşük.
    const TY_WINDOW_CONCURRENCY = 3;
    // Dilim boyu `trendyol-windows.ts`'te hesaplanıyor: saat dilimi payı iki uçtan eklendiği
    // için dilim 14 GÜN OLAMAZ — açıklık sınırı aşar ve Trendyol pencerenin en yeni ucunu
    // sessizce kırpar (bkz. o dosyadaki olay kaydı).
    const tyWindows = buildTrendyolWindows(Date.now(), historyCutoff);
    // Sonuçlar dilim sırasında toplanır (yeni → eski): eşzamanlı çekim listenin sırasını bozmasın.
    const tyByWindow: TrendyolOrder[][] = tyWindows.map(() => []);
    await mapLimit(
      tyWindows.map((_, index) => index),
      TY_WINDOW_CONCURRENCY,
      async (index) => {
        const { startDate, endDate } = tyWindows[index];
        for (let pageNo = 0; pageNo < 50; pageNo++) {
          const page = await client.listOrders({ page: pageNo, size: 100, startDate, endDate });
          const content = page.content ?? [];
          for (const order of content) tyByWindow[index].push(order);
          if (content.length < 100) break; // son sayfa
        }
      }
    );
    const seenTy = new Set<string>();
    for (const [rowIndex, o] of tyByWindow.flat().entries()) {
      const key = String(o.id ?? o.orderNumber ?? "");
      if (key) {
        if (seenTy.has(key)) continue; // pencere sınırı çakışması olursa çift sayma
        seenTy.add(key);
      }
      const st = trendyolStatus(o.status);
      // Çok kalemli siparişte TEK kalemin iadesi paket durumuna yansımıyor: satır
      // durumundan sayılır. Paket tutarının bu durumda ne olduğu doğrulanmadığı için
      // ciroya DOKUNMUYORUZ — yalnız kullanıcıya "bu siparişte iade var" diyoruz.
      const returnedLineCount = (o.lines ?? []).filter((l) =>
        isReturnedLineStatus(l.orderLineItemStatusName)
      ).length;
      buffer.push({
        platform: "trendyol",
        // Kimliksiz satır (beklenmez) yine de tekil kalsın: iki sipariş aynı kimliğe düşerse
        // finans geçmişinde biri diğerini eziyor.
        id: `ty-${o.id ?? o.orderNumber ?? `row-${rowIndex}`}`,
        orderNumber: String(o.orderNumber ?? o.id ?? "—"),
        // Trendyol'un damgası Türkiye duvar saatini taşıyor; gerçek UTC'ye çeviriyoruz.
        // Ham hâliyle arayüz üstüne +3 daha ekleyip siparişleri 3 saat ileri gösteriyordu.
        date: trendyolDateToIso(o.orderDate),
        statusKind: st.kind,
        statusLabel: st.label,
        statusUnknown: st.unknown,
        returnedLineCount: st.kind === "cancelled" ? 0 : returnedLineCount,
        total: Number(o.totalPrice ?? o.grossAmount ?? 0),
        currency: "TRY",
        customer: [o.customerFirstName, o.customerLastName].filter(Boolean).join(" ") || null,
        lines: (o.lines ?? []).map((l) => ({
          name: l.productName ?? l.barcode ?? "Ürün",
          quantity: Number(l.quantity ?? 1),
          unitPrice: Number(l.price ?? 0),
          image: null,
          // Trendyol order satırı barcode verir ("merchantSku" literal'i çöp → ele)
          barcodes: matchKeyList(l.barcode),
          externalIds: [],
          skus: matchKeyList(l.sku, l.merchantSku).filter((k) => k !== "merchantSku"),
        })),
        trackingNumber: o.cargoTrackingNumber ? String(o.cargoTrackingNumber) : null,
        cargoProvider: o.cargoProviderName ?? null,
      });
    }
    // Tüm pencereler ve sayfalar sorunsuz bittiyse ancak o zaman ortak listeye aktar.
    commitRaws(buffer);
    trendyol = { ok: true, count: buffer.length };
    markOrdersSource(runId, "trendyol", "done", buffer.length);
  } catch (e) {
    trendyol = {
      ok: false,
      count: 0,
      error: e instanceof Error ? e.message : "Trendyol siparişleri alınamadı",
    };
    markOrdersSource(runId, "trendyol", "error");
  }
   })(),
   (async () => {
   const buffer: Raw[] = [];
   let credentials: Awaited<ReturnType<typeof getHepsiburadaCredentials>>;
   try {
     credentials = await getHepsiburadaCredentials();
   } catch (error) {
     if (isMissingCredentialError(error)) {
       hepsiburada = { ok: false, count: 0, notConfigured: true };
       markOrdersSource(runId, "hepsiburada", "skipped");
     } else {
       hepsiburada = { ok: false, count: 0, error: errorMessage(error) };
       markOrdersSource(runId, "hepsiburada", "error");
     }
     return;
   }
   try {
    const client = new HepsiburadaClient(credentials);
    // HB siparişleri TEK uçta gelmez: /orders sadece "Open" (paketlenecek) verir; kargoda/teslim
    // siparişler /packages/.../{shipped|delivered|undelivered} ÖZETLERİNDE (tutar YOK) → detay ayrı çekilir.
    type HbAgg = { status: string; date: string | null; customer: string | null; lines: RawLine[] | null };
    const agg = new Map<string, HbAgg>();
    /** Bu turda görülen (sipariş no ↔ paket no) çiftleri — eski paket-anahtarlı satırları temizlemek için. */
    const hbPackageKeyPairs: { orderNo: string; packageNo: string }[] = [];

    // a) Open siparişler — /orders FLAT kalem listesi (orderNumber tekrar eder) → orderNumber'a göre grupla.
    // Bu uç KALEM döndürür, sipariş değil: tek sayfa 100 kalemle sınırlıydı ve 100'den fazlası
    // sessizce düşüyordu. Paket uçlarıyla AYNI sayfalama deseni (offset/limit, boş sayfada dur, üst sınır).
    const openItems: Record<string, any>[] = [];
    for (let off = 0; off < 3000; off += 100) {
      const arr = hbArray(await client.listOrders({ offset: off, limit: 100 }), ["items", "orders", "data", "content", "result"]);
      if (!arr.length) break;
      openItems.push(...(arr as Record<string, any>[]));
      if (arr.length < 100) break;
    }
    for (const li of openItems) {
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
      // Statüsüz /packages ucu = paketlenecek/gönderime-hazır (status "Open" vb.). Bu uç kalem +
      // tutarı `items` içinde TAM verir → detay fetch GEREKMEZ, doğrudan tam sipariş işlenir.
      //
      // 🔴 ÇİFT SAYIM: burada anahtar olarak ÖNCE packageNumber alınıyordu, kargoya verilen
      // siparişlerde ise OrderNumber. Aynı sipariş paketlenirken bir, kargoya verilince başka bir
      // kimlikle kaydediliyor ve OrderFinanceSnapshot'ta İKİ satır oluşuyordu (ciro, kâr ve sipariş
      // sayısı iki kez). Artık iki uçta da GERÇEK sipariş numarası kazanıyor; paket numarası yalnız
      // sipariş numarası hiç gelmediğinde ve sadece iç kimlik olarak kullanılıyor.
      const isFullOrder = statusCode === "";
      for (const p of pkgs) {
        if (isFullOrder) {
          const orderNo = hbStr(p.OrderNumber, p.orderNumber, Array.isArray(p.OrderNumbers) ? p.OrderNumbers[0] : "");
          const packageNo = hbStr(p.packageNumber, p.id);
          const key = orderNo || packageNo;
          if (!key || agg.has(key)) continue;
          // Eski kayıtta paket numarasıyla yazılmış kalıntı satır varsa temizlenebilsin.
          if (orderNo && packageNo && orderNo !== packageNo) hbPackageKeyPairs.push({ orderNo, packageNo });
          agg.set(key, {
            status: hbStr(p.status) || label,
            date: hbDate(p.orderDate, p.CreatedDate, p.PackageReadyDate),
            customer: hbStr(p.recipientName, p.customerName) || null,
            lines: (hbArray(p, ["items", "lines", "orderItems"]) as Record<string, any>[]).map(hbLineRaw),
          });
        } else {
          const on = hbStr(p.OrderNumber, p.orderNumber, Array.isArray(p.OrderNumbers) ? p.OrderNumbers[0] : "");
          if (!on || agg.has(on)) continue;
          agg.set(on, {
            status: label,
            // Veriliş anı: sipariş tarihi > oluşturulma > paket hazır. Teslim/kargo/iade
            // damgaları BİLEREK yok — onlar siparişin verildiği an değil.
            date: hbDate(p.orderDate, p.CreatedDate, p.PackageReadyDate),
            customer: null,
            lines: null,
          });
        }
      }
    }

    // b2) İPTAL ve İADE listeleri. Bunlar HİÇ sorgulanmıyordu: teslim edilmiş bir sipariş
    //     sonradan iade edilince diğer listelerden düşüyor, bizim kalıcı kaydımızda ise
    //     "satıldı" olarak kalıp Raporlar'da sonsuza kadar ciro sayılıyordu.
    //     Uç yolu doğrulanmadığı için istemci hata durumunda null döner → sessizce geçilir.
    const claimKinds: Array<[HbClaimKind, string]> = [
      ["cancelled", "Cancelled"],
      ["returned", "Returned"],
    ];
    const claimResults = await Promise.all(
      claimKinds.map(async ([kind]) => {
        const items: Record<string, any>[] = [];
        try {
          for (let off = 0; off < 3000; off += 100) {
            const page = await client.listClaimPackages(kind, { offset: off, limit: 100 });
            if (page == null) break; // uç yok / geçici hata → bu tur atla
            const arr = hbArray(page, ["items", "data", "content", "result"]);
            if (!arr.length) break;
            items.push(...(arr as Record<string, any>[]));
            if (arr.length < 100) break;
          }
        } catch {
          /* iptal/iade listesi sipariş çekimini ASLA bozmaz */
        }
        return items;
      })
    );
    for (const [idx, rows] of claimResults.entries()) {
      const [, label] = claimKinds[idx];
      for (const p of rows) {
        const on = hbStr(
          p.OrderNumber,
          p.orderNumber,
          Array.isArray(p.OrderNumbers) ? p.OrderNumbers[0] : ""
        );
        if (!on) continue;
        const selfStatus = hbStr(p.status, p.Status, p.packageStatus, p.claimStatus);
        const selfCancelled = selfStatus ? hbStatus(selfStatus).kind === "cancelled" : false;
        const existing = agg.get(on);
        if (existing) {
          // ⚠️ GÜVENLİK FRENİ: sipariş başka listede de görünüyorsa, ancak KAYDIN KENDİ durumu
          // iptal/iade diyorsa ezilir. Uç yolu doğrulanmadığı için "her siparişi döndüren" bir
          // yanıt bütün ciroyu silemesin.
          if (selfCancelled) existing.status = selfStatus;
          continue;
        }
        // Hiçbir aktif listede yok: zaten ciroya girmiyordu. İptal/iade olarak eklenir ki
        // kalıcı kayıttaki eski "satıldı" satırı düzelsin.
        agg.set(on, {
          status: selfCancelled ? selfStatus : label,
          // İade/iptal damgaları siparişin VERİLİŞ anı değil; onlar öne alınırsa iade edilen
          // sipariş "iade tarihinde verilmiş" gibi görünür ve sıralamayı bozar.
          date: hbDate(p.orderDate, p.CreatedDate, p.ClaimDate, p.CancelledDate, p.ReturnDate),
          customer: null,
          lines: null,
        });
      }
    }

    // 30 güne filtrele (tarihsizleri tut) — detay çekmeden ÖNCE (gereksiz detay çağrısı olmasın).
    for (const [on, e] of [...agg]) {
      if (e.date && new Date(e.date).getTime() < historyCutoff) agg.delete(on);
    }

    // c) Tutarı olmayan (özetten gelen) siparişlerin kalem/tutar detayını PARALEL çek (concurrency 8).
    //    Üst sınır 250'ydi ve fazlası SESSİZCE kalemsiz kalıyordu → ₺0 ciroyla özete giriyordu.
    //    Sınır yükseltildi; yine de dışarıda kalan ya da detayı alınamayan sipariş aşağıda
    //    "bilgisi eksik" işaretlenir, özete girmez ve sayısı platform durumuna taşınır.
    //    ⏱️ Teslim edilmiş / iptal / iade siparişlerin detayı BİR DAHA DEĞİŞMEZ. Eskiden her
    //    yenilemede hepsi yeniden indiriliyordu (40 sipariş = 40 istek, her turda). Artık bu
    //    siparişlerin detayı istemcide hatırlanıyor; ikinci yenilemede yalnız yeni/hareketli
    //    siparişler indiriliyor.
    const HB_DETAIL_CAP = 1000;
    const missingDetail = [...agg.entries()].filter(([, e]) => e.lines === null).map(([on]) => on);
    await mapLimit(missingDetail.slice(0, HB_DETAIL_CAP), 8, async (on) => {
      try {
        const kind = hbStatus(agg.get(on)?.status ?? "").kind;
        const settled = kind === "delivered" || kind === "cancelled";
        const d = (await client.getOrderDetail(on, {
          reuseCached: settled,
        })) as Record<string, any>;
        const e = agg.get(on);
        if (!e) return;
        e.lines = (hbArray(d, ["items", "lineItems", "details", "lines", "orderItems"]) as Record<string, any>[]).map(hbLineRaw);
        e.customer = e.customer ?? (hbStr((d.customer ?? {}).name, d.customerName) || null);
        // Sipariş VERME tarihini tercih et (kargo/teslim tarihi değil) → liste + 30g penceresi hep
        // sipariş tarihine göre. Paketten gelen tarih (ShippedDate/DeliveredDate) bununla ezilir.
        const od = hbDate(d.orderDate, d.createdDate);
        if (od) e.date = od;
      } catch { /* detay alınamadı → aşağıda "bilgisi eksik" işaretlenir */ }
    });

    // d) Birleşik satırlar (henüz ortak listeye değil — çekim sorunsuz bitmeden aktarmıyoruz).
    let hbIncomplete = 0;
    for (const [on, e] of agg) {
      const st = hbStatus(e.status);
      const lines = e.lines ?? [];
      // Kalemi hiç gelmediyse tutar da yok: bu sipariş ₺0 gibi görünür ve ciroyu düşük,
      // sipariş sayısını yüksek gösterir. İşaretlenir (listede kalır, özete/finans geçmişine girmez).
      // Boş kalem listesi de aynı sonucu doğurur — gerçek bir siparişin sıfır kalemi olmaz.
      const dataIncomplete = lines.length === 0;
      if (dataIncomplete) hbIncomplete++;
      buffer.push({
        platform: "hepsiburada",
        id: `hb-${on}`,
        orderNumber: on,
        date: e.date,
        statusKind: st.kind,
        statusLabel: st.label,
        statusUnknown: st.unknown,
        total: lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0),
        currency: "TRY",
        customer: e.customer,
        lines,
        trackingNumber: null,
        cargoProvider: null,
        dataIncomplete,
      });
    }
    // e) Anahtar değişiminden kalan kalıntı satırları temizle. Eskiden aynı sipariş paketlenirken
    //    paket numarasıyla, kargoya verilince sipariş numarasıyla kaydediliyordu → finans geçmişinde
    //    İKİ satır. Paket↔sipariş eşleşmesini SADECE gerçek veriden bildiğimiz için silme kesin:
    //    tahmin yok, yalnız bu turda ikisini birden gördüğümüz siparişler temizlenir.
    //    (Görünür pencerenin dışında kalan daha eski çiftler bu yolla eşleştirilemez.)
    const staleIds = hbPackageKeyPairs.map((p) => `hb-${p.packageNo}`);
    if (staleIds.length) {
      for (let i = 0; i < staleIds.length; i += 200) {
        await prisma.orderFinanceSnapshot
          .deleteMany({
            where: { platform: "hepsiburada", externalOrderId: { in: staleIds.slice(i, i + 200) } },
          })
          .catch(() => {
            /* temizlik siparişleri getirmeyi ASLA bozmamalı */
          });
      }
    }
    // f) Çekim sorunsuz bitti → ancak şimdi ortak listeye aktar ve durumu yaz.
    commitRaws(buffer);
    hepsiburada = { ok: true, count: buffer.length, incompleteCount: hbIncomplete };
    markOrdersSource(runId, "hepsiburada", "done", buffer.length);
  } catch (e) {
    hepsiburada = {
      ok: false,
      count: 0,
      error: e instanceof Error ? e.message : "Hepsiburada siparişleri alınamadı",
    };
    markOrdersSource(runId, "hepsiburada", "error");
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
      for (const k of [...l.barcodes, ...l.externalIds, ...l.skus]) allKeys.add(k);
      if (r.platform === "shopify" && l.name) shopifyNames.add(l.name);
    }
  }

  // Anahtar indeksleri TÜR BAZINDA ayrı: aynı metin bir üründe barkod, başkasında stok kodu
  // olabiliyor. Tek harita kullanıldığında "ilk gelen kazanıyor" ve sipariş satırı yanlış ürüne —
  // dolayısıyla yanlış maliyete — bağlanıyordu. Aynı anahtar birden çok ürüne düşerse o anahtar
  // BELİRSİZ sayılır ve hiç kullanılmaz (uniqueIndex bunu kendisi yapar).
  type KeyEntry = { key: string; product: Matched };
  type KeyIndex = Map<string, KeyEntry>;
  let productBarcodeIndex: KeyIndex = new Map();
  let listingBarcodeIndex: KeyIndex = new Map();
  let listingExternalIdIndex: KeyIndex = new Map();
  let listingSkuIndex: KeyIndex = new Map();
  let productSkuIndex: KeyIndex = new Map();
  let anyKeyIndex: KeyIndex = new Map();
  let nameIndex: KeyIndex = new Map();
  let commissionRules: CommissionRules = [];
  let cargoRules: CargoRules = [];
  let expenseRules: ExpenseRules = [];
  type PlatformFinancial = {
    externalOrderId: string;
    orderNumber: string;
    grossRevenueKurus: number;
    commissionKurus: number;
  };
  const financialByExternalId = new Map<string, PlatformFinancial>();
  const financialByOrderNumber = new Map<string, PlatformFinancial[]>();
  const trendyolOrderNumberCounts = new Map<string, number>();
  for (const row of historyRows) {
    if (row.platform !== "trendyol") continue;
    trendyolOrderNumberCounts.set(
      row.orderNumber,
      (trendyolOrderNumberCounts.get(row.orderNumber) ?? 0) + 1
    );
  }
  // Shopify global komisyon oranı resolveListingCommissionOverride içinde buradan okunur → dış kapsam.
  let settingsMap: Record<string, string | undefined> = {};

  if (allKeys.size > 0 || shopifyNames.size > 0) {
    const keyList = [...allKeys];
    const normalizedShopifyNames = new Set(
      [...shopifyNames].map(normalizeMatchKey).filter(Boolean)
    );
    const wantedKeys = new Set([...allKeys].map(normalizeMatchKey).filter(Boolean));
    // SQLite/Prisma `... IN (...)` ham büyük-küçük harf ve boşluk farklarını kaçırıyordu: ürün hiç
    // ÇEKİLMEDİĞİ için sonradan sadeleştirmek de kurtarmıyordu. Önce küçük bir ad/anahtar dizini
    // tarayıp eşleşen ürün kimliklerini çıkarıyoruz. Bu tarama her sipariş hesabında (arka plan
    // tazelemeleri dahil) tekrarlanıyordu; ürün anahtarları nadir değişir → kısa ömürlü SWR +
    // ürün PATCH'inde bust (bkz. products/[id] route).
    const catalog = await swr("order-name-index:v2", 5 * 60_000, () =>
      prisma.product.findMany({
        select: {
          id: true,
          name: true,
          barcode: true,
          sku: true,
          listings: { select: { externalId: true, externalSku: true, barcode: true } },
        },
      })
    );
    const preselectedIds = new Set<string>();
    for (const product of catalog) {
      const normalizedName = normalizeMatchKey(product.name);
      if (normalizedName && normalizedShopifyNames.has(normalizedName)) {
        preselectedIds.add(product.id);
        continue;
      }
      const productKeys = [
        product.barcode,
        product.sku,
        ...(product.listings ?? []).flatMap((listing) => [
          listing.externalId,
          listing.externalSku,
          listing.barcode,
        ]),
      ];
      if (
        productKeys.some((key) => {
          const normalized = normalizeMatchKey(key);
          return normalized !== "" && wantedKeys.has(normalized);
        })
      ) {
        preselectedIds.add(product.id);
      }
    }
    const nameMatchedIds = [...preselectedIds];
    const trendyolRows = historyRows.filter((row) => row.platform === "trendyol");
    const [products, cRules, kRules, eRules, settings, platformFinancials] =
      await Promise.all([
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
      prisma.platformOrderFinancial.findMany({
        where: {
          platform: "trendyol",
          OR: [
            { externalOrderId: { in: trendyolRows.map((row) => row.id) } },
            { orderNumber: { in: trendyolRows.map((row) => row.orderNumber) } },
          ],
        },
        select: {
          externalOrderId: true,
          orderNumber: true,
          grossRevenueKurus: true,
          commissionKurus: true,
        },
      }),
    ]);

    settingsMap = Object.fromEntries(settings.map((s) => [s.key, s.value]));
    commissionRules = cRules as CommissionRules;
    cargoRules = kRules as CargoRules;
    expenseRules = eRules as ExpenseRules;
    for (const financial of platformFinancials) {
      financialByExternalId.set(financial.externalOrderId, financial);
      const rows = financialByOrderNumber.get(financial.orderNumber) ?? [];
      rows.push(financial);
      financialByOrderNumber.set(financial.orderNumber, rows);
    }

    // Her anahtar türü kendi kovasına düşer; aynı ürün aynı anahtarı iki kez verirse (ör. ürün
    // barkodu = ilan barkodu) tekrar sayılmaz, yoksa kendi kendine "belirsiz" görünürdü.
    const makeBucket = () => ({ entries: [] as KeyEntry[], seen: new Set<string>() });
    const buckets = {
      productBarcode: makeBucket(),
      listingBarcode: makeBucket(),
      listingExternalId: makeBucket(),
      listingSku: makeBucket(),
      productSku: makeBucket(),
      any: makeBucket(),
      name: makeBucket(),
    };
    const addKey = (
      bucket: ReturnType<typeof makeBucket>,
      raw: string | null | undefined,
      product: Matched,
      alsoAny = true
    ) => {
      const key = normalizeMatchKey(raw);
      if (!key) return;
      const dedupe = `${key}\u0000${product.id}`;
      if (!bucket.seen.has(dedupe)) {
        bucket.seen.add(dedupe);
        bucket.entries.push({ key, product });
      }
      if (alsoAny && !buckets.any.seen.has(dedupe)) {
        buckets.any.seen.add(dedupe);
        buckets.any.entries.push({ key, product });
      }
    };

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
        productionCostKnown: resolved?.productionCostKnown ?? false,
        categoryName: p.categoryName,
        desi: p.desi,
        commissionRate: p.commissionRate,
        madeToOrder: p.madeToOrder,
        stock: p.stock,
        listingByPlatform,
      };
      addKey(buckets.productBarcode, p.barcode, m);
      addKey(buckets.productSku, p.sku, m);
      for (const l of p.listings) {
        addKey(buckets.listingBarcode, l.barcode, m); // platform-bazlı barkod
        addKey(buckets.listingExternalId, l.externalId, m);
        addKey(buckets.listingSku, l.externalSku, m);
      }
      // Shopify ad-eşleştirme: aynı ad birden çok üründeyse belirsiz → hiç eşleştirilmez.
      addKey(buckets.name, p.name, m, false);
    }

    productBarcodeIndex = uniqueIndex(buckets.productBarcode.entries, (e) => e.key);
    listingBarcodeIndex = uniqueIndex(buckets.listingBarcode.entries, (e) => e.key);
    listingExternalIdIndex = uniqueIndex(buckets.listingExternalId.entries, (e) => e.key);
    listingSkuIndex = uniqueIndex(buckets.listingSku.entries, (e) => e.key);
    productSkuIndex = uniqueIndex(buckets.productSku.entries, (e) => e.key);
    anyKeyIndex = uniqueIndex(buckets.any.entries, (e) => e.key);
    nameIndex = uniqueIndex(buckets.name.entries, (e) => e.key);
  }

  /**
   * Sipariş satırını ürünle eşleştir. Sıra = GÜVEN sırası: ürün barkodu > ilan barkodu >
   * platform kimliği > stok kodu. En son çare, anahtarın türü platformda karışmış olabileceği
   * için tür ayrımı olmayan indekstir. Belirsiz (birden çok ürüne düşen) anahtar hiç kullanılmaz.
   */
  const matchLine = (line: RawLine, platform: string): Matched | null => {
    const candidates: Array<readonly [string | null | undefined, KeyIndex]> = [];
    const addCandidates = (values: string[], index: KeyIndex) => {
      for (const value of values) candidates.push([normalizeMatchKey(value), index]);
    };
    addCandidates(line.barcodes, productBarcodeIndex);
    addCandidates(line.barcodes, listingBarcodeIndex);
    addCandidates(line.externalIds, listingExternalIdIndex);
    addCandidates(line.skus, listingSkuIndex);
    addCandidates(line.skus, productSkuIndex);
    addCandidates([...line.barcodes, ...line.externalIds, ...line.skus], anyKeyIndex);
    // Shopify barkod taşımaz → son çare ürün adı.
    if (platform === "shopify") candidates.push([normalizeMatchKey(line.name), nameIndex]);
    return matchByPriority(candidates)?.product ?? null;
  };

  // NOT: Sipariş kârının TAMAMI @/core/order-profit → computeOrderProfit içinde (masaüstü + mobil
  // AYNI fonksiyon). Adet başına: ürün/paketleme/komisyon/yüzdesel gider. Siparişe BİR KEZ: kargo +
  // SABİT gider (Platform Hizmet Bedeli — kullanıcı teyidi: sipariş başına kesiliyor).

  // Olay-anı bildirim adayları (stoğu biten / sipariş-üzerine ürüne sipariş).
  // Sadece AKSİYON gereken (pending/processing) + SON 7 GÜN siparişler → tekilleştirilmiş.
  const PLATFORM_LABEL: Record<string, string> = { shopify: "Shopify", trendyol: "Trendyol", hepsiburada: "Hepsiburada" };
  const notifCutoff = Date.now() - 7 * 86_400_000;
  const notifs: { id: string; type: string; severity: string; title: string; body: string; href: string }[] = [];

  // Sipariş kimliği → kalemleri (kalıcı ürün bazlı satış geçmişine yazılacak).
  const snapshotItemsByOrderId = new Map<string, FinanceSnapshotItem[]>();

  // Zenginleştirilmiş birleşik siparişler ───────────────────────────────────
  for (const r of historyRows) {
    const actionable =
      (r.statusKind === "pending" || r.statusKind === "processing") &&
      (!r.date || new Date(r.date).getTime() >= notifCutoff);
    let thumb: string | null = null;
    const profitLines: OrderProfitLine[] = [];
    // Ürün bazlı satış geçmişi için kalemler (kalıcı kaydedilir — pazaryeri penceresi dolsa da kalır).
    const snapshotItems: FinanceSnapshotItem[] = [];
    const items: UnifiedOrderItem[] = r.lines.map((l) => {
      const m = matchLine(l, r.platform);
      const image = l.image || m?.imageUrl || null;
      if (image && !thumb) thumb = image;

      snapshotItems.push({
        productId: m?.id ?? null,
        productName: m?.name || l.name,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
      });

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
              productionCostKnown: m.productionCostKnown,
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
        // Çekirdekteki "kâra girmez" koşulunun aynısı (order-profit.ts).
        costMissing: !m || !m.productionCostKnown,
      };
    });

    // Kâr hesabının TAMAMI çekirdekte (masaüstü + mobil aynı fonksiyon): adet başına ürün/
    // komisyon/yüzdesel gider; siparişe BİR KEZ kargo + SABİT gider (Platform Hizmet Bedeli).
    let platformFinancial =
      r.platform === "trendyol"
        ? financialByExternalId.get(r.id) ?? null
        : null;
    // Eski/eksik settlement kayıtlarında shipmentPackageId gelmeyebilir. Aynı sipariş
    // numarası hem sipariş listesinde hem finans tablosunda TEKİLSE güvenli fallback yap.
    if (
      !platformFinancial &&
      r.platform === "trendyol" &&
      trendyolOrderNumberCounts.get(r.orderNumber) === 1
    ) {
      const candidates = financialByOrderNumber.get(r.orderNumber) ?? [];
      if (candidates.length === 1) platformFinancial = candidates[0];
    }
    // Kâr hesabının TAMAMI çekirdekte (masaüstü + mobil AYNI fonksiyon) — kural-tabanlı kâr
    // + Trendyol gerçek komisyonu düzeltmesi tek yerde.
    const pr = resolveOrderProfit(
      {
        platform: r.platform,
        orderTotal: r.total,
        lines: profitLines,
        commissionRules,
        cargoRules,
        expenseRules,
        settings: settingsMap,
      },
      {
        forceProfitPartial: Boolean(r.forceProfitPartial),
        statusKind: r.statusKind,
        financial: platformFinancial
          ? {
              actualCommission: kurusToTl(platformFinancial.commissionKurus),
              settlementRevenue: kurusToTl(platformFinancial.grossRevenueKurus),
            }
          : null,
      }
    );
    const profitPartial = pr.profitPartial;

    snapshotItemsByOrderId.set(r.id, snapshotItems);
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
      profitPartial,
      profitSource: pr.profitSource,
      estimatedCommission: pr.estimatedCommission,
      actualCommission: pr.actualCommission,
      unmatchedCount: pr.unmatchedLines,
      missingDesiCount: pr.missingDesiLines,
      desiEstimated: pr.desiEstimated,
      orderRevenueAdjustment: pr.orderRevenueAdjustment,
      // KDV motorun çıktısından aynen taşınır — snapshot'a yazılıp aylık özete girer.
      outputVat: pr.outputVat,
      inputVatCredit: pr.inputVatCredit,
      trackingNumber: r.trackingNumber,
      cargoProvider: r.cargoProvider,
      dataIncomplete: r.dataIncomplete,
      statusUnknown: r.statusUnknown,
      returnedLineCount: r.returnedLineCount,
    });
  }

  // Manuel siparişler kendi kalıcı finans snapshot'larını aynı ManualOrder satırında taşır.
  // Platform siparişlerinin canlı hesap hattına veya OrderFinanceSnapshot'a sokulmazlar.
  //
  // 🔴 TEK BOZUK KAYIT HER ŞEYİ ÇÖPE ATIYORDU: bu okuma hata verdiğinde (bağlantı düştü ya da
  // tek bir kaydın JSON'u bozuk) tüm hesap patlıyor, üç pazaryerinden 1-3 saniyede yeni çekilmiş
  // BÜTÜN veri kayboluyordu. Artık manuel kaynak atlanır, siparişler listelenmeye devam eder ve
  // kullanıcıya kısa bir uyarı taşınır.
  const manualRead = await manualOrdersPromise;
  const manualOrders = manualRead.rows;
  if (manualRead.error) {
    console.error("[manual-order] liste okunamadı:", manualRead.error);
    manualSource = { ok: false, count: 0, error: manualRead.error };
  }
  /** Kaydı bozuk olduğu için listeye alınamayan manuel sipariş sayısı. */
  let manualSkipped = 0;
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
        statusKind: manualStatus(manual.statusKind).kind,
        statusLabel: manualStatus(manual.statusKind).label,
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
        profitSource: "manual",
        estimatedCommission: storedBreakdown.commissionCost,
        actualCommission: null,
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
      manualSkipped += 1;
      console.error(
        `[manual-order] ${manual.id} okunamadı:`,
        error instanceof Error ? error.message : error
      );
    }
  }
  if (manualSource.ok) {
    manualSource = {
      ok: true,
      count: manualOrders.length - manualSkipped,
      incompleteCount: manualSkipped,
    };
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
        // createdAt AÇIKÇA yazılır. Kolon boş bırakılınca SQLite'ın DEFAULT CURRENT_TIMESTAMP
        // değeri giriyordu: "2026-08-13 07:00:00" — Prisma'nın yazdığı ISO biçimden FARKLI bir
        // metin. Metin sıralamasında boşluk 'T'den küçük olduğu için karışık kolonda zil
        // sıralaması ve tarih filtreleri sessizce yanlış sonuç veriyordu (ölçüm: 734 satır).
        const simdi = toDbDate(new Date());
        const placeholders = fresh.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
        const params = fresh.flatMap((n) => [n.id, n.type, n.severity, n.title, n.body, n.href, simdi]);
        await prisma.$executeRawUnsafe(
          `INSERT OR IGNORE INTO "Notification" ("id","type","severity","title","body","href","createdAt") VALUES ${placeholders}`,
          ...params
        );
        // Telefona yalnız SİPARİŞ olayları düşer (kullanıcı kararı: stok/filament uyarıları
        // zilde kalsın, telefonu meşgul etmesin). Bu blok zaten yalnız sipariş bildirimi
        // üretiyor; koşul ileride başka tür eklenirse sessizce push'a dönüşmesin diye açık.
        const PUSHABLE = new Set(["order-stock", "order-made"]);
        for (const n of fresh.filter((f) => f.severity === "critical" && PUSHABLE.has(f.type))) {
          await pushToAllDevices(n.title, n.body).catch(() => {});
        }
      } catch { /* tablo yoksa/yazma hatası → sessiz geç */ }
    })();
  }

  // En yeni üstte. Tarihi olmayan/okunamayan sipariş EN ALTA düşer (0), yukarı sızmaz.
  // Geçersiz tarih NaN üretip karşılaştırmayı bozuyordu; eşit zaman damgalarında ikincil
  // ölçüt olmadığı için de sıra her yenilemede oynayabiliyordu — ikisi de kapatıldı.
  const zaman = (d: string | null): number => {
    if (!d) return 0;
    const t = new Date(d).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  orders.sort((a, b) => {
    const fark = zaman(b.date) - zaman(a.date);
    if (fark !== 0) return fark;
    // Aynı saniyeye düşen siparişlerde sabit sıra: numara (yoksa kimlik).
    return (b.orderNumber || b.id).localeCompare(a.orderNumber || a.id, "tr-TR");
  });

  // Canlı 30 günlük pencereyi kalıcı finans geçmişine işle. Bu kayıtlar sonraki aylarda
  // platform API'sinin penceresinden çıksa da raporların geçmişini korur. Finans geçmişi
  // yazılamazsa sipariş ekranını bozmayız; sonraki senkron yeniden dener.
  let financeHistory: {
    ok: boolean;
    syncedOrders: number;
    syncDays: number;
    /** Yazım şu an arka planda sürüyor mu (sonuç bir sonraki yenilemede kesinleşir). */
    pending?: boolean;
    error?: string;
  };
  // Bilgisi eksik gelen sipariş finans geçmişine YAZILMAZ: ₺0 ciro/kâr olarak kaydedilirse
  // sonraki aylarda düzeltilemeyen sahte bir satır kalır. Bir önceki turda doğru yazılmış
  // kayıt varsa olduğu gibi korunur; bilgi tamamlandığında normal akışta güncellenir.
  //
  // İKİ İSTİSNA:
  //  • İPTAL/İADE: tutarı okunamasa bile "bu sipariş iptal/iade" bilgisi yazılır — yoksa
  //    kalıcı kayıt "satıldı"da kalır ve iade sonsuza kadar ciro sayılır (raporlar iptalleri
  //    tutarına bakmadan eler, o yüzden eksik tutar zarar vermez).
  //  • DURUMU TANINMAYAN sipariş hiç yazılmaz: satış mı iade mi bilmiyoruz.
  const persistableOrders = orders.filter(
    (order) =>
      !order.statusUnknown &&
      (!order.dataIncomplete || order.statusKind === "cancelled")
  );
  try {
    // Finans geçmişi yazımı YANIT YOLUNDA DEĞİL: ilk dolumda veya toplu statü değişiminde
    // yüzlerce satır yazılıyor ve uzak-HTTP tek mutex'inde uygulama yarım dakika kilitleniyordu.
    // "Ateşle ve unut" — çağıran beklemez, hata fırlatmaz, aynı anda tek tur çalışır.
    scheduleOrderFinanceSnapshots(persistableOrders, snapshotItemsByOrderId);
    // Yazım bitince finans önbelleğini düşür → yeni sipariş "Ciro (bu ay)" ve "Net kâr (bu ay)"
    // kartlarına AYNI görüntülemede yansısın (eskiden sayfadan çıkıp girmek gerekiyordu).
    // Beklemiyoruz: yanıt anında gider, düşürme yazım tamamlanınca arkada olur. Hiçbir şey
    // yazılmadıysa (turların çoğu) önbellek KORUNUR — ayrıntı: lib/cache-busting.ts.
    void bustFinanceCachesAfterOrderSnapshots();
    // 🔴 UYARI HİÇ ÇIKAMIYORDU: yazım arka plana alındığından bu blok her zaman "başarılı"
    // diyordu ve "Finans geçmişi kaydedilemedi" uyarısı hiçbir koşulda görünmüyordu. Artık
    // SON TAMAMLANAN turun gerçek sonucu taşınır (yazım sürüyorsa "pending").
    const lastWrite = lastOrderFinanceSnapshotWrite();
    financeHistory = {
      ok: lastWrite?.ok ?? true,
      syncedOrders: persistableOrders.filter(
        (order) => order.platform !== "manual" && Boolean(order.date)
      ).length,
      syncDays: HISTORY_SYNC_DAYS,
      pending: orderFinanceSnapshotWriteInFlight(),
      ...(lastWrite && !lastWrite.ok
        ? { error: lastWrite.error ?? "Sipariş finans geçmişi kaydedilemedi." }
        : {}),
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
  const unknownStatuses = new Map<string, number>();
  let incompleteDataOrders = 0;
  let partialReturnOrders = 0;
  for (const o of visibleOrders) {
    if (o.statusKind === "cancelled") continue;
    // Kalem/tutar bilgisi alınamamış sipariş toplamlara ₺0 ekler ve ciroyu olduğundan düşük,
    // sipariş sayısını olduğundan yüksek gösterir. Listede kalır, özet dışında tutulur.
    if (o.dataIncomplete) {
      incompleteDataOrders += 1;
      continue;
    }
    // Durumu tanımadığımız sipariş satış da olabilir iade de. Toplama eklemek "iade sayıldı"
    // riskini sessizce taşıyordu; artık ayrı sayılır ve ekranda ham durum adıyla görünür.
    if (o.statusUnknown) {
      unknownStatuses.set(o.statusLabel, (unknownStatuses.get(o.statusLabel) ?? 0) + 1);
      continue;
    }
    if ((o.returnedLineCount ?? 0) > 0) partialReturnOrders += 1;
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
  // Verisi ALINAMAYAN kaynaklar. "Kurulu değil" bu listeye girmez — o bir eksiklik değil,
  // kullanıcının tercihi. Toplamların yanındaki "eksik veri" işareti bundan üretilir.
  const missingSources = (
    [
      [shopify, "Shopify"],
      [trendyol, "Trendyol"],
      [hepsiburada, "Hepsiburada"],
      [manualSource, "Manuel siparişler"],
    ] as Array<[PlatformStatus, string]>
  )
    .filter(([status]) => !status.ok && !status.notConfigured)
    .map(([, label]) => label);

  const quality: SummaryQuality = {
    unsupportedCurrencyOrders: [...unsupportedCurrencies.values()].reduce(
      (sum, count) => sum + count,
      0
    ),
    unsupportedCurrencies: [...unsupportedCurrencies.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, orderCount]) => ({ currency, orderCount })),
    incompleteDataOrders,
    unknownStatusOrders: [...unknownStatuses.values()].reduce((sum, count) => sum + count, 0),
    unknownStatuses: [...unknownStatuses.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, orderCount]) => ({ status, orderCount })),
    partialReturnOrders,
    missingSources,
  };

  return {
    // 🔴 EKSİK SONUÇ DAMGALANIR: bu gövde önbelleğe VE diske yazılıyor. Damga olmadan bir
    // pazaryeri alınamamışken hesaplanan yarım ciro, sonraki açılışta "tam" sanılıyordu.
    dataComplete: missingSources.length === 0,
    // Bu verinin hesaplandığı an — arayüz "X dakika önce güncellendi" bilgisini bundan üretir
    // (önbellekten dönen yanıt da kendi hesap zamanını taşır).
    computedAt: new Date().toISOString(),
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
    manual: manualSource,
    financeHistory,
  };
}
