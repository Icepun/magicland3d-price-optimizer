import { batch, execute, query } from "@/lib/turso";

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
  /** v37: normalize renk anahtarı (envanter gruplaması). */
  colorKey: string | null;
  /** v37: makara ne zaman açıldı. NULL = KAPALI (açılmamış). */
  openedAt: string | null;
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
            totalGrams, remainingGrams, spoolCost, reorderGrams, colorKey, openedAt
       FROM FilamentSpool
      WHERE isActive = 1
      ORDER BY remainingGrams ASC, name COLLATE NOCASE ASC`
  );
}

function genId(): string {
  return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

/** Makaradan gram düş (0 altına inmez) + FilamentUsage kaydı. Masaüstü consume route ile aynı.
 *  TEK batch round-trip + SQL-içi MAX(0, …) → atomik azaltma (eski hali 3 ardışık round-trip'ti
 *  ve read-modify-write masaüstüyle yarış koşulu içeriyordu). */
export async function consumeSpool(
  id: string,
  grams: number,
  opts?: { productId?: string | null; productName?: string | null; note?: string | null }
): Promise<number> {
  const now = new Date().toISOString();
  const [, , , after] = await batch([
    {
      sql: `UPDATE FilamentSpool SET remainingGrams = MAX(0, remainingGrams - ?), updatedAt = ? WHERE id = ?`,
      args: [grams, now, id],
    },
    // v37: gram düşülen makara artık AÇIKTIR. Yalnız henüz damgalanmamışsa yaz → ilk açılış
    // tarihi korunur ve masaüstündeki kapalı sayımı ile birebir aynı sonucu verir.
    {
      sql: `UPDATE FilamentSpool SET openedAt = ? WHERE id = ? AND openedAt IS NULL`,
      args: [now, id],
    },
    {
      sql: `INSERT INTO FilamentUsage (id, spoolId, productId, productName, grams, note, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [genId(), id, opts?.productId ?? null, opts?.productName ?? null, grams, opts?.note ?? null, now],
    },
    { sql: `SELECT remainingGrams FROM FilamentSpool WHERE id = ?`, args: [id] },
  ]);
  const row = after.rows[0] as unknown as { remainingGrams: number } | undefined;
  if (!row) throw new Error("Makara bulunamadı");
  return row.remainingGrams;
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
  /** Boş bırakılırsa masaüstü tarafı colorName/colorHex'ten türetir. */
  colorKey?: string | null;
}

export async function createSpool(s: SpoolInput): Promise<void> {
  const now = new Date().toISOString();
  await execute(
    `INSERT INTO FilamentSpool
       (id, name, material, colorName, colorHex, brand, totalGrams, remainingGrams, spoolCost, reorderGrams, colorKey, openedAt, isActive, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
    [genId(), s.name, s.material, s.colorName, s.colorHex, s.brand, s.totalGrams, s.remainingGrams, s.spoolCost, s.reorderGrams, s.colorKey ?? null, now, now]
  );
}

export async function updateSpool(id: string, s: SpoolInput): Promise<void> {
  await execute(
    `UPDATE FilamentSpool SET name=?, material=?, colorName=?, colorHex=?, brand=?,
            totalGrams=?, remainingGrams=?, spoolCost=?, reorderGrams=?, colorKey=?, updatedAt=? WHERE id=?`,
    [s.name, s.material, s.colorName, s.colorHex, s.brand, s.totalGrams, s.remainingGrams, s.spoolCost, s.reorderGrams, s.colorKey ?? null, new Date().toISOString(), id]
  );
}

export async function deleteSpool(id: string): Promise<void> {
  await execute(`DELETE FROM FilamentSpool WHERE id = ?`, [id]);
}

/**
 * Makarayı dolu (KAPALI) işaretle — tek SQL, tek round-trip.
 *
 * v37: `openedAt = NULL` de yazılır. Yoksa bir kez tüketilen makara gram olarak dolsa bile
 * sonsuza dek "açık" sayılır ve envanterdeki kapalı makara sayısı kalıcı olarak eksik çıkardı.
 */
export async function markSpoolFull(id: string): Promise<void> {
  await execute(
    `UPDATE FilamentSpool SET remainingGrams = totalGrams, openedAt = NULL, updatedAt = ? WHERE id = ?`,
    [new Date().toISOString(), id]
  );
}

/** Kapalı makarayı AÇ (envanter ekranındaki "Aç" aksiyonu). */
export async function markSpoolOpened(id: string): Promise<void> {
  const now = new Date().toISOString();
  await execute(`UPDATE FilamentSpool SET openedAt = ?, updatedAt = ? WHERE id = ?`, [now, now, id]);
}
