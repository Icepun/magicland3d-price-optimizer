import { query, execute } from "@/lib/turso";

export interface ProductRow {
  id: string;
  name: string;
  sku: string;
  barcode: string;
  categoryName: string;
  currentSalePrice: number;
  stock: number;
  imageUrl: string | null;
}

/** Aktif + gizlenmemiş ürünler (masaüstü /api/products ile aynı filtre). */
export async function getProducts(): Promise<ProductRow[]> {
  return query<ProductRow>(
    `SELECT id, name, sku, barcode, categoryName, currentSalePrice, stock, imageUrl
       FROM Product
      WHERE isActive = 1 AND hidden = 0
      ORDER BY name COLLATE NOCASE ASC`
  );
}

/** Tek ürünün stoğunu güncelle (raw SQL — updatedAt'i de elle set ediyoruz). */
export async function setProductStock(id: string, stock: number): Promise<void> {
  await execute(
    `UPDATE Product SET stock = ?, updatedAt = ? WHERE id = ?`,
    [stock, new Date().toISOString(), id]
  );
}

/** Ürün takma adını güncelle (alias — mobilde düzenlenebilir kısa ad). Boş → null. */
export async function setProductAlias(id: string, alias: string): Promise<void> {
  await execute(
    `UPDATE Product SET alias = ?, updatedAt = ? WHERE id = ?`,
    [alias.trim() || null, new Date().toISOString(), id]
  );
}

export interface PriceChange {
  id: string;
  oldPrice: number;
  newPrice: number;
  changeSource: string;
  changedAt: number | string;
  note: string | null;
}

/** Bir ürünün fiyat değişiklik geçmişi (son 20). */
export async function getPriceHistory(productId: string): Promise<PriceChange[]> {
  return query<PriceChange>(
    `SELECT id, oldPrice, newPrice, changeSource, changedAt, note
       FROM PriceHistory WHERE productId = ? ORDER BY changedAt DESC LIMIT 20`,
    [productId]
  );
}

/** Özet sayımlar (Dashboard kartları için). */
export async function getProductCounts(): Promise<{
  total: number;
  outOfStock: number;
}> {
  const [row] = await query<{ total: number; outOfStock: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN stock <= 0 THEN 1 ELSE 0 END) AS outOfStock
       FROM Product WHERE isActive = 1 AND hidden = 0`
  );
  return { total: row?.total ?? 0, outOfStock: row?.outOfStock ?? 0 };
}
