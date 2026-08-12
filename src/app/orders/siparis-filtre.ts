"use client";

/**
 * Sipariş listesinin filtreleri ve sayaçları — TEK kaynak.
 *
 * Neden ayrı dosya: sayfa dosyası (page.tsx) Next.js kuralları gereği sayfa bileşeni dışında
 * bir şey dışa açamaz; bu kurallar ancak ayrı bir modülde test edilebiliyor (hazirlik.ts ile
 * aynı gerekçe).
 *
 * 🔴 EKRANDAKİ İKİ RAKAM BİRBİRİNİ TUTMUYORDU: durum çipleri HAM listeden, üstteki özet ise
 * kendi kümesinden (iptal + bilgisi eksik + TRY dışı siparişler elenmiş) sayıyordu. "Hepsi 223"
 * derken alt çiplerin toplamı 126 çıkıyor, "2 siparişte maliyet eksik" bağlantısı 5 sipariş
 * açıyordu. Artık liste, çipler ve o bağlantı AYNI fonksiyonlardan geçer.
 */

export type OrdersStatusKind =
  | "pending"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "other";

export interface FilterableOrderItem {
  name: string;
}

export interface FilterableOrder {
  platform: string;
  statusKind: OrdersStatusKind;
  orderNumber: string;
  customer?: string | null;
  items: FilterableOrderItem[];
  currency?: string | null;
  profit?: number | null;
  profitPartial?: boolean;
  /** Kalem/tutar bilgisi platformdan alınamadı → özet toplamlarının dışında. */
  dataIncomplete?: boolean;
}

/**
 * Türkçe küçük harf. Düz `toLowerCase()` "KILIF"ı "kilif" yapıyordu; kullanıcı "kılıf" yazınca
 * eşleşme kaçıyordu. Manuel sipariş penceresindeki ürün araması da bu kuralı kullanıyor.
 */
/**
 * Türkçe-duyarlı arama normalleştirme — Ürünler sayfasındakiyle AYNI kural.
 *
 * Yalnız `toLocaleLowerCase("tr-TR")` yetmiyor: pazaryeri kalemleri çoğunlukla BÜYÜK HARF
 * geliyor ("SİLİKON KILIF") ve kullanıcı Türkçe klavyeye geçmeden "kilif" yazınca hiçbir
 * sonuç bulamıyordu. Diakritikler de sadeleştirilir ki iki ekran aynı sorguya aynı cevabı
 * versin ("Kırmızı" → "kirmizi", "ŞıK" → "sik").
 */
export function normalizeSearchText(value: string | null | undefined): string {
  return (value ?? "")
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/â/g, "a")
    .replace(/î/g, "i")
    .replace(/û/g, "u");
}

/** Sipariş no + müşteri adı + ürün adları aranır. */
export function orderMatchesSearch(
  order: FilterableOrder,
  query: string
): boolean {
  const q = normalizeSearchText(query).trim();
  if (!q) return true;
  const haystack = normalizeSearchText(
    `${order.orderNumber} ${order.customer ?? ""} ${order.items
      .map((item) => item.name)
      .join(" ")}`
  );
  return haystack.includes(q);
}

/**
 * Üstteki özet bu siparişi ciro/kâr toplamına katıyor mu?
 * Koşul /api/orders özetiyle BİREBİR aynı: iptal/iade, bilgisi eksik ve TRY dışı siparişler
 * toplamların dışında kalır.
 */
export function countsInSummary(order: FilterableOrder): boolean {
  if (order.statusKind === "cancelled") return false;
  if (order.dataIncomplete) return false;
  const currency = order.currency?.trim().toUpperCase() || "TRY";
  return currency === "TRY";
}

/** "N siparişte maliyet eksik" sayımının satır karşılığı — özetle aynı küme. */
export function hasMissingCost(order: FilterableOrder): boolean {
  return (
    countsInSummary(order) &&
    (order.profit == null || order.profitPartial === true)
  );
}

export interface OrderListFilters {
  /** "all" = tüm pazaryerleri. */
  platform: string;
  search: string;
  /** Özet kartındaki uyarıya tıklanınca açılan filtre. */
  onlyMissingCost: boolean;
}

/**
 * Durum çipi DIŞINDAKİ tüm filtreler. Çip sayaçları da listeyle aynı olsun diye bu ara
 * kümeden üretilir.
 */
export function filterOrdersBeforeStatus<T extends FilterableOrder>(
  orders: T[],
  filters: OrderListFilters
): T[] {
  return orders.filter((order) => {
    if (filters.platform !== "all" && order.platform !== filters.platform) {
      return false;
    }
    if (filters.onlyMissingCost && !hasMissingCost(order)) return false;
    return orderMatchesSearch(order, filters.search);
  });
}

/** Çip sırası — "Diğer" burada yok, yalnız gerçekten varsa sona eklenir. */
export const STATUS_CHIP_ORDER: OrdersStatusKind[] = [
  "pending",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
];

export interface StatusChipCount {
  kind: OrdersStatusKind;
  count: number;
}

/**
 * Durum çipi sayaçları. Tanımadığımız durumlar ("Diğer") eskiden hiçbir çipe düşmüyordu →
 * çiplerin toplamı "Hepsi"den az çıkıyordu. Artık böyle sipariş varsa kendi çipiyle görünür,
 * yani çiplerin toplamı listenin tamamına EŞİT olur.
 */
export function statusChipCounts(orders: FilterableOrder[]): StatusChipCount[] {
  const counts = new Map<OrdersStatusKind, number>();
  for (const order of orders) {
    counts.set(order.statusKind, (counts.get(order.statusKind) ?? 0) + 1);
  }
  const chips: StatusChipCount[] = STATUS_CHIP_ORDER.map((kind) => ({
    kind,
    count: counts.get(kind) ?? 0,
  }));
  const other = counts.get("other") ?? 0;
  if (other > 0) chips.push({ kind: "other", count: other });
  return chips;
}
