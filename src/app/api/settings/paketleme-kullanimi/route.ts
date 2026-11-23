import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

/** Poşet/kutu seçeneği başına kaç ürün kullanıyor — silme onayı "N ürün kullanıyor" desin. */
export async function GET() {
  try {
    await ensureRuntimeSchema();
    const satirlar = await prisma.$queryRawUnsafe<Array<{ id: string | null; n: number | bigint }>>(
      `SELECT "packagingOptionId" AS id, COUNT(*) AS n FROM "ProductCost"
        WHERE "costMode" = 'detailed' AND "packagingOptionId" IS NOT NULL AND "packagingOptionId" <> ''
        GROUP BY "packagingOptionId"`,
    );
    return NextResponse.json(Object.fromEntries(satirlar.map((r) => [String(r.id), Number(r.n)])));
  } catch (error) {
    return jsonError(error);
  }
}
