import { getShopifyOrders } from "@/lib/api/shopify";
import { getTrendyolOrders } from "@/lib/api/trendyol";

export interface OrderItem {
  name: string;
  quantity: number;
  unitPrice: number;
  /** ürün eşleştirme için aday anahtarlar (barcode/sku/variant-id). */
  matchKeys: string[];
}

export interface UnifiedOrder {
  id: string;
  platform: "shopify" | "trendyol";
  orderNumber: string;
  date: number;
  status: string;
  customer: string | null;
  total: number;
  items: OrderItem[];
}

export interface OrdersResult {
  orders: UnifiedOrder[];
  errors: string[];
}

/** Shopify + Trendyol siparişlerini paralel çek, birleştir, tarihe göre sırala. */
export async function getAllOrders(): Promise<OrdersResult> {
  const [sh, ty] = await Promise.allSettled([getShopifyOrders(), getTrendyolOrders()]);
  const orders: UnifiedOrder[] = [];
  const errors: string[] = [];

  if (sh.status === "fulfilled") orders.push(...sh.value);
  else errors.push(`Shopify: ${sh.reason?.message ?? sh.reason}`);
  if (ty.status === "fulfilled") orders.push(...ty.value);
  else errors.push(`Trendyol: ${ty.reason?.message ?? ty.reason}`);

  orders.sort((a, b) => b.date - a.date);
  return { orders, errors };
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
};

const SHOPIFY_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  FULFILLED: { label: "Gönderildi", tone: "green" },
  UNFULFILLED: { label: "Bekliyor", tone: "orange" },
  PARTIALLY_FULFILLED: { label: "Kısmi", tone: "orange" },
  IN_PROGRESS: { label: "Hazırlanıyor", tone: "orange" },
  RESTOCKED: { label: "İade", tone: "red" },
  ON_HOLD: { label: "Beklemede", tone: "orange" },
};

export function statusInfo(o: UnifiedOrder): { label: string; tone: StatusTone } {
  const map = o.platform === "trendyol" ? TRENDYOL_STATUS : SHOPIFY_STATUS;
  return map[o.status] ?? { label: o.status, tone: "dim" };
}
