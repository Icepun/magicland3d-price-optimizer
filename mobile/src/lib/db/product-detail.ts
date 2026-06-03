import { batch, query } from "@/lib/turso";
import type { Platform } from "@/lib/platforms";

export interface ProductCostRow {
  costMode: string;
  manualCost: number | null;
  totalCost: number | null;
  filamentTypeId: string | null;
  filamentWeight: number | null;
  printTimeHours: number | null;
  wasteRate: number | null;
  packagingOptionId: string | null;
  nylonLevel: string | null;
  tapeUsed: number | null;
  costPerGram: number;
}

export interface ListingRow {
  id: string;
  platform: Platform;
  salePrice: number;
  stock: number;
  commissionRate: number | null;
  commissionFixed: number | null;
  cargoCost: number | null;
  externalId: string | null;
  externalSku: string | null;
}

export interface ProductDetail {
  id: string;
  name: string;
  alias: string | null;
  sku: string;
  barcode: string;
  categoryName: string;
  currentSalePrice: number;
  stock: number;
  desi: number | null;
  imageUrl: string | null;
  source: string;
  commissionRate: number | null;
  variantGroupId: string | null;
  variantLabel: string | null;
  variantGroupName?: string | null;
  cost: ProductCostRow | null;
  listings: ListingRow[];
}

export interface VariantMember {
  id: string;
  name: string;
  variantLabel: string | null;
  imageUrl: string | null;
  stock: number;
  currentSalePrice: number;
}
export interface VariantGroupInfo {
  id: string;
  name: string;
  members: VariantMember[];
}

export async function getProductDetail(id: string): Promise<ProductDetail | null> {
  const [pRes, cRes, lRes] = await batch([
    {
      sql: `SELECT id, name, alias, sku, barcode, categoryName, currentSalePrice, stock,
                   desi, imageUrl, source, commissionRate, variantGroupId, variantLabel
              FROM Product WHERE id = ?`,
      args: [id],
    },
    {
      sql: `SELECT pc.costMode, pc.manualCost, pc.totalCost, pc.filamentTypeId,
                   pc.filamentWeight, pc.printTimeHours, pc.wasteRate,
                   pc.packagingOptionId, pc.nylonLevel, pc.tapeUsed,
                   COALESCE(ft.costPerGram, 0) AS costPerGram
              FROM ProductCost pc
              LEFT JOIN FilamentType ft ON ft.id = pc.filamentTypeId
             WHERE pc.productId = ?`,
      args: [id],
    },
    {
      sql: `SELECT id, platform, salePrice, stock, commissionRate, commissionFixed,
                   cargoCost, externalId
              FROM Listing WHERE productId = ? AND isActive = 1`,
      args: [id],
    },
  ]);

  const product = pRes.rows[0] as unknown as ProductDetail | undefined;
  if (!product) return null;

  return {
    ...product,
    cost: (cRes.rows[0] as unknown as ProductCostRow) ?? null,
    listings: lRes.rows as unknown as ListingRow[],
  };
}

/** Bir varyant grubunun üyelerini getir (renk/beden kardeş ürünler). */
export async function getVariantGroup(groupId: string): Promise<VariantGroupInfo | null> {
  const g = await query<{ id: string; name: string }>(
    `SELECT id, name FROM VariantGroup WHERE id = ?`,
    [groupId]
  ).catch(() => [] as { id: string; name: string }[]);
  if (!g.length) return null;
  const members = await query<VariantMember>(
    `SELECT id, name, variantLabel, imageUrl, stock, currentSalePrice
       FROM Product WHERE variantGroupId = ?
      ORDER BY variantLabel COLLATE NOCASE, name COLLATE NOCASE`,
    [groupId]
  );
  return { id: g[0].id, name: g[0].name, members };
}
