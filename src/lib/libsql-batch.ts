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
      // ZAMAN AŞIMI ŞART (19 Kas 2026 denetimi): bu istemcide hiç yoktu. Yarı ölü bir sokette
      // istek süresiz asılı kalır; çağıran bir kilit tutuyorsa (relay turu, sipariş taraması) o
      // iş uygulama yeniden başlayana kadar durur. Yazma olduğu için YENİDEN DENENMEZ — iptal
      // edilen istek sunucuda uygulanmış olabilir; çağıran bir sonraki turda farkı yeniden yazar.
      fetch: zamanAsimliFetch,
    } as Parameters<typeof mod.createClient>[0]) as unknown as MiniBatchClient;
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
  return (await batchWriteDurumu(statements)) === "ok";
}

/** Toplu isteğin tavan süresi. En büyük meşru iş (24 MB'lık kolon taşıma) ~4 sn sürüyor. */
export function batchZamanAsimiMs(): number {
  return Math.max(10_000, Number(process.env.MLHUB_BATCH_TIMEOUT_MS) || 60_000);
}

/** libSQL istemcisi fetch'i tek argümanla (hazır Request) çağırır; sinyal ikinci argümandan eklenir. */
function zamanAsimliFetch(input: unknown, init?: { signal?: AbortSignal }): Promise<unknown> {
  const sinyaller = [AbortSignal.timeout(batchZamanAsimiMs())];
  const dis = init?.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined);
  if (dis) sinyaller.push(dis);
  return (fetch as unknown as (i: unknown, o?: unknown) => Promise<unknown>)(input, {
    ...init,
    signal: sinyaller.length > 1 ? AbortSignal.any(sinyaller) : sinyaller[0],
  });
}

/**
 * - "ok": yazıldı.
 * - "uygun-degil": bu modda toplu yazma yok (yerel SQLite / gömülü replika / kapatılmış) →
 *   çağıran SIRALI yola düşmeli.
 * - "basarisiz": istek gönderildi ama düştü (ağ, zaman aşımı, SQL hatası). Sıralı yola düşmek
 *   aynı ağda yüzlerce tekil isteği kullanıcı şeridinde bekletir; arka plan işleri bunun yerine
 *   bir sonraki turu beklemeli.
 */
export type BatchSonucu = "ok" | "uygun-degil" | "basarisiz";

/**
 * İfadeleri tek istekte gönderir ve NEDEN başarısız olduğunu ayırt eder.
 * `ustSinirMs` verilirse çağıran en çok o kadar bekler (istek arkada tavan süresine kadar
 * sürebilir) — kilit tutan arka plan turları için.
 */
export async function batchWriteDurumu(statements: BatchStatement[], ustSinirMs?: number): Promise<BatchSonucu> {
  if (statements.length === 0) return "ok";
  const client = await getClient();
  if (!client) return "uygun-degil";
  const calistir = async (): Promise<BatchSonucu> => {
    try {
      // 500'lük dilimler: tek istekte çok büyük gövde göndermeyelim.
      for (let offset = 0; offset < statements.length; offset += 500) {
        await client.batch(statements.slice(offset, offset + 500), "write");
      }
      return "ok";
    } catch {
      return "basarisiz";
    }
  };
  if (!ustSinirMs) return calistir();
  let zamanlayici: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      calistir(),
      new Promise<BatchSonucu>((coz) => {
        zamanlayici = setTimeout(() => coz("basarisiz"), ustSinirMs);
      }),
    ]);
  } finally {
    if (zamanlayici) clearTimeout(zamanlayici);
  }
}
