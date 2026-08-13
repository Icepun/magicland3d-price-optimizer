import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { readModelOlcum } from "@/lib/model-gramaj";

export const dynamic = "force-dynamic";

/**
 * Tek bir model dosyasının gramajını dosyadan OKU ve kaydet.
 *
 * ⚠️ ÜRÜN MALİYETİNE DOKUNMAZ. Yazılan tek alan `ProductModelFile.gramaj`; bu alan yalnız
 * Modeller sayfasında, yazıcılar arası karşılaştırma için gösteriliyor. Kâr ve maliyet
 * hesaplarının kaynağı olan `ProductCost.filamentWeight` (Berke'nin elle girdiği değer)
 * buradan HİÇ etkilenmez — gerekçe ve koruma: `src/lib/model-gramaj.ts`.
 *
 * TEK DOSYA işler (toplu değil): arayüz parçaları tek tek çağırıp "3/12" gibi BELİRLİ
 * ilerleme gösterebilsin diye. Toplu uç, ilerlemesi görünmeyen uzun bir bekleme olurdu.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const mf = await prisma.productModelFile.findUnique({
      where: { id },
      select: { id: true, r2Key: true, storedPath: true, fileType: true, gramaj: true, estPrintMin: true },
    });
    if (!mf) return NextResponse.json({ error: "Model dosyası bulunamadı" }, { status: 404 });

    // İkisi de okunmuşsa dosyaya hiç gitme.
    if (mf.gramaj != null && mf.estPrintMin != null) {
      return NextResponse.json({ gramaj: mf.gramaj, estPrintMin: mf.estPrintMin, cached: true });
    }

    const olcum = await readModelOlcum(mf);
    // Okunamayanı 0 YAZMA — "bilinmiyor" ile "sıfır" aynı şey değil. Yalnız GERÇEKTEN
    // okunabilen alan yazılır; diğeri eski değerinde kalır.
    const data: { gramaj?: number; estPrintMin?: number } = {};
    if (olcum.gramaj != null) data.gramaj = olcum.gramaj;
    if (olcum.estPrintMin != null) data.estPrintMin = Math.round(olcum.estPrintMin);
    if (Object.keys(data).length === 0) {
      return NextResponse.json({
        gramaj: null,
        estPrintMin: null,
        reason: "Bu dosyada gramaj ve süre yazmıyor",
      });
    }

    await prisma.productModelFile.update({ where: { id }, data });
    return NextResponse.json({
      gramaj: olcum.gramaj ?? mf.gramaj,
      estPrintMin: data.estPrintMin ?? mf.estPrintMin,
    });
  } catch (error) {
    return jsonError(error);
  }
}
