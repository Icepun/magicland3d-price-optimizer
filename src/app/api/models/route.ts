import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { swr } from "@/lib/route-cache";

export const dynamic = "force-dynamic";

interface LibFile {
  id: string;
  printerConfigId: string;
  label: string | null;
  originalName: string;
  sizeBytes: number;
  gramaj: number | null;
  fileType: string;
  /**
   * Kayıtlı önizleme görselinin KENDİSİ değil, VAR MI bilgisi.
   *
   * ⚠️ Görseller data-URL olarak saklanıyor ve ortalama 61 KB. Kütüphanedeki 470 dosyanın
   * 122'sinde görsel var; hepsini bu yanıta gömmek listeyi 12,5 MB büyütürdü. Görsel
   * `/api/models/<id>/preview` ucundan tek tek, uzun önbellekle çekilir.
   */
  hasThumbnail: boolean;
  /** `vizKeyForModel` bunu kullanıyor — aynı içerik farklı kayıtlarda tek önbelleğe düşsün. */
  contentMd5: string | null;
}
interface LibRow {
  productId: string;
  name: string;
  imageUrl: string | null;
  files: LibFile[];
  /** Bu ürünün dosyalarının toplam boyutu (bayt) — listede ve sıralamada kullanılır. */
  totalBytes: number;
}

/** Kütüphanenin yer kaplaması — hiçbir ekranda yazmıyordu, sessizce büyüyordu. */
interface LibStorage {
  totalBytes: number;
  fileCount: number;
  /** Yazıcı başına: hangi makinenin dosyaları ne kadar yer tutuyor. */
  byPrinter: Array<{ printerConfigId: string; bytes: number; files: number }>;
  /** En büyük dosyalar — temizlik yapılacaksa buradan başlanır. */
  largest: Array<{
    id: string;
    productId: string;
    productName: string;
    printerConfigId: string;
    name: string;
    sizeBytes: number;
  }>;
}

/** Baskı Kütüphanesi: dosyası olan ürünler + yazıcı listesi (kapsama rozetleri için). */
export async function GET() {
  const data = await swr("models:v1", 2 * 60_000, computeModels);
  return NextResponse.json(data);
}

async function computeModels() {
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
      row = { productId: f.productId, name: f.product.name, imageUrl: f.product.imageUrl, files: [], totalBytes: 0 };
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
      hasThumbnail: Boolean(f.thumbnail),
      contentMd5: f.contentMd5 ?? null,
    });
    row.totalBytes += f.sizeBytes ?? 0;
  }

  const products = [...map.values()];

  // ── Depolama özeti ────────────────────────────────────────────────────────────────
  // Ölçüldü (13 Ağu 2026): 470 kütüphane dosyası, 8,6 GB. Bu sayı hiçbir ekranda
  // yazmıyordu; kullanıcı ancak fatura ya da kota ile fark ederdi.
  const byPrinter = new Map<string, { bytes: number; files: number }>();
  for (const f of files) {
    if (!f.product) continue;
    const cur = byPrinter.get(f.printerConfigId) ?? { bytes: 0, files: 0 };
    cur.bytes += f.sizeBytes ?? 0;
    cur.files += 1;
    byPrinter.set(f.printerConfigId, cur);
  }
  const storage: LibStorage = {
    totalBytes: products.reduce((sum, p) => sum + p.totalBytes, 0),
    fileCount: products.reduce((sum, p) => sum + p.files.length, 0),
    byPrinter: [...byPrinter.entries()]
      .map(([printerConfigId, v]) => ({ printerConfigId, ...v }))
      .sort((a, b) => b.bytes - a.bytes),
    // `.sort()` yerinde sıralar — kopya üzerinde çalış, `files` başka bir yerde kullanılırsa
    // sıralaması sessizce bozulmasın.
    largest: [...files]
      .filter((f) => f.product)
      .sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))
      .slice(0, 10)
      .map((f) => ({
        id: f.id,
        productId: f.productId,
        productName: f.product!.name,
        printerConfigId: f.printerConfigId,
        name: f.label || f.originalName,
        sizeBytes: f.sizeBytes ?? 0,
      })),
  };

  return { products, printers, storage };
}
