import { batch } from "@/lib/turso";
import type { ProductDetail, ListingRow, ProductCostRow } from "@/lib/db/product-detail";

interface ProductCostFlat extends ProductCostRow {
  productId: string;
  hasCost: number;
}

/**
 * Dashboard için TÜM aktif ürünleri + maliyet + listing'leri TOPLU çeker (4 sorgu).
 * Per-ürün getProductDetail çağırmak yerine bulk — 421 ürün için tek round-trip seti.
 */
export async function getDashboardData(): Promise<ProductDetail[]> {
  const [prodRes, listRes] = await batch([
    {
      sql: `SELECT p.id, p.name, p.alias, p.sku, p.barcode, p.categoryName, p.currentSalePrice,
                   p.stock, p.desi, p.imageUrl, p.source, p.madeToOrder, p.commissionRate,
                   p.variantGroupId, p.variantLabel, vg.name AS variantGroupName,
                   pc.productId AS hasCost, pc.costMode, pc.manualCost, pc.totalCost,
                   pc.filamentTypeId, pc.filamentWeight, pc.printTimeHours, pc.wasteRate,
                   pc.packagingOptionId, pc.nylonLevel, pc.tapeUsed,
                   COALESCE(ft.costPerGram, 0) AS costPerGram
              FROM Product p
              LEFT JOIN ProductCost pc ON pc.productId = p.id
              LEFT JOIN FilamentType ft ON ft.id = pc.filamentTypeId
              LEFT JOIN VariantGroup vg ON vg.id = p.variantGroupId
             WHERE p.isActive = 1 AND p.hidden = 0`,
    },
    {
      sql: `SELECT id, productId, platform, salePrice, stock, commissionRate,
                   commissionFixed, cargoCost, externalId, externalSku
              FROM Listing WHERE isActive = 1`,
    },
  ]);

  const byProduct = new Map<string, ListingRow[]>();
  for (const row of listRes.rows as unknown as (ListingRow & { productId: string })[]) {
    const arr = byProduct.get(row.productId) ?? [];
    arr.push(row);
    byProduct.set(row.productId, arr);
  }

  return (prodRes.rows as unknown as (ProductDetail & ProductCostFlat)[]).map((p) => ({
    id: p.id,
    name: p.name,
    alias: p.alias,
    sku: p.sku,
    barcode: p.barcode,
    categoryName: p.categoryName,
    currentSalePrice: p.currentSalePrice,
    stock: p.stock,
    desi: p.desi,
    imageUrl: p.imageUrl,
    source: p.source,
    madeToOrder: p.madeToOrder,
    commissionRate: p.commissionRate,
    variantGroupId: p.variantGroupId,
    variantLabel: p.variantLabel,
    variantGroupName: p.variantGroupName ?? null,
    cost: p.hasCost
      ? {
          costMode: p.costMode,
          manualCost: p.manualCost,
          totalCost: p.totalCost,
          filamentTypeId: p.filamentTypeId,
          filamentWeight: p.filamentWeight,
          printTimeHours: p.printTimeHours,
          wasteRate: p.wasteRate,
          packagingOptionId: p.packagingOptionId,
          nylonLevel: p.nylonLevel,
          tapeUsed: p.tapeUsed,
          costPerGram: p.costPerGram,
        }
      : null,
    listings: byProduct.get(p.id) ?? [],
  }));
}
