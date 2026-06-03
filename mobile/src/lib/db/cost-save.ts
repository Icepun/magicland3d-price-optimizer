import { execute, query } from "@/lib/turso";

export interface FilamentType {
  id: string;
  name: string;
  costPerGram: number;
}

export async function getFilamentTypes(): Promise<FilamentType[]> {
  return query<FilamentType>(
    `SELECT id, name, costPerGram FROM FilamentType WHERE isActive = 1 ORDER BY name ASC`
  );
}

function newId(): string {
  return (
    "c" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  );
}

export interface CostInput {
  mode?: "detailed" | "manual"; // varsayılan detailed
  manualCost?: number | null; // manuel modda tek toplam maliyet
  filamentTypeId: string | null;
  filamentWeight: number;
  printTimeHours: number;
  wasteRate: number; // kesir (0.05 = %5)
  packagingOptionId: string | null;
  nylonLevel: "none" | "low" | "medium" | "high";
  tapeUsed: boolean;
}

/** ProductCost upsert (detailed VEYA manual mod) — masaüstü PATCH /api/products/[id] cost ile aynı alanlar. */
export async function saveProductCost(productId: string, c: CostInput): Promise<void> {
  const now = new Date().toISOString();
  const mode = c.mode ?? "detailed";
  await execute(
    `INSERT INTO ProductCost
       (id, productId, costMode, manualCost, filamentTypeId, filamentWeight, printTimeHours,
        wasteRate, packagingOptionId, nylonLevel, tapeUsed, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(productId) DO UPDATE SET
       costMode      = excluded.costMode,
       manualCost    = excluded.manualCost,
       filamentTypeId = excluded.filamentTypeId,
       filamentWeight = excluded.filamentWeight,
       printTimeHours = excluded.printTimeHours,
       wasteRate      = excluded.wasteRate,
       packagingOptionId = excluded.packagingOptionId,
       nylonLevel     = excluded.nylonLevel,
       tapeUsed       = excluded.tapeUsed,
       updatedAt      = excluded.updatedAt`,
    [
      newId(),
      productId,
      mode,
      c.manualCost ?? null,
      c.filamentTypeId,
      c.filamentWeight,
      c.printTimeHours,
      c.wasteRate,
      c.packagingOptionId,
      c.nylonLevel,
      c.tapeUsed ? 1 : 0,
      now,
    ]
  );
}

/** Ürün desi'sini güncelle (Trendyol kargo hesabı için). */
export async function setProductDesi(productId: string, desi: number | null): Promise<void> {
  await execute(`UPDATE Product SET desi = ?, updatedAt = ? WHERE id = ?`, [
    desi,
    new Date().toISOString(),
    productId,
  ]);
}
