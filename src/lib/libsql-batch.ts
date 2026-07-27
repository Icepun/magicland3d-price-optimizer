/**
 * Toplu yazma — uzak-HTTP modunda TEK round-trip.
 *
 * NEDEN: @prisma/adapter-libsql her ifadeyi ayrı `client.execute()` ile gönderir VE hepsini
 * süreç genelinde tek bir mutex'e alır. Uzak Turso'da her ifade ~96ms (ölçüldü) → 483 satırlık
 * bir döngü ~46 saniye sürer ve o süre boyunca uygulamadaki HER sorgu kuyrukta bekler.
 * libSQL'in kendi `batch()` çağrısı aynı işi tek istekte yapar.
 *
 * ⚠️ GÜVENLİK: bu yalnız UZAK-HTTP modunda güvenlidir. Embedded replica açıkken ayrı bir
 * client'la yazarsak Prisma'nın okuduğu YEREL replica bunu görmez → çağıran sıralı yola düşmeli.
 * Bu yüzden batchWrite() başarısızlıkta/uygun olmayan modda `false` döner (istisna atmaz).
 * Aynı korumanın bir kopyası runtime-schema.ts'te var (açılış DDL'i için) — o kanıtlanmış yol
 * bilinçli olarak ayrı tutuldu.
 */

type BatchStatement = { sql: string; args?: unknown[] };

type MiniBatchClient = {
  batch: (stmts: unknown[], mode?: string) => Promise<unknown>;
};

let cached: MiniBatchClient | null = null;
let tried = false;

async function getClient(): Promise<MiniBatchClient | null> {
  if (tried) return cached;
  tried = true;
  try {
    if (process.env.MLHUB_NO_BATCH_WRITE === "1") return (cached = null);
    const usingReplica =
      Boolean(process.env.TURSO_REPLICA_PATH?.trim()) &&
      process.env.TURSO_DISABLE_EMBEDDED_REPLICA?.trim() !== "1";
    const url = process.env.TURSO_DATABASE_URL?.trim();
    if (usingReplica || !url) return (cached = null);
    const mod = await import("@libsql/client");
    cached = mod.createClient({
      url: url.replace(/^libsql:\/\//i, "https://").replace(/^wss?:\/\//i, "https://"),
      authToken: process.env.TURSO_AUTH_TOKEN?.trim() || undefined,
    }) as unknown as MiniBatchClient;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * İfadeleri tek istekte gönder. Başarılıysa true; mod uygun değilse veya batch başarısızsa
 * false → ÇAĞIRAN sıralı yola düşmeli (veri kaybı olmasın).
 */
export async function batchWrite(statements: BatchStatement[]): Promise<boolean> {
  if (statements.length === 0) return true;
  const client = await getClient();
  if (!client) return false;
  try {
    // 500'lük dilimler: tek istekte çok büyük gövde göndermeyelim.
    for (let offset = 0; offset < statements.length; offset += 500) {
      await client.batch(statements.slice(offset, offset + 500), "write");
    }
    return true;
  } catch {
    return false;
  }
}
