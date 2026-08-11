import { trendyolMinQty } from "./pricing-engine";

/**
 * PLATFORM KURALLARI — tek kaynak.
 *
 * NEDEN: "Shopify sepet minimumu" ve "Trendyol minimum sipariş adedi" kuralları sekiz ayrı çağrı
 * yerinde elle tekrarlanıyordu; sabit (150) her birine ayrı ayrı yazılmıştı. Kural burada BİR kez
 * tanımlanır, tüm yüzeyler aynı yanıtı alır.
 *
 * Barem tabloları burada YENİDEN YAZILMAZ — çekirdekteki `trendyolMinQty` sarılır.
 */

/** Shopify'da kargonun satıcıya kalmadığı sepet alt sınırı (₺, KDV dahil). */
export const SHOPIFY_MIN_BASKET = 150;

/**
 * Shopify'da sepet minimumunun altındaki ürün tek başına satılamaz; kargo sepetteki diğer
 * ürünlerle paylaşılır → o listing'e kargo YAZILMAZ (0).
 *
 * ⚠️ VERİLECEK FİYAT: müşterinin GERÇEKTEN ödediği (etkili) fiyat. Kampanya simülasyonunda
 * indirim UYGULANDIKTAN sonraki tutar geçilmelidir — eşik ürünün etiketine değil, sepete bakar.
 * Kampanyasız yüzeylerde (Ürünler, Panel, önizleme) liste fiyatı zaten etkili fiyattır.
 *
 * Bunun görünür sonucu: büyük bir indirim ürünü 150₺'nin altına düşürürse kargo müşteriye
 * geçer ve satıcının kârı ARTABİLİR. Bu bir hesap hatası değil, kuralın gerçek etkisidir —
 * kampanya tablosunda kullanıcıya ayrıca açıklanır (bkz. price-lab `crossesFreeShipping`).
 *
 * Dönen değer doğrudan `simulatePrice`ın `cargoCostOverride` alanına verilir;
 * `undefined` = "kargo kurallarına bak".
 */
export function shopifyCargoOverride(
  platform: string,
  effectivePrice: number
): number | undefined {
  return platform === "shopify" && effectivePrice < SHOPIFY_MIN_BASKET ? 0 : undefined;
}

/** Bu fiyat sepet minimumunun altına düşüyor mu — kampanya tablosunda açıklama göstermek için. */
export function belowShopifyMinBasket(platform: string, effectivePrice: number): boolean {
  return platform === "shopify" && effectivePrice < SHOPIFY_MIN_BASKET;
}

/**
 * Platformun dayattığı minimum sipariş adedi — kâr N adetlik sipariş üzerinden hesaplanır.
 * Trendyol dışında her platformda 1.
 */
export function platformMinOrderQty(platform: string, salePrice: number): number {
  return platform === "trendyol" ? trendyolMinQty(salePrice) : 1;
}

/**
 * Komisyon/kargo/gider tablolarından GELMEYEN, platformun kendi fiyat kırılım noktaları.
 * Hedef-marj araması bu noktalarda marj sıçradığı için aralıkları ayrı ayrı tarar.
 * (Trendyol değerleri `trendyolMinQty` baremiyle aynı olmak zorunda — testle kilitli.)
 */
export function platformPriceBreakpoints(platform: string): number[] {
  if (platform === "trendyol") return [25, 35, 50, 75];
  if (platform === "shopify") return [SHOPIFY_MIN_BASKET];
  return [];
}
