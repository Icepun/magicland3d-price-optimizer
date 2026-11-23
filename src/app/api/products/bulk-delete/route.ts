import { bustProductCaches } from "@/lib/cache-busting";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { cleanupProductOrphans } from "@/lib/orphan-cleanup";
import { shopifyVaryantlari, yoksayilanlariGuncelle } from "@/lib/shopify-katalog-sunucu";
import { z } from "zod";

const Schema = z.object({
  ids: z.array(z.string()).min(1, "En az bir ürün seç"),
});

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const { ids } = Schema.parse(await req.json());
    // Silinenlerin Shopify ürünleri "Shopify'dan Ekle" listesine geri dönmesin (tekil silmeyle aynı).
    const shopifyVaryantIdleri = await shopifyVaryantlari(ids).catch(() => [] as string[]);
    // Silinecek ürünlerin ait olduğu grupları topla — silince boş kalanları temizle.
    const affected = await prisma.product.findMany({
      where: { id: { in: ids }, variantGroupId: { not: null } },
      select: { variantGroupId: true },
    });
    const groupIds = [...new Set(affected.map((p) => p.variantGroupId!).filter(Boolean))];

    const result = await prisma.product.deleteMany({ where: { id: { in: ids } } });

    // Bulut tablolarında silme zinciri yok → bağlı satırları açıkça temizle, yoksa yedek
    // geri yüklemesi yetim satırlar yüzünden hataya düşüyor.
    await cleanupProductOrphans(ids);

    // Boş kalan grupları sil — TEK sayım + TEK silme (grup başına iki sıralı sorgu, uzak
    // veritabanında her biri ~100 ms ve tüm uygulamayı bekletiyordu).
    if (groupIds.length) {
      const kalan = await prisma.product.groupBy({
        by: ["variantGroupId"],
        where: { variantGroupId: { in: groupIds } },
        _count: { _all: true },
      });
      const dolu = new Set(kalan.map((k) => k.variantGroupId));
      const bos = groupIds.filter((gid) => !dolu.has(gid));
      if (bos.length) await prisma.variantGroup.deleteMany({ where: { id: { in: bos } } }).catch(() => {});
    }
    await yoksayilanlariGuncelle(shopifyVaryantIdleri, []).catch(() => {});
    // Silinen ürünler sipariş eşleşmesinden ve listelerden düşmeli (tekil DELETE zaten düşürüyordu).
    bustProductCaches();
    return NextResponse.json({ deleted: result.count });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Toplu silme başarısız" },
      { status: 400 }
    );
  }
}
