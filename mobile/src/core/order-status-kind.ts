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
  // Shopify'ın kendi adı değil: gönderilmiş (FULFILLED) ve gönderimi teslim edilmiş sipariş
  // için türetilir (bkz. shopifyTeslimEdildi).
  DELIVERED: "delivered",
  FULFILLED: "shipped",
  PARTIALLY_FULFILLED: "processing",
  IN_PROGRESS: "processing",
  SCHEDULED: "processing",
  ON_HOLD: "pending",
  UNFULFILLED: "pending",
};

/** Shopify gönderiminin (fulfillment) teslim bilgisi — Admin API alanları. */
export interface ShopifyGonderim {
  /** SUCCESS | CANCELLED | ERROR | FAILURE | OPEN | PENDING */
  status?: string | null;
  /** DELIVERED | PICKED_UP | IN_TRANSIT | OUT_FOR_DELIVERY | … */
  displayStatus?: string | null;
  deliveredAt?: string | null;
}

/**
 * Sipariş TESLİM EDİLDİ mi?
 *
 * Shopify panelinde "Teslim edildi olarak işaretle" siparişin gönderim durumunu DEĞİŞTİRMEZ
 * (`displayFulfillmentStatus` FULFILLED kalır; o alanda teslim diye bir değer yok). Bilgi
 * gönderimin (fulfillment) kendisinde durur. Yalnız sipariş alanı okunduğu için teslim edilmiş
 * siparişler hep "Kargoda" görünüyordu (27 Eyl 2026 ölçümü: son 60 siparişin 40'ı teslim edilmişti).
 *
 * İptal/başarısız gönderim sayılmaz; birden çok gönderim varsa HEPSİ teslim edilmiş olmalı.
 */
export function shopifyTeslimEdildi(gonderimler: readonly ShopifyGonderim[] | null | undefined): boolean {
  const gecerli = (gonderimler ?? []).filter((g) => {
    const s = (g.status ?? "").toUpperCase();
    return s !== "CANCELLED" && s !== "ERROR" && s !== "FAILURE";
  });
  return (
    gecerli.length > 0 &&
    gecerli.every((g) => {
      const d = (g.displayStatus ?? "").toUpperCase();
      return d === "DELIVERED" || d === "PICKED_UP" || Boolean(g.deliveredAt);
    })
  );
}

/**
 * Hepsiburada paket listelerinde durumun İLERLEME sırası. Liste dışı durumlar (teslim edilemedi,
 * iptal, iade) buraya girmez: onları kendi listeleri/talepleri belirler.
 */
const HB_ILERLEME: Record<string, number> = {
  Open: 0,
  New: 0,
  Packaged: 1,
  ReadyToShip: 1,
  Shipped: 2,
  InTransit: 2,
  Delivered: 3,
};

/**
 * Aynı HB siparişi birden çok listede göründüğünde (kargodan teslime geçiş anı, çok paketli
 * sipariş) hangi durum kalır? İLERİDEKİ kazanır. Eskiden ilk görülen kazanıyordu ve listeler
 * "kargoda → teslim" sırasıyla okunduğu için teslim edilen sipariş "Kargoda" kalabiliyordu.
 */
export function hbSonDurum(mevcut: string, yeni: string): string {
  const a = HB_ILERLEME[mevcut];
  const b = HB_ILERLEME[yeni];
  return a != null && b != null && b > a ? yeni : mevcut;
}
