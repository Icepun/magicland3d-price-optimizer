import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { readModelBilgisi } from "@/lib/model-gramaj";
import { bustModelCaches } from "@/lib/cache-busting";

export const dynamic = "force-dynamic";

interface Satir {
  id: string;
  r2Key: string | null;
  storedPath: string;
  fileType: string;
  gramaj: number | null;
  estPrintMin: number | null;
  gorselVar: number | bigint | null;
}

/**
 * Tek bir model dosyasının gramajını, süresini ve önizleme görselini dosyadan OKU ve kaydet.
 *
 * ⚠️ ÜRÜN MALİYETİNE DOKUNMAZ. Yazılan alanlar `ProductModelFile.gramaj` / `estPrintMin` /
 * `thumbnail`; bunlar yalnız gösterim içindir (Modeller sayfası, ürünün Baskı Dosyaları kartı).
 * Kâr ve maliyet hesaplarının kaynağı olan `ProductCost.filamentWeight` (Berke'nin elle
 * girdiği değer) buradan HİÇ etkilenmez — gerekçe ve koruma: `src/lib/model-gramaj.ts`.
 *
 * TEK DOSYA işler (toplu değil): arayüz parçaları tek tek çağırıp "3/12" gibi BELİRLİ
 * ilerleme gösterebilsin diye. Toplu uç, ilerlemesi görünmeyen uzun bir bekleme olurdu.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    // Görselin KENDİSİ çekilmez (ortalama 61 KB) — yalnız "var mı" sorulur. Tek sorgu:
    // uzak veritabanında her ek sorgu ~96 ms ve sıralı.
    const [mf] = await prisma.$queryRawUnsafe<Satir[]>(
      `SELECT id, r2Key, storedPath, fileType, gramaj, estPrintMin,
              (thumbnail IS NOT NULL AND thumbnail <> '') AS gorselVar
         FROM ProductModelFile WHERE id = ?`,
      id,
    );
    if (!mf) return NextResponse.json({ error: "Model dosyası bulunamadı" }, { status: 404 });
    const gorselVar = Number(mf.gorselVar ?? 0) === 1;

    // Üçü de biliniyorsa dosyaya hiç gitme.
    if (mf.gramaj != null && mf.estPrintMin != null && gorselVar) {
      return NextResponse.json({ gramaj: mf.gramaj, estPrintMin: mf.estPrintMin, hasThumbnail: true, cached: true });
    }

    const olcum = await readModelBilgisi(mf);
    // Okunamayanı 0 YAZMA — "bilinmiyor" ile "sıfır" aynı şey değil. Yalnız GERÇEKTEN
    // okunabilen ve henüz kayıtlı OLMAYAN alan yazılır; diğerleri eski değerinde kalır.
    const data: { gramaj?: number; estPrintMin?: number; thumbnail?: string } = {};
    if (olcum.gramaj != null && mf.gramaj == null) data.gramaj = olcum.gramaj;
    if (olcum.estPrintMin != null && mf.estPrintMin == null) data.estPrintMin = Math.round(olcum.estPrintMin);
    if (olcum.thumbnail != null && !gorselVar) data.thumbnail = olcum.thumbnail;

    if (Object.keys(data).length > 0) {
      await prisma.productModelFile.update({ where: { id }, data });
      bustModelCaches();
    }
    const gramaj = data.gramaj ?? mf.gramaj;
    const estPrintMin = data.estPrintMin ?? mf.estPrintMin;
    return NextResponse.json({
      gramaj,
      estPrintMin,
      hasThumbnail: gorselVar || data.thumbnail != null,
      ...(gramaj == null && estPrintMin == null ? { reason: "Bu dosyada gramaj ve süre yazmıyor" } : {}),
    });
  } catch (error) {
    return jsonError(error);
  }
}
