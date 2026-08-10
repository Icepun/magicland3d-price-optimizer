import { bustProductCaches } from "@/lib/cache-busting";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { cleanupProductOrphans } from "@/lib/orphan-cleanup";
import { z } from "zod";

const Schema = z.object({
  ids: z.array(z.string()).min(1, "En az bir ürün seç"),
});

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const { ids } = Schema.parse(await req.json());
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

    // Boş kalan grupları sil
    for (const gid of groupIds) {
      const remaining = await prisma.product.count({ where: { variantGroupId: gid } });
      if (remaining === 0) {
        await prisma.variantGroup.delete({ where: { id: gid } }).catch(() => {});
      }
    }
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
