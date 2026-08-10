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

/** Anahtar → kayıt indeksi. Birden çok kayda düşen anahtarlar (belirsiz) indeksten ÇIKARILIR. */
export function uniqueIndex<T>(
  items: Iterable<T>,
  key: (item: T) => string | null | undefined
): Map<string, T> {
  const index = new Map<string, T>();
  const ambiguous = new Set<string>();
  for (const item of items) {
    const raw = key(item);
    const k = typeof raw === "string" ? raw.trim() : "";
    if (!k) continue;
    if (index.has(k)) ambiguous.add(k);
    else index.set(k, item);
  }
  for (const k of ambiguous) index.delete(k);
  return index;
}

/**
 * Adayları verilen SIRAYLA dener, ilk tutan kaydı döndürür.
 * `[anahtar, indeks]` çiftleri; anahtar boş/null ise o aday atlanır.
 */
export function matchByPriority<T>(
  candidates: Array<readonly [string | null | undefined, Map<string, T>]>
): T | null {
  for (const [raw, index] of candidates) {
    const k = typeof raw === "string" ? raw.trim() : "";
    if (!k) continue;
    const hit = index.get(k);
    if (hit) return hit;
  }
  return null;
}
