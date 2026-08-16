/**
 * SİPARİŞ DURUMU → ORTAK KOVA (masaüstü + mobil AYNI tablo).
 *
 * Pazaryerleri onlarca durum adı gönderiyor; uygulama bunları altı kovaya indiriyor
 * (`pending`/`processing`/`shipped`/`delivered`/`cancelled`/`other`). Kova iki şeyi belirler:
 *  1. sipariş ciroya girer mi (`cancelled` girmez),
 *  2. hazırlık listesinde çıkar mı (`pending`+`processing` çıkar — bkz. core/prep-list.ts).
 *
 * ⚠️ Bu tablo `src/core` altında ve `npm run sync-core` ile telefona kopyalanır. İki kopya
 * olsaydı, örneğin "Paket Bölündü" masaüstünde hazırlık listesinde çıkıp telefonda çıkmazdı;
 * kullanıcı telefonla paketlerken o siparişi hiç görmez ve ürün eksik giderdi.
 */
export type OrderStatusKind =
  | "pending"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "other";

export interface StatusInfo {
  kind: OrderStatusKind;
  label: string;
}

export const TRENDYOL_STATUS_KINDS: Record<string, StatusInfo> = {
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

export const HEPSIBURADA_STATUS_KINDS: Record<string, StatusInfo> = {
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

// ⚠️ Etiketler manuel sipariş penceresindeki durum listesiyle AYNI olmak zorunda
// (components/orders/ManualOrderDialog.tsx): kullanıcı orada seçtiği adı burada aynen görmeli.
export const MANUAL_STATUS_KINDS: Record<string, StatusInfo> = {
  pending: { kind: "pending", label: "Bekleyen" },
  processing: { kind: "processing", label: "Hazırlanıyor" },
  shipped: { kind: "shipped", label: "Gönderildi" },
  delivered: { kind: "delivered", label: "Teslim Edildi" },
  cancelled: { kind: "cancelled", label: "İptal" },
};

/**
 * Shopify'ın kovası tek alandan çıkmaz (gönderim + ödeme + iptal birlikte okunur).
 * Masaüstü üç alanı da elinde tutar; telefon yalnız türetilmiş gönderim durumunu saklar —
 * bu yüzden ortak nokta ADLARIN kovası olarak burada tutulur.
 */
export const SHOPIFY_STATUS_KINDS: Record<string, OrderStatusKind> = {
  CANCELLED: "cancelled",
  REFUNDED: "cancelled",
  RESTOCKED: "cancelled",
  FULFILLED: "shipped",
  PARTIALLY_FULFILLED: "processing",
  IN_PROGRESS: "processing",
  SCHEDULED: "processing",
  ON_HOLD: "pending",
  UNFULFILLED: "pending",
};
