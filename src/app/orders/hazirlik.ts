"use client";

/**
 * Hazırlık listesi çekirdeği — "bugün hangi üründen kaç adet?".
 *
 * Paketleme sırasında sipariş sipariş okumak yerine kalemleri ürün bazında topluyoruz.
 * Saf fonksiyon olarak burada duruyor: sayfa dosyası (page.tsx) Next.js kuralları gereği
 * dışa açık başka bir şey veremez, dolayısıyla davranış testi ancak ayrı bir modülde
 * yazılabiliyor.
 */

export type PrepStatusKind =
  | "pending"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "other";

export interface PrepSourceItem {
  name: string;
  quantity: number;
  image: string | null;
  productId?: string | null;
  madeToOrder?: boolean;
  costMissing?: boolean;
}

export interface PrepSourceOrder {
  orderNumber: string;
  statusKind: PrepStatusKind;
  items: PrepSourceItem[];
}

export interface PrepItem {
  key: string;
  name: string;
  image: string | null;
  productId: string | null;
  quantity: number;
  orderNumbers: string[];
  madeToOrder: boolean;
  costMissing: boolean;
}

/** Henüz gönderilmemiş siparişler hazırlık kapsamındadır. */
export const PREP_STATUSES: PrepStatusKind[] = ["pending", "processing"];

/**
 * Gönderilmeyi bekleyen siparişlerin kalemlerini ürün bazında toplar.
 * Aynı ürün farklı siparişlerde geçtiğinde tek satırda birleşir; ürün eşleşmemişse
 * (productId yok) ada göre gruplanır ki liste yine tek satır göstersin.
 */
export function buildPrepItems(orders: PrepSourceOrder[]): PrepItem[] {
  const rows = new Map<string, PrepItem>();
  for (const order of orders) {
    if (!PREP_STATUSES.includes(order.statusKind)) continue;
    for (const item of order.items ?? []) {
      const name = item.name?.trim() || "Adı olmayan ürün";
      const key = item.productId ? `id:${item.productId}` : `ad:${name.toLowerCase()}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          key,
          name,
          image: item.image ?? null,
          productId: item.productId ?? null,
          quantity: 0,
          orderNumbers: [],
          madeToOrder: false,
          costMissing: false,
        };
        rows.set(key, row);
      }
      // Adet bozuk gelirse kalemi listeden düşürmektense 1 sayarız: eksik paketlemek,
      // fazladan bakmaktan daha kötü.
      const qty = Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : 1;
      row.quantity += qty;
      if (!row.image && item.image) row.image = item.image;
      if (!row.orderNumbers.includes(order.orderNumber)) {
        row.orderNumbers.push(order.orderNumber);
      }
      if (item.madeToOrder) row.madeToOrder = true;
      if (item.costMissing) row.costMissing = true;
    }
  }
  // Çok adetli ürün önce: rafa giderken en çok toplanacak şeyi en üstte gör.
  return [...rows.values()].sort(
    (a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, "tr")
  );
}

/**
 * İşaretlenenler oturum boyunca saklanır (list-state.ts ile aynı desen):
 * sayfa yenilense de kaybolmaz, uygulama kapanınca temizlenir.
 */
export const PREP_DONE_KEY = "mh-list-state:orders-hazirlik";

export function loadPrepDone(): string[] {
  try {
    const raw = sessionStorage.getItem(PREP_DONE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
}

export function savePrepDone(keys: string[]): void {
  try {
    sessionStorage.setItem(PREP_DONE_KEY, JSON.stringify(keys));
  } catch {
    /* kota/gizli mod → işaretler korunmaz, liste yine çalışır */
  }
}
