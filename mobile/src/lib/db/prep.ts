import { batch, execute, query } from "@/lib/turso";

/**
 * Paketleme "hazırlandı" işaretleri — masaüstüyle ORTAK (şema v46, `PrepDone`).
 *
 * Kullanıcı kararı: masaüstünde başlayıp telefonda bitirebilmek. Eskiden bu işaretler
 * masaüstünde tarayıcının oturum deposundaydı; yani yalnız o cihazda, yalnız o oturumda
 * yaşıyordu. Artık iki cihaz aynı satırları görüyor.
 *
 * Anahtar (`key`) hazırlık satırının kimliği: `id:<productId>` ya da `ad:<ürün adı>` — gruplama
 * ortak çekirdekte (`@core/prep-list`) yapıldığı için iki cihaz AYNI anahtarı üretir.
 */

/** Tablo eski sürüm bir cihazda henüz yaratılmamış olabilir → ilk dokunuşta garanti et. */
async function ensurePrepSchema(): Promise<void> {
  await execute(
    `CREATE TABLE IF NOT EXISTS "PrepDone" (
       "key" TEXT NOT NULL PRIMARY KEY,
       "doneAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`
  ).catch(() => {
    /* yazma izni/ağ yoksa okuma yine denenir; liste işaretsiz çalışır */
  });
}

export async function getPrepDone(): Promise<string[]> {
  await ensurePrepSchema();
  const rows = await query<{ key: string }>(`SELECT key FROM "PrepDone"`);
  return (rows as unknown as { key: string }[]).map((r) => String(r.key));
}

/** Tek satırı işaretle/işareti kaldır. */
export async function setPrepDone(key: string, done: boolean): Promise<void> {
  await ensurePrepSchema();
  if (done) {
    // ⚠️ TARİH ISO METİN — `CURRENT_TIMESTAMP` DEĞİL. SQLite'ın kendi damgası "YYYY-MM-DD HH:MM:SS"
    // biçiminde (T'siz, UTC ama öyle görünmüyor); okurken yerel sanılırsa 3 saat kayıyor.
    // Masaüstü Prisma üzerinden ISO yazıyor; iki cihazın aynı kolona iki biçim yazması,
    // projedeki en pahalı hataların kaynağıydı.
    await execute(
      `INSERT INTO "PrepDone" ("key", "doneAt") VALUES (?, ?)
       ON CONFLICT("key") DO UPDATE SET "doneAt" = excluded."doneAt"`,
      [key, new Date().toISOString()]
    );
  } else {
    await execute(`DELETE FROM "PrepDone" WHERE "key" = ?`, [key]);
  }
}

/** Listeyi sıfırla (paketleme bitti). Tek gidişte — 20 satır için 20 ağ turu atmasın. */
export async function clearPrepDone(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await ensurePrepSchema();
  await batch(keys.map((k) => ({ sql: `DELETE FROM "PrepDone" WHERE "key" = ?`, args: [k] })));
}
