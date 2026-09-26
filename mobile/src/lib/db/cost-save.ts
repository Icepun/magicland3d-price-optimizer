import { ekFilamentleriYaz, type EkFilament } from "@core/filament-karisimi";
import { execute, query, writeBatch } from "@/lib/turso";

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
  /** Çoklu filament — ana filamente EK türler. Verilmezse kayıttaki ekler KORUNUR. */
  ekFilamentler?: EkFilament[];
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
       totalCost      = NULL,
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

/** Maliyet + desi + (opsiyonel) varyant kopyalarını TEK round-trip'te yaz.
 *  edit-cost otomatik kaydetmesi eskiden 2..(2+N) ARDIŞIK çağrı yapıyordu
 *  (5 üyeli grupta her form değişikliği ~6 round-trip). */
export async function saveProductCostBatch(
  productId: string,
  c: CostInput,
  desi: number | null,
  alsoProductIds: string[] = []
): Promise<void> {
  const now = new Date().toISOString();
  const mode = c.mode ?? "detailed";
  // Ek filament yalnız verildiyse yazılır; verilmezse (eski ekran) kayıttakiler korunur.
  const ekYaz = (ekKolonu: boolean) => ekKolonu && c.ekFilamentler !== undefined;
  const upsert = (pid: string, ekKolonu: boolean) => ({
    sql: `INSERT INTO ProductCost
            (id, productId, costMode, manualCost, filamentTypeId, filamentWeight, printTimeHours,
             wasteRate, packagingOptionId, nylonLevel, tapeUsed, updatedAt${ekYaz(ekKolonu) ? ", ekFilamentlerJson" : ""})
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${ekYaz(ekKolonu) ? ", ?" : ""})
          ON CONFLICT(productId) DO UPDATE SET
            costMode      = excluded.costMode,
            manualCost    = excluded.manualCost,
            filamentTypeId = excluded.filamentTypeId,
            filamentWeight = excluded.filamentWeight,
            printTimeHours = excluded.printTimeHours,
            wasteRate      = excluded.wasteRate,
            packagingOptionId = excluded.packagingOptionId,
            nylonLevel     = excluded.nylonLevel,
            tapeUsed       = excluded.tapeUsed,${ekYaz(ekKolonu) ? "\n            ekFilamentlerJson = excluded.ekFilamentlerJson," : ""}
            totalCost      = NULL,
            updatedAt      = excluded.updatedAt`,
    args: [
      newId(),
      pid,
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
      ...(ekYaz(ekKolonu) ? [ekFilamentleriYaz(c.ekFilamentler ?? [])] : []),
    ],
  });
  // TEK PARÇA: maliyet, desi ve varyant kopyaları birlikte yazılır ya da hiçbiri.
  const yaz = (ekKolonu: boolean) =>
    writeBatch([
      upsert(productId, ekKolonu),
      { sql: `UPDATE Product SET desi = ?, updatedAt = ? WHERE id = ?`, args: [desi, now, productId] },
      ...alsoProductIds.filter((pid) => pid !== productId).map((pid) => upsert(pid, ekKolonu)),
    ]);
  try {
    await yaz(true);
  } catch (e) {
    // Masaüstü henüz çoklu filament sürümüne geçmediyse kolon yok → eski biçimle kaydet.
    if (!/no such column/i.test(e instanceof Error ? e.message : String(e))) throw e;
    await yaz(false);
  }
}
