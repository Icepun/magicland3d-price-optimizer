import {
  HEPSIBURADA_STATUS_KINDS,
  MANUAL_STATUS_KINDS,
  SHOPIFY_STATUS_KINDS,
  TRENDYOL_STATUS_KINDS,
} from "@core/order-status-kind";
import { buildPrepItems, type PrepItem, type PrepSourceOrder, type PrepStatusKind } from "@core/prep-list";
import type { UnifiedOrder } from "@/lib/api/orders";
import { getProductMap, matchOrderLine } from "@/lib/order-profit";
import type { ProductDetail } from "@/lib/db/product-detail";

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
 *
 * ⚠️ ÜRÜN EŞLEŞTİRME `matchOrderLine` İLE — sadece `productId` ile DEĞİL.
 * Pazaryeri kalemlerinin çoğunda `productId` boş; eşleşme barkod/SKU/liste kimliği üzerinden
 * kuruluyor (Siparişler ekranı da bunu kullanıyor). Yalnız `productId`'ye bakıldığında hazırlık
 * listesinde HİÇBİR ürünün fotoğrafı çıkmıyordu — oysa rafta ürün ada göre değil GÖRSELE
 * bakarak bulunuyor; listenin asıl faydası o. Aynı eşleşme "sipariş üzerine üretilir"
 * bilgisini de getiriyor.
 */
export function prepItemsFromOrders(
  orders: UnifiedOrder[],
  urunler?: ProductDetail[]
): PrepItem[] {
  const pm = urunler && urunler.length > 0 ? getProductMap(urunler) : null;

  const kaynak: PrepSourceOrder[] = orders.map((o) => ({
    orderNumber: o.orderNumber,
    statusKind: orderPrepKind(o),
    items: o.items.map((it) => {
      const urun = pm ? matchOrderLine(it, o.platform, pm) : undefined;
      return {
        name: it.name,
        quantity: it.quantity,
        image: it.image ?? urun?.imageUrl ?? null,
        // Gruplama anahtarı: eşleşen ürünün kimliği. Böylece aynı ürün farklı pazaryerlerinden
        // gelse de TEK satırda toplanıyor (eskiden ada göre ayrı satırlara bölünüyordu).
        productId: it.productId ?? urun?.id ?? null,
        madeToOrder: Boolean(urun?.madeToOrder),
      };
    }),
  }));
  return buildPrepItems(kaynak);
}
