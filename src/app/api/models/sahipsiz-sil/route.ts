import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { modelSatirlariniSil } from "@/lib/model-file-cleanup";

export const dynamic = "force-dynamic";

const Schema = z.object({ ids: z.array(z.string().min(1)).min(1).max(1000) });

/**
 * KAPALI ya da SİLİNMİŞ yazıcılara ait kütüphane dosyalarını sil (Modeller → "sahipsiz dosyalar").
 *
 * Bu dosyalar hiçbir sütunda görünmüyor ama bulutta yer tutuyordu ve hiçbir ekrandan silinemiyordu
 * (denetim, 23 Kas 2026). GÜVENLİK: yalnız yazıcısı AÇIK OLMAYAN satırlar silinir — açık bir
 * yazıcının dosyası bu uçtan asla gitmez; özel baskılara da dokunulmaz.
 */
export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const { ids } = Schema.parse(await req.json());
    const acik = await prisma.printerConfig.findMany({ where: { enabled: true }, select: { id: true } });
    const acikIdler = acik.map((p) => p.id);
    const satirlar = await prisma.productModelFile.findMany({
      where: {
        id: { in: ids },
        NOT: [{ productId: "__custom__" }, ...(acikIdler.length ? [{ printerConfigId: { in: acikIdler } }] : [])],
      },
      select: { id: true, r2Key: true, meshR2Key: true, storedPath: true },
    });
    const sonuc = await modelSatirlariniSil(satirlar);
    return NextResponse.json({ silinen: sonuc.satir });
  } catch (error) {
    return jsonError(error);
  }
}
