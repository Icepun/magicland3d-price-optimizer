import { query, execute } from "@/lib/turso";

export interface Spool {
  id: string;
  name: string;
  material: string;
  colorName: string | null;
  colorHex: string;
  brand: string | null;
  totalGrams: number;
  remainingGrams: number;
  spoolCost: number | null;
  reorderGrams: number;
}

export type SpoolStatus = "empty" | "low" | "ok";

export function spoolStatus(s: Spool): SpoolStatus {
  if (s.remainingGrams <= 0) return "empty";
  if (s.remainingGrams <= s.reorderGrams) return "low";
  return "ok";
}

/** Aktif makaralar — azalan kalan grama göre (en kritik üstte). Masaüstü /api/spools ile aynı. */
export async function getSpools(): Promise<Spool[]> {
  return query<Spool>(
    `SELECT id, name, material, colorName, colorHex, brand,
            totalGrams, remainingGrams, spoolCost, reorderGrams
       FROM FilamentSpool
      WHERE isActive = 1
      ORDER BY remainingGrams ASC, name COLLATE NOCASE ASC`
  );
}

function genId(): string {
  return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

/** Makaradan gram düş (0 altına inmez) + FilamentUsage kaydı. Masaüstü consume route ile aynı. */
export async function consumeSpool(
  id: string,
  grams: number,
  opts?: { productId?: string | null; productName?: string | null; note?: string | null }
): Promise<number> {
  const rows = await query<{ remainingGrams: number }>(
    `SELECT remainingGrams FROM FilamentSpool WHERE id = ?`,
    [id]
  );
  if (!rows.length) throw new Error("Makara bulunamadı");
  const newRemaining = Math.max(0, rows[0].remainingGrams - grams);
  const now = new Date().toISOString();
  await execute(`UPDATE FilamentSpool SET remainingGrams = ?, updatedAt = ? WHERE id = ?`, [
    newRemaining,
    now,
    id,
  ]);
  await execute(
    `INSERT INTO FilamentUsage (id, spoolId, productId, productName, grams, note, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [genId(), id, opts?.productId ?? null, opts?.productName ?? null, grams, opts?.note ?? null, now]
  );
  return newRemaining;
}

export interface SpoolInput {
  name: string;
  material: string;
  colorName: string | null;
  colorHex: string;
  brand: string | null;
  totalGrams: number;
  remainingGrams: number;
  reorderGrams: number;
  spoolCost: number | null;
}

export async function createSpool(s: SpoolInput): Promise<void> {
  const now = new Date().toISOString();
  await execute(
    `INSERT INTO FilamentSpool
       (id, name, material, colorName, colorHex, brand, totalGrams, remainingGrams, spoolCost, reorderGrams, isActive, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [genId(), s.name, s.material, s.colorName, s.colorHex, s.brand, s.totalGrams, s.remainingGrams, s.spoolCost, s.reorderGrams, now, now]
  );
}

export async function updateSpool(id: string, s: SpoolInput): Promise<void> {
  await execute(
    `UPDATE FilamentSpool SET name=?, material=?, colorName=?, colorHex=?, brand=?,
            totalGrams=?, remainingGrams=?, spoolCost=?, reorderGrams=?, updatedAt=? WHERE id=?`,
    [s.name, s.material, s.colorName, s.colorHex, s.brand, s.totalGrams, s.remainingGrams, s.spoolCost, s.reorderGrams, new Date().toISOString(), id]
  );
}

export async function deleteSpool(id: string): Promise<void> {
  await execute(`DELETE FROM FilamentSpool WHERE id = ?`, [id]);
}

/** Makarayı dolu işaretle (remainingGrams = totalGrams). */
export async function markSpoolFull(id: string): Promise<void> {
  const rows = await query<{ totalGrams: number }>(
    `SELECT totalGrams FROM FilamentSpool WHERE id = ?`,
    [id]
  );
  if (!rows.length) return;
  await execute(`UPDATE FilamentSpool SET remainingGrams = ?, updatedAt = ? WHERE id = ?`, [
    rows[0].totalGrams,
    new Date().toISOString(),
    id,
  ]);
}
