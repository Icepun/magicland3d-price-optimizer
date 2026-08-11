/**
 * Kategori eşleştirmesinin TEK kaynağı.
 *
 * NEDEN: kargo ve komisyon motorları kategoriyi Türkçe kurallarına göre küçültüyordu
 * (`toLocaleLowerCase("tr-TR")`), gider motoru ise düz `toLowerCase()` kullanıyordu.
 * Fark Türkçe'nin noktasız/noktalı i'sinden çıkıyor: "Işıklı Dekor" düz kurallarla
 * "işıklı dekor", Türkçe kurallarla "ışıklı dekor" oluyor. Kullanıcı kuralı küçük
 * harfle ("ışıklı dekor") yazdığında komisyon kuralı uygulanıp gider kuralı SESSİZCE
 * uygulanmıyordu — aynı üründe iki motor farklı davranıyordu.
 *
 * Ayrıca baştaki/sondaki ve tekrarlı boşluklar sadeleşiyor: "Dekor  &  Figür" ile
 * "Dekor & Figür" aynı kategori sayılır.
 */

export function normalizeCategory(value: string | null | undefined): string {
  if (!value) return "";
  return value.toLocaleLowerCase("tr-TR").replace(/\s+/g, " ").trim();
}

/**
 * Kural kategorisi ürün kategorisine uyuyor mu?
 * Kuralda kategori YOKSA (null/boş) kural tüm kategorilere uygulanır.
 */
export function categoryMatches(
  ruleCategoryName: string | null | undefined,
  productCategoryName: string
): boolean {
  if (!ruleCategoryName) return true;

  const ruleCategory = normalizeCategory(ruleCategoryName);
  const productCategory = normalizeCategory(productCategoryName);
  if (!ruleCategory) return true;

  return productCategory.includes(ruleCategory);
}

/**
 * Eşleşme gücü — birden çok kural uyduğunda EN ÖZEL olanı seçmek için.
 * 0 = hiç uymuyor. Tam eşleşme > kapsayan eşleşme > kapsanan eşleşme.
 */
export function categoryMatchScore(
  ruleCategoryName: string | null | undefined,
  productCategoryName: string
): number {
  if (!ruleCategoryName) return 0;

  const ruleCategory = normalizeCategory(ruleCategoryName);
  const productCategory = normalizeCategory(productCategoryName);

  if (!ruleCategory || !productCategory) return 0;
  if (productCategory === ruleCategory) return 10_000 + ruleCategory.length;
  if (productCategory.includes(ruleCategory)) return 1_000 + ruleCategory.length;
  if (ruleCategory.includes(productCategory)) return 500 + productCategory.length;

  return 0;
}
