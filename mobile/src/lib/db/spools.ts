import { isSealed, materialFamily, spoolGroupKey } from "@core/filament-groups";
import { execute, query, writeBatch } from "@/lib/turso";

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

/**
 * Makaranın kendi hâli: bitti / kapalı / açık — masaüstü Filament penceresindeki rozetle AYNI.
 * "Azaldı / sipariş ver" kararı makara başına gramla DEĞİL, renk başına KAPALI makara sayısıyla
 * verilir (`@core/filament-stok`). Eski gram eşiği (`reorderGrams`) v37'den beri kullanılmıyordu;
 * telefon onunla masaüstünden farklı "bitti/yeterli" diyordu (denetim, 23 Kas 2026).
 */
export type SpoolStatus = "empty" | "sealed" | "open";

export function spoolStatus(s: Spool): SpoolStatus {
  if (s.remainingGrams <= 0) return "empty";
  return isSealed(s) ? "sealed" : "open";
}

/** İzleme kaydı (`filamentWatch:<grup>`) — son makara silinse de zil "bitti" diyebilsin (masaüstüyle aynı). */
function izlemeIfadesi(s: SpoolInput): { sql: string; args: (string | number | null)[] } {
  const key = `filamentWatch:${spoolGroupKey({ id: "", ...s })}`;
  const etiket = `${(s.colorName ?? "").trim()} ${materialFamily(s.material)}`.trim() || key;
  return {
    sql: `INSERT INTO AppSetting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, etiket],
  };
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
  const [, , , after] = await writeBatch([
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
  // Makara + izleme kaydı TEK istekte (masaüstü toplu ekleme de grubu izlemeye alıyor).
  await writeBatch([
    {
      sql: `INSERT INTO FilamentSpool
         (id, name, material, colorName, colorHex, brand, totalGrams, remainingGrams, spoolCost, reorderGrams, colorKey, openedAt, isActive, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
      args: [genId(), s.name, s.material, s.colorName, s.colorHex, s.brand, s.totalGrams, s.remainingGrams, s.spoolCost, s.reorderGrams, s.colorKey ?? null, now, now],
    },
    izlemeIfadesi(s),
  ]);
}

export async function updateSpool(id: string, s: SpoolInput): Promise<void> {
  const now = new Date().toISOString();
  await writeBatch([
    {
      // Açık/kapalı damgası gramla tutarlı kalır (masaüstü PATCH ile aynı kural, 1 g tolerans):
      // kalan toplama eşitlenince KAPALI, eksilince AÇIK (ilk açılış tarihi korunur).
      sql: `UPDATE FilamentSpool SET name=?, material=?, colorName=?, colorHex=?, brand=?,
              totalGrams=?, remainingGrams=?, spoolCost=?, reorderGrams=?, colorKey=?, updatedAt=?,
              openedAt = CASE WHEN ? >= ? - 1 THEN NULL ELSE COALESCE(openedAt, ?) END
            WHERE id=?`,
      args: [s.name, s.material, s.colorName, s.colorHex, s.brand, s.totalGrams, s.remainingGrams, s.spoolCost, s.reorderGrams, s.colorKey ?? null, now,
        s.remainingGrams, s.totalGrams, now, id],
    },
    izlemeIfadesi(s),
  ]);
}

/** Makara + tüketim kayıtları TEK istekte (tabloda yabancı anahtar yok, kendiliğinden silinmez). */
export async function deleteSpool(id: string): Promise<void> {
  await writeBatch([
    { sql: `DELETE FROM FilamentUsage WHERE spoolId = ?`, args: [id] },
    { sql: `DELETE FROM FilamentSpool WHERE id = ?`, args: [id] },
  ]);
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
