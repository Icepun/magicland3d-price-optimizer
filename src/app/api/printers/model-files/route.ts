import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { yaziciModelDosyalariniSil } from "@/lib/model-file-cleanup";

export const dynamic = "force-dynamic";

export interface YaziciDosyaOzeti {
  printerConfigId: string;
  /** Yazıcı silinmişse null — "artık olmayan yazıcıdan kalan" demektir. */
  name: string | null;
  count: number;
  bytes: number;
}

/**
 * Yazıcı başına model dosyası özeti.
 *
 * NEDEN GEREKLİ: `ProductModelFile.printerConfigId` bir foreign key DEĞİL. Yazıcı silinince
 * satırlar duruyor ama hiçbir ekranda görünmüyor (ürün kartındaki sekme kayboluyor) — dosyalar
 * R2'de yer kaplamaya devam ediyor ve depo hademesi de onları sahipsiz saymıyor, çünkü satır
 * yerinde duruyor. Ölçüldü (29 Ağu 2026): satılan bir yazıcıdan 110 dosya / 2,1 GB kalmıştı.
 */
export async function GET() {
  try {
    await ensureRuntimeSchema();
    // groupBy yerine tek okuma + JS toplama: libSQL adapter'ında aggregate'lerle yaşanan
    // sorunlara girmiyoruz, satır sayısı da küçük (birkaç yüz).
    const [rows, configs] = await Promise.all([
      prisma.productModelFile.findMany({
        select: { printerConfigId: true, sizeBytes: true, meshSizeBytes: true },
      }),
      prisma.printerConfig.findMany({ select: { id: true, name: true } }),
    ]);
    const ad = new Map(configs.map((c) => [c.id, c.name]));
    const toplam = new Map<string, { count: number; bytes: number }>();
    for (const r of rows) {
      const t = toplam.get(r.printerConfigId) ?? { count: 0, bytes: 0 };
      t.count += 1;
      t.bytes += (r.sizeBytes || 0) + (r.meshSizeBytes || 0);
      toplam.set(r.printerConfigId, t);
    }
    const groups: YaziciDosyaOzeti[] = [...toplam.entries()].map(([printerConfigId, t]) => ({
      printerConfigId,
      name: ad.get(printerConfigId) ?? null,
      count: t.count,
      bytes: t.bytes,
    }));
    // Kalanlar (adı olmayanlar) üstte — kullanıcı temizleyeceği şeyi önce görsün.
    groups.sort((a, b) => (a.name === null ? 0 : 1) - (b.name === null ? 0 : 1) || b.bytes - a.bytes);
    return NextResponse.json({ groups });
  } catch (error) {
    return jsonError(error);
  }
}

const Schema = z.object({ printerConfigId: z.string().min(1) });

/**
 * Bir yazıcıya ait model dosyalarını sil. GERİ ALINAMAZ.
 * Yazıcı artık kayıtlı değilse ondan kalan diğer satırlar (eşleştirme, anlık durum, komut)
 * da temizlenir — yarım temizlik yine görünmez çöp bırakır.
 */
export async function DELETE(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const { printerConfigId } = Schema.parse(await req.json());
    const sonuc = await yaziciModelDosyalariniSil(printerConfigId);

    const cfg = await prisma.printerConfig.findUnique({ where: { id: printerConfigId }, select: { id: true } });
    if (!cfg) {
      await prisma.printFileProduct.deleteMany({ where: { printerConfigId } });
      await prisma.printerSnapshot.deleteMany({ where: { printerConfigId } });
      await prisma.printCommand.deleteMany({ where: { printerConfigId } });
      await prisma.appSetting.deleteMany({ where: { key: `slotSnapshot:${printerConfigId}` } });
    }
    return NextResponse.json({ ok: true, ...sonuc });
  } catch (error) {
    return jsonError(error);
  }
}
