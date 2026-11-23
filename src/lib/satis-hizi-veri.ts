import { prisma } from "@/lib/prisma";
import { swr } from "@/lib/route-cache";
import { dbEpochMs, parseDbDate } from "@/lib/sqlite-date";
import { EXCLUDED_STATUS, coverageStart, toInt, type SalesSnapshotRow } from "@/lib/planner-insights";
import { manuelKalemAdetleri, satisSayimBasi } from "@/core/satis-hizi";

/**
 * SATIŞ HIZI VERİSİ — Üretim Planı, yazıcı kuyruğu ve ürün detayı AYNI okumayı kullanır.
 *
 * - Kapsam başlangıcı (platform başına ilk kayıt) tüm tabloyu tarar → 10 dk önbellekte.
 *   Manuel siparişler kapsama GİRMEZ: sonradan başlayan manuel satış pencereyi daraltırdı.
 * - Satış satırları: sipariş kalemleri + MANUEL siparişler (eskiden yoktu), iptal hariç, sayım
 *   başı `satisSayimBasi` (pay ile payda aynı dönem) → 2 dk önbellekte.
 */
export function kapsamBaslangiclari(): Promise<number[]> {
  return swr("satis-hizi:kapsam:v1", 10 * 60_000, async () => {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT MIN(${dbEpochMs("orderedAt")}) AS "orderedAt" FROM "OrderItemSnapshot" GROUP BY "platform"`
    );
    return rows.map((r) => parseDbDate(r.orderedAt)?.getTime() ?? 0).filter((t) => t > 0);
  });
}

export async function satisHiziSatirlari(
  nowMs = Date.now()
): Promise<{ satirlar: SalesSnapshotRow[]; kapsamBaslangicMs: number | null }> {
  const kapsamBaslangicMs = coverageStart(await kapsamBaslangiclari());
  const satirlar = await swr("satis-hizi:satirlar:v1", 2 * 60_000, async () => {
    const bas = satisSayimBasi(nowMs, kapsamBaslangicMs);
    const [kalemler, manuel] = await Promise.all([
      prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT "productId","orderedAt","quantity","statusKind"
           FROM "OrderItemSnapshot"
          WHERE "productId" IS NOT NULL
            AND "statusKind" <> ?
            AND ${dbEpochMs("orderedAt")} >= ?`,
        EXCLUDED_STATUS,
        bas
      ),
      prisma.$queryRawUnsafe<Array<{ orderedAt: unknown; itemsJson: string | null }>>(
        `SELECT "orderedAt","itemsJson"
           FROM "ManualOrder"
          WHERE "statusKind" <> ?
            AND ${dbEpochMs("orderedAt")} >= ?`,
        EXCLUDED_STATUS,
        bas
      ),
    ]);
    const out: SalesSnapshotRow[] = kalemler.map((r) => ({
      productId: r.productId == null ? null : String(r.productId),
      orderedAt: parseDbDate(r.orderedAt)?.getTime() ?? NaN,
      quantity: toInt(r.quantity),
      statusKind: String(r.statusKind ?? ""),
    }));
    for (const m of manuel) {
      const orderedAt = parseDbDate(m.orderedAt)?.getTime() ?? NaN;
      for (const k of manuelKalemAdetleri(m.itemsJson)) {
        out.push({ productId: k.productId, orderedAt, quantity: k.quantity, statusKind: "manual" });
      }
    }
    return out;
  });
  return { satirlar, kapsamBaslangicMs };
}
