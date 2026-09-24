/**
 * Pazaryerinden çekilen kayıtları yerel Listing satırlarıyla eşleştirmek için anahtar indeksleri.
 *
 * NEDEN VAR: Trendyol fiyat tazelemesi eşleştirmeyi `Product.barcode` üzerinden yapıyordu. Elle
 * eşleştirilmiş ilanlarda (Ürün Seç modalı) ürünün barkodu Shopify'ınki, ilanınki Trendyol'unki
 * olduğu için bu iki değer ZATEN farklı → eşleşme hiç tutmuyor, fiyat eşleştirme anındaki değerde
 * donuyordu. Üstelik senkron "0 değişti" diyerek her şey yolundaymış gibi görünüyordu.
 *
 * İki kural buraya gömülü:
 *   1) Anahtar sırası = GÜVEN sırası (platform kimliği > ilan barkodu > ilan stok kodu > ürün barkodu).
 *   2) Aynı anahtara birden çok kayıt düşerse o anahtar KULLANILMAZ. Trendyol'da stok kodu boşsa
 *      `productMainId`'ye düşülüyor ve o değer TÜM varyantlarda aynı — kör eşleştirme yanlış
 *      varyantın fiyatını yazardı.
 */

// Uygulama `@/core/order-match`te — telefonun sipariş eşleştirmesi de aynı iki kuralı kullanır.
export { matchByPriority, uniqueIndex } from "@/core/order-match";
