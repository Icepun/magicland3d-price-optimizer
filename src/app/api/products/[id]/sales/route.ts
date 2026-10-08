import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { DAY_MS, EXCLUDED_STATUS, coverageStart, toInt } from "@/lib/planner-insights";
import { dbEpochMs, parseDbDate } from "@/lib/sqlite-date";
import { urunSatisOzeti } from "@/lib/urun-satis";

/**
 * Ürün detayı "Satış Geçmişi": son 6 ay platform başına adet + satış hızı + stok kaç gün yeter.
 * Hesap @/lib/urun-satis (saf). Okuma Üretim Planı'nın satış hızıyla AYNI yol: iptal hariç,
 * tarih `dbEpochMs` ile normalize, kapsam başlangıcı aynı sorguda (TEK gidiş-dönüş).
 */
const PENCERE_GUN = 200; // 6 ay + pay

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const now = Date.now();
    const [rows, urun] = await Promise.all([
      prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT 0 AS "kind","platform","orderedAt","quantity"
           FROM "OrderItemSnapshot"
          WHERE "productId" = ?
            AND "statusKind" <> ?
            AND ${dbEpochMs("orderedAt")} >= ?
         UNION ALL
         SELECT 1 AS "kind", NULL AS "platform", MIN(${dbEpochMs("orderedAt")}) AS "orderedAt", NULL AS "quantity"
           FROM "OrderItemSnapshot"
          GROUP BY "platform"`,
        id,
        EXCLUDED_STATUS,
        now - PENCERE_GUN * DAY_MS
      ),
      prisma.product.findUnique({ where: { id }, select: { stock: true, madeToOrder: true } }),
    ]);
    if (!urun) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const satislar = rows.filter((r) => Number(r.kind) === 0);
    const kapsam = coverageStart(
      rows.filter((r) => Number(r.kind) === 1).map((r) => parseDbDate(r.orderedAt)?.getTime() ?? 0)
    );
    const ozet = urunSatisOzeti(
      satislar.map((r) => ({
        platform: String(r.platform ?? "diger"),
        orderedAt: parseDbDate(r.orderedAt)?.getTime() ?? NaN,
        quantity: toInt(r.quantity),
      })),
      kapsam,
      now,
      // Sipariş üzerine üretilen üründe stok tutulmuyor → "kaç gün yeter" anlamsız.
      urun.madeToOrder ? null : urun.stock
    );
    return NextResponse.json(ozet, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
