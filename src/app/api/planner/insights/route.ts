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
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT "productId","orderedAt","quantity","statusKind"
         FROM "OrderItemSnapshot"
        WHERE "productId" IS NOT NULL
          AND "statusKind" <> ?
          AND "orderedAt" >= ?`,
      EXCLUDED_STATUS,
      since
    );
    const oldestRows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT "platform", MIN("orderedAt") AS "oldest"
         FROM "OrderItemSnapshot"
        GROUP BY "platform"`
    );
    const coverageStartMs = coverageStart(
      oldestRows.map((row) => (row.oldest == null ? 0 : toInt(row.oldest)))
    );

    const payload = deriveSalesInsights(
      rows.map((row) => ({
        productId: row.productId == null ? null : String(row.productId),
        orderedAt: toInt(row.orderedAt),
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
