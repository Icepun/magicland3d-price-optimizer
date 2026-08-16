import {
  HEPSIBURADA_STATUS_KINDS,
  MANUAL_STATUS_KINDS,
  SHOPIFY_STATUS_KINDS,
  TRENDYOL_STATUS_KINDS,
} from "@core/order-status-kind";
import { buildPrepItems, type PrepItem, type PrepSourceOrder, type PrepStatusKind } from "@core/prep-list";
import type { UnifiedOrder } from "@/lib/api/orders";

/**
 * Telefonun hazırlık listesi — masaüstündeki "Hazırlık" sekmesinin AYNISI.
 *
 * Gruplama ve durum kovaları ortak çekirdekten (`@core/prep-list`, `@core/order-status-kind`)
 * geliyor: iki cihaz aynı siparişleri kapsama alır ve aynı adetleri gösterir. Burada kalan tek
 * iş, telefonun sipariş şeklini çekirdeğin beklediği şekle çevirmek.
 */

/** Ham platform durumunu ortak kovaya çevir. Tanımadığımız durum listeye GİRMEZ ("other"). */
export function orderPrepKind(o: UnifiedOrder): PrepStatusKind {
  if (o.platform === "manual") return MANUAL_STATUS_KINDS[o.status]?.kind ?? "other";
  if (o.platform === "trendyol") return TRENDYOL_STATUS_KINDS[o.status]?.kind ?? "other";
  if (o.platform === "hepsiburada") return HEPSIBURADA_STATUS_KINDS[o.status]?.kind ?? "other";
  return SHOPIFY_STATUS_KINDS[(o.status || "").toUpperCase()] ?? "other";
}

/**
 * Siparişleri hazırlık satırlarına çevir.
 * `urunler`: ürün id → görsel eşlemesi. Sipariş kaleminin kendi görseli yoksa ürün kartındaki
 * fotoğraf kullanılır — rafta ürünü ada göre değil, GÖRSELE bakarak buluyoruz.
 */
export function prepItemsFromOrders(
  orders: UnifiedOrder[],
  urunler?: { id: string; imageUrl?: string | null; madeToOrder?: number }[]
): PrepItem[] {
  const gorsel = new Map<string, string | null>();
  const siparisUzerine = new Set<string>();
  for (const p of urunler ?? []) {
    gorsel.set(p.id, p.imageUrl ?? null);
    if (p.madeToOrder) siparisUzerine.add(p.id);
  }

  const kaynak: PrepSourceOrder[] = orders.map((o) => ({
    orderNumber: o.orderNumber,
    statusKind: orderPrepKind(o),
    items: o.items.map((it) => ({
      name: it.name,
      quantity: it.quantity,
      image: it.image ?? (it.productId ? (gorsel.get(it.productId) ?? null) : null),
      productId: it.productId ?? null,
      madeToOrder: it.productId ? siparisUzerine.has(it.productId) : false,
    })),
  }));
  return buildPrepItems(kaynak);
}
