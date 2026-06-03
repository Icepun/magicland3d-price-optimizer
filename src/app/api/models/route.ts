import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

export const dynamic = "force-dynamic";

interface LibFile {
  id: string;
  printerConfigId: string;
  label: string | null;
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
      // "__custom__" = özel baskı dosyaları (ürüne bağlı değil) → kütüphanede gösterme.
      // Bu sentinel'in Product kaydı yoktur → include null döner → eskiden f.product.name patlıyordu.
      where: { NOT: { productId: "__custom__" } },
      include: { product: { select: { id: true, name: true, imageUrl: true } } },
      orderBy: [{ printerConfigId: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    }),
    prisma.printerConfig.findMany({
      where: { enabled: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, brand: true, type: true },
    }),
  ]);

  const map = new Map<string, LibRow>();
  for (const f of files) {
    if (!f.product) continue; // ürünü silinmiş yetim dosya → atla (crash guard)
    let row = map.get(f.productId);
    if (!row) {
      row = { productId: f.productId, name: f.product.name, imageUrl: f.product.imageUrl, files: [] };
      map.set(f.productId, row);
    }
    row.files.push({
      id: f.id,
      printerConfigId: f.printerConfigId,
      label: f.label,
      originalName: f.originalName,
      sizeBytes: f.sizeBytes,
      gramaj: f.gramaj,
      fileType: f.fileType,
    });
  }

  return NextResponse.json({ products: [...map.values()], printers });
}
