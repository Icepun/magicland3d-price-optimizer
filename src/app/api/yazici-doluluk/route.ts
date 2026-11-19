import { NextResponse, type NextRequest } from "next/server";
import { remotePrisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { dilimBasi, dolulukOzetiSayimdan, SAKLAMA_GUN } from "@/lib/yazici-doluluk";

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
    const [yazicilar, sayimlar] = await Promise.all([
      remotePrisma.printerConfig.findMany({
        where: { enabled: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      // Örnekler İNDİRİLMEZ, veritabanında toplanır: 9.700 satır / 1,26 MB yerine ~30 satır.
      // Özetin baktığı her şey (yazıcı × durum sayısı + en eski dilim) burada (bkz. yazici-doluluk.ts).
      remotePrisma.$queryRawUnsafe<Array<{ printerConfigId: string; status: string; adet: number | bigint; ilk: number | bigint }>>(
        `SELECT "printerConfigId", "status", COUNT(*) AS "adet", MIN("bucketMs") AS "ilk"
           FROM "PrinterStatusSample"
          WHERE "bucketMs" >= ? AND "bucketMs" <= ?
          GROUP BY "printerConfigId", "status"`,
        now - gun * 86_400_000,
        dilimBasi(now)
      ),
    ]);
    const ozet = dolulukOzetiSayimdan(
      sayimlar.map((s) => ({ printerConfigId: String(s.printerConfigId), status: String(s.status), adet: Number(s.adet), ilk: Number(s.ilk) })),
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
