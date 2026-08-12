import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import {
  DAY_MS,
  EXCLUDED_STATUS,
  SALES_WINDOW_DAYS,
  coverageStart,
  deriveSalesInsights,
  toInt,
} from "@/lib/planner-insights";
import { dbEpochMs, parseDbDate } from "@/lib/sqlite-date";

/**
 * Üretim Planı satış hızı ucu. Hesabın tamamı @/lib/planner-insights içinde — bu dosya YALNIZ
 * istek işleyicisi barındırır (Next 16 rota dosyaları başka bir değer dışa açamaz).
 */
export async function GET() {
  try {
    await ensureRuntimeSchema();
    const now = Date.now();
    const since = now - SALES_WINDOW_DAYS * DAY_MS;

    // Prisma istemcisi bu tabloyu henüz tanımıyor (şema bu oturumda eklendi) → ham okuma,
    // order-finance-snapshots.ts ile AYNI yol.
    //
    // ⚠️ Tarih karşılaştırması `dbEpochMs()` ile normalize edilir: kolonda hem eski epoch-ms
    // tamsayı hem kanonik ISO metin bulunabilir ve SQLite'ta tamsayı her zaman metinden
    // küçüktür — düz `>= ?` bir grubu komple elerdi. Gerekçe: src/lib/sqlite-date.ts.
    // TEK GİDİŞ-DÖNÜŞ: satışlar ve kapsam başlangıcı ayrı iki sorguydu. Uzak-HTTP modunda her
    // sorgu ~96 ms ve hepsi süreç genelinde SIRAYA giriyor → Planlayıcı her açılışta bir tur
    // fazla bekliyordu. `kind` sütunu iki gövdeyi ayırır; hesap aynı hesap.
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT 0 AS "kind","productId","orderedAt","quantity","statusKind"
         FROM "OrderItemSnapshot"
        WHERE "productId" IS NOT NULL
          AND "statusKind" <> ?
          AND ${dbEpochMs("orderedAt")} >= ?
       UNION ALL
       SELECT 1 AS "kind", NULL AS "productId", MIN(${dbEpochMs("orderedAt")}) AS "orderedAt",
              NULL AS "quantity", NULL AS "statusKind"
         FROM "OrderItemSnapshot"
        GROUP BY "platform"`,
      EXCLUDED_STATUS,
      since
    );
    const satisSatirlari = rows.filter((row) => Number(row.kind) === 0);
    const kapsamSatirlari = rows.filter((row) => Number(row.kind) === 1);
    const coverageStartMs = coverageStart(
      kapsamSatirlari.map((row) => parseDbDate(row.orderedAt)?.getTime() ?? 0)
    );

    const payload = deriveSalesInsights(
      satisSatirlari.map((row) => ({
        productId: row.productId == null ? null : String(row.productId),
        orderedAt: parseDbDate(row.orderedAt)?.getTime() ?? NaN,
        quantity: toInt(row.quantity),
        statusKind: String(row.statusKind ?? ""),
      })),
      coverageStartMs,
      now
    );
    return NextResponse.json(payload);
  } catch (error) {
    return jsonError(error);
  }
}
