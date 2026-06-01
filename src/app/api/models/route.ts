import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

export const dynamic = "force-dynamic";

interface LibFile {
  id: string;
  printerConfigId: string;
  originalName: string;
  sizeBytes: number;
  gramaj: number | null;
  fileType: string;
}
interface LibRow {
  productId: string;
  name: string;
  imageUrl: string | null;
  files: LibFile[];
}

/** Baskı Kütüphanesi: dosyası olan ürünler + yazıcı listesi (kapsama rozetleri için). */
export async function GET() {
  await ensureRuntimeSchema();
  const [files, printers] = await Promise.all([
    prisma.productModelFile.findMany({
      include: { product: { select: { id: true, name: true, imageUrl: true } } },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.printerConfig.findMany({
      where: { enabled: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, brand: true, type: true },
    }),
  ]);

  const map = new Map<string, LibRow>();
  for (const f of files) {
    let row = map.get(f.productId);
    if (!row) {
      row = { productId: f.productId, name: f.product.name, imageUrl: f.product.imageUrl, files: [] };
      map.set(f.productId, row);
    }
    row.files.push({
      id: f.id,
      printerConfigId: f.printerConfigId,
      originalName: f.originalName,
      sizeBytes: f.sizeBytes,
      gramaj: f.gramaj,
      fileType: f.fileType,
    });
  }

  return NextResponse.json({ products: [...map.values()], printers });
}
