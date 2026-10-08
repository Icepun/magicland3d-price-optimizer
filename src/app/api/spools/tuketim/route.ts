import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { DAY_MS, EXCLUDED_STATUS, SALES_WINDOW_DAYS, coverageStart, toInt } from "@/lib/planner-insights";
import { dbEpochMs, parseDbDate } from "@/lib/sqlite-date";
import { filamentTuketimi } from "@/lib/filament-tuketim";

/**
 * Filament sayfası "kaç gün yeter": satılan ürünlerin reçete gramajından günlük tüketim.
 * Hesap @/lib/filament-tuketim (saf). Satış okuması Üretim Planı'yla AYNI kurallar.
 */
export async function GET() {
  try {
    await ensureRuntimeSchema();
    const now = Date.now();
    const toNum = (v: unknown) => (v == null ? null : Number(v));
    const [rows, spools] = await Promise.all([
      prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        // Satış satırları önce TAKMA ADSIZ alt sorguda süzülür: dbEpochMs kolon adını kendisi
        // tırnaklıyor, "i.orderedAt" gibi bir ad bozulurdu.
        `SELECT 0 AS "kind", s."quantity" AS "quantity", c."filamentWeight" AS "filamentWeight",
                c."ekFilamentlerJson" AS "ekFilamentlerJson", c."wasteRate" AS "wasteRate", NULL AS "orderedAt"
           FROM (SELECT "productId", "quantity" FROM "OrderItemSnapshot"
                  WHERE "productId" IS NOT NULL
                    AND "statusKind" <> ?
                    AND ${dbEpochMs("orderedAt")} >= ?) s
           LEFT JOIN "ProductCost" c ON c."productId" = s."productId"
         UNION ALL
         SELECT 1 AS "kind", NULL, NULL, NULL, NULL, MIN(${dbEpochMs("orderedAt")}) AS "orderedAt"
           FROM "OrderItemSnapshot"
          GROUP BY "platform"`,
        EXCLUDED_STATUS,
        now - SALES_WINDOW_DAYS * DAY_MS
      ),
      prisma.filamentSpool.findMany({ where: { isActive: true }, select: { totalGrams: true, remainingGrams: true } }),
    ]);
    const stokGram = spools.reduce((t, s) => t + Math.max(0, s.remainingGrams ?? s.totalGrams ?? 0), 0);
    const kapsam = coverageStart(
      rows.filter((r) => Number(r.kind) === 1).map((r) => parseDbDate(r.orderedAt)?.getTime() ?? 0)
    );
    const sonuc = filamentTuketimi(
      rows
        .filter((r) => Number(r.kind) === 0)
        .map((r) => ({
          quantity: toInt(r.quantity),
          filamentWeight: toNum(r.filamentWeight),
          ekFilamentlerJson: r.ekFilamentlerJson == null ? null : String(r.ekFilamentlerJson),
          wasteRate: toNum(r.wasteRate),
        })),
      stokGram,
      kapsam,
      now
    );
    return NextResponse.json(sonuc, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
