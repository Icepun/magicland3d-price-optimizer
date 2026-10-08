import { NextResponse, type NextRequest } from "next/server";
import { remotePrisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { dolulukOzeti, SAKLAMA_GUN } from "@/lib/yazici-doluluk";

/**
 * Yazıcılar → "son N gün doluluk". Örnekleri relay yazar (`PrinterStatusSample`); bu uç yazıcıya
 * BAĞLANMAZ, yalnız tabloyu okur. Hesap @/lib/yazici-doluluk (saf).
 */
export async function GET(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const istenen = Number(req.nextUrl.searchParams.get("gun") ?? 7);
    const gun = Number.isFinite(istenen) ? Math.max(1, Math.min(SAKLAMA_GUN, Math.trunc(istenen))) : 7;
    const now = Date.now();
    const [yazicilar, ornekler] = await Promise.all([
      remotePrisma.printerConfig.findMany({
        where: { enabled: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      remotePrisma.$queryRawUnsafe<Array<{ printerConfigId: string; bucketMs: number; status: string }>>(
        `SELECT "printerConfigId", "bucketMs", "status" FROM "PrinterStatusSample" WHERE "bucketMs" >= ?`,
        now - gun * 86_400_000
      ),
    ]);
    const ozet = dolulukOzeti(
      ornekler.map((o) => ({ printerConfigId: String(o.printerConfigId), bucketMs: Number(o.bucketMs), status: String(o.status) })),
      yazicilar.map((y) => y.id),
      now,
      gun
    );
    const ad = new Map(yazicilar.map((y) => [y.id, y.name]));
    return NextResponse.json(
      { gun, ...ozet, yazicilar: ozet.yazicilar.map((y) => ({ ...y, ad: ad.get(y.printerConfigId) ?? "Yazıcı" })) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return jsonError(error);
  }
}
