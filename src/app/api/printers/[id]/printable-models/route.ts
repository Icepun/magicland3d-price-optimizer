import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

/** Bu yazıcı için dosyası olan ürünler (yazıcı kartındaki "Baskı Başlat" buradan beslenir). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const files = await prisma.productModelFile.findMany({
      // "__custom__" = özel baskı dosyaları (ürüne bağlı değil) → ürün listesinde gösterme.
      where: { printerConfigId: id, NOT: { productId: "__custom__" } },
      include: { product: { select: { id: true, name: true, imageUrl: true } } },
      orderBy: [{ productId: "asc" }, { sortOrder: "asc" }],
    });
    return NextResponse.json({
      models: files
        .filter((f) => f.product) // ürünü silinmiş yetim dosyaları ele
        .map((f) => ({
        fileId: f.id,
        productId: f.productId,
        productName: f.product!.name,
        imageUrl: f.product!.imageUrl,
        label: f.label,
        originalName: f.originalName,
        sizeBytes: f.sizeBytes,
        gramaj: f.gramaj,
      })),
    });
  } catch (error) {
    return jsonError(error);
  }
}
