import { getShopifyOrders } from "@/lib/api/shopify";
import { getTrendyolOrders } from "@/lib/api/trendyol";
import { getHepsiburadaOrders } from "@/lib/api/hepsiburada";
import { orderWindowCutoff } from "@/lib/api/window";
import type { Platform } from "@/lib/platforms";

export interface OrderItem {
  name: string;
  quantity: number;
  unitPrice: number;
  /** ürün eşleştirme için aday anahtarlar (barcode/sku/variant-id). */
  matchKeys: string[];
}

export interface UnifiedOrder {
  id: string;
  platform: Platform;
  orderNumber: string;
  /** Sipariş VERME tarihi (epoch ms). Masaüstüyle birebir: bilinmiyorsa null → listede en alta. */
  date: number | null;
  status: string;
  customer: string | null;
  total: number;
  items: OrderItem[];
}

export interface OrdersResult {
  orders: UnifiedOrder[];
  errors: string[];
}

/** Shopify + Trendyol + Hepsiburada siparişlerini paralel çek, birleştir, tarihe göre sırala. */
export async function getAllOrders(): Promise<OrdersResult> {
  const [sh, ty, hb] = await Promise.allSettled([
    getShopifyOrders(),
    getTrendyolOrders(),
    getHepsiburadaOrders(),
  ]);
  const orders: UnifiedOrder[] = [];
  const errors: string[] = [];

  if (sh.status === "fulfilled") orders.push(...sh.value);
  else errors.push(`Shopify: ${sh.reason?.message ?? sh.reason}`);
  if (ty.status === "fulfilled") orders.push(...ty.value);
  else errors.push(`Trendyol: ${ty.reason?.message ?? ty.reason}`);
  if (hb.status === "fulfilled") orders.push(...hb.value);
  else errors.push(`Hepsiburada: ${hb.reason?.message ?? hb.reason}`);

  // Masaüstü route.ts ile AYNI merkezi kırpma: orderDate'i pencere dışında kalan siparişleri ele.
  // Gerekçe: Trendyol /orders, PackageLastModifiedDate'e göre döndürür → 30+ gün önce VERİLEN ama
  // yakında durumu değişen (ör. Teslim Edildi) siparişler de gelir. "Son 30 gün" = son 30 günde
  // VERİLEN sipariş → orderDate'e göre kırp. cutoff gün başına sabit (iki platform aynı sayıyı
  // göstersin diye). Tarihsizleri tut (HB/Shopify zaten pencere içinde).
  const cutoff = orderWindowCutoff();
  const recent = orders.filter((o) => !o.date || o.date >= cutoff);

  // Tarihsiz (null) siparişler masaüstüyle aynı şekilde EN ALTA düşer.
  recent.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
  return { orders: recent, errors };
}

export type StatusTone = "green" | "orange" | "accent" | "red" | "dim";

const TRENDYOL_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  Created: { label: "Yeni", tone: "orange" },
  Picking: { label: "Hazırlanıyor", tone: "orange" },
  Invoiced: { label: "Faturalı", tone: "orange" },
  Shipped: { label: "Kargoda", tone: "accent" },
  AtCollectionPoint: { label: "Şubede", tone: "accent" },
  Delivered: { label: "Teslim", tone: "green" },
  Cancelled: { label: "İptal", tone: "red" },
  Returned: { label: "İade", tone: "red" },
  UnSupplied: { label: "Tedarik yok", tone: "red" },
  UnDelivered: { label: "Teslim edilemedi", tone: "red" },
  UnPacked: { label: "Bölündü", tone: "red" },
};

const SHOPIFY_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  FULFILLED: { label: "Gönderildi", tone: "green" },
  UNFULFILLED: { label: "Bekliyor", tone: "orange" },
  PARTIALLY_FULFILLED: { label: "Kısmi", tone: "orange" },
  IN_PROGRESS: { label: "Hazırlanıyor", tone: "orange" },
  RESTOCKED: { label: "İade", tone: "red" },
  ON_HOLD: { label: "Beklemede", tone: "orange" },
  REFUNDED: { label: "İade", tone: "red" },
  CANCELLED: { label: "İptal", tone: "red" },
};

// HB ham statüleri (hepsiburada.ts'ten gelen etiketler) → rozet.
const HEPSIBURADA_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  Open: { label: "Yeni", tone: "orange" },
  New: { label: "Yeni", tone: "orange" },
  Packaged: { label: "Hazırlanıyor", tone: "orange" },
  Shipped: { label: "Kargoda", tone: "accent" },
  InTransit: { label: "Yolda", tone: "accent" },
  Delivered: { label: "Teslim", tone: "green" },
  UnDelivered: { label: "Teslim edilemedi", tone: "red" },
  Cancelled: { label: "İptal", tone: "red" },
  CancelledByMerchant: { label: "İptal", tone: "red" },
  CancelledByCustomer: { label: "İptal", tone: "red" },
  Returned: { label: "İade", tone: "red" },
};

export function statusInfo(o: UnifiedOrder): { label: string; tone: StatusTone } {
  const map =
    o.platform === "trendyol"
      ? TRENDYOL_STATUS
      : o.platform === "hepsiburada"
        ? HEPSIBURADA_STATUS
        : SHOPIFY_STATUS;
  return map[o.status] ?? { label: o.status, tone: "dim" };
}

/**
 * Masaüstü orders route.ts'in "cancelled" kind setiyle BİREBİR (iptal/iade/teslim-edilemedi/
 * bölündü/tedarik-yok). Masaüstü özet hesabı bunları atlar (`if statusKind==="cancelled" continue`)
 * → ciro/kâr/sipariş-sayısı yalnızca ciro getiren siparişleri sayar. Mobil de aynısını yapsın ki
 * iki taraf eşleşsin. (Liste yine hepsini gösterir — kırmızı rozetle.)
 */
const CANCELLED_STATUS: Record<Platform, Set<string>> = {
  shopify: new Set(["CANCELLED", "REFUNDED"]),
  trendyol: new Set(["Cancelled", "UnDelivered", "UnPacked", "Returned", "UnSupplied"]),
  hepsiburada: new Set(["UnDelivered", "Cancelled", "CancelledByMerchant", "CancelledByCustomer", "Returned"]),
};

/** Sipariş ciro getirmiyor mu (iptal/iade/teslim-edilemedi)? Özet metriklerinden hariç tutulur. */
export function isCancelledOrder(o: UnifiedOrder): boolean {
  return CANCELLED_STATUS[o.platform]?.has(o.status) ?? false;
}
