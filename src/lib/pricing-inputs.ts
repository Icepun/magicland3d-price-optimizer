/**
 * Sipariş kârını (orders-cache) ETKİLEYEN girdiler — tek kaynak.
 *
 * Pahalı orders önbelleği (3 pazaryeri canlı çekim + kâr hesabı) YALNIZ bu listelerden
 * biri değişince düşürülmeli. Finans-dışı değişiklikler (ürün görseli, takma ad, planner
 * hedef stok, R2 ayarları, UI tercihleri) önbelleği KORUR → Siparişler sekmesi anında gelir.
 *
 * ⚠️ Yeni bir finansal AppSetting anahtarı veya kâr-etkileyen Product alanı eklenince
 * BURAYI güncelle — yoksa Siparişler kârı eski değerle önbellekte kalır (pages-map tuzağı).
 * Kaynaklar: order-profit.ts (vatRate), product-commission.ts (shopifyCommissionRate),
 * product-cost.ts + packaging.ts (cost + paketleme anahtarları), orders/route.ts (eşleşme alanları).
 */

/**
 * Kâr hesabına giren AppSetting anahtarları. parsePackagingSettings (packaging.ts) +
 * product-cost.ts + order-profit.ts okumalarından BİREBİR türetildi.
 */
export const FINANCIAL_SETTING_KEYS: ReadonlySet<string> = new Set([
  "vatRate",
  "shopifyCommissionRate",
  // maliyet (detailed mod saatlik oranları)
  "costElectricityIncluded",
  "costElectricityPerHour",
  "costMachineWearPerHour",
  "costLaborPerHour",
  // paketleme (parsePackagingSettings ile birebir)
  "packagingOptions",
  "packagingScopes",
  "nylonRollPrice",
  "nylonRollGrams",
  "nylonLowGrams",
  "nylonMediumGrams",
  "nylonHighGrams",
  "tapePrice",
  "tapeProductsPerRoll",
  "cardQty",
  "cardPrice",
  "stickerQty",
  "stickerPrice",
  "sakizQty",
  "sakizPrice",
]);

/** POST /api/settings gövdesi kâr-etkileyen bir anahtar içeriyor mu? */
export function settingsBodyAffectsProfit(body: Record<string, unknown>): boolean {
  return Object.keys(body).some((k) => FINANCIAL_SETTING_KEYS.has(k));
}

/**
 * PATCH /api/products/[id] gövdesinde sipariş kârını/eşleşmesini etkileyen alanlar.
 * orders/route.ts sipariş kârı için üründen yalnız bunları kullanır:
 *  - cost → maliyet → kâr
 *  - barcode → sipariş-ürün eşleşme anahtarı
 *  - categoryName → kargo/komisyon kuralı seçimi
 *  - desi → kargo bareminin girdisi
 *  - name → Shopify ad-fallback eşleştirmesi
 * currentSalePrice/listPrice/weight/imageUrl/alias/isActive/hidden/variantGroup/stock/madeToOrder
 * kâr gövdesine GİRMEZ → önbelleği düşürmezler.
 */
export const PROFIT_AFFECTING_PRODUCT_FIELDS: readonly string[] = [
  "cost",
  "barcode",
  "categoryName",
  "desi",
  "name",
];

/** Product PATCH gövdesi kâr-etkileyen bir alan içeriyor mu? (undefined = değişmedi) */
export function productPatchAffectsProfit(body: Record<string, unknown>): boolean {
  return PROFIT_AFFECTING_PRODUCT_FIELDS.some((f) => body[f] !== undefined);
}
