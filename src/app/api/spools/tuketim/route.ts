import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { EXCLUDED_STATUS, coverageStart, toInt } from "@/lib/planner-insights";
import { dbEpochMs } from "@/lib/sqlite-date";
import { kapsamBaslangiclari } from "@/lib/satis-hizi-veri";
import { satisSayimBasi } from "@/core/satis-hizi";
import { filamentTuketimi } from "@/lib/filament-tuketim";
import { swr } from "@/lib/route-cache";

/**
 * Filament sayfası "kaç gün yeter": satılan ürünlerin reçete gramajından günlük tüketim.
 * Hesap @/lib/filament-tuketim (saf). Satış okuması Üretim Planı'yla AYNI kurallar.
 */
export async function GET() {
  try {
    await ensureRuntimeSchema();
    const now = Date.now();
    const toNum = (v: unknown) => (v == null ? null : Number(v));
    // Pay ile payda aynı dönem (Üretim Planı ile ortak kural).
    const kapsam = coverageStart(await kapsamBaslangiclari());
    const sayimBasi = satisSayimBasi(now, kapsam);
    // Satış taraması tüm satış tablosunu okuyor: 10 dk önbellekte tutulur. Makara gramı ise her
    // istekte taze (az önce eklenen makara "elde kalan"a hemen yansısın).
    const [rows, spools] = await Promise.all([
      swr("spools:tuketim-satis:v2", 10 * 60_000, () => prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        // Satış satırları önce TAKMA ADSIZ alt sorguda süzülür: dbEpochMs kolon adını kendisi
        // tırnaklıyor, "i.orderedAt" gibi bir ad bozulurdu.
        `SELECT s."quantity" AS "quantity", c."filamentWeight" AS "filamentWeight",
                c."ekFilamentlerJson" AS "ekFilamentlerJson", c."wasteRate" AS "wasteRate"
           FROM (SELECT "productId", "quantity" FROM "OrderItemSnapshot"
                  WHERE "productId" IS NOT NULL
                    AND "statusKind" <> ?
                    AND ${dbEpochMs("orderedAt")} >= ?) s
           LEFT JOIN "ProductCost" c ON c."productId" = s."productId"`,
        EXCLUDED_STATUS,
        sayimBasi
      )),
      prisma.filamentSpool.findMany({ where: { isActive: true }, select: { totalGrams: true, remainingGrams: true } }),
    ]);
    const stokGram = spools.reduce((t, s) => t + Math.max(0, s.remainingGrams ?? s.totalGrams ?? 0), 0);
    const sonuc = filamentTuketimi(
      rows
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
