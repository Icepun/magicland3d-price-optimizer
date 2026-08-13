import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { readModelGramaj } from "@/lib/model-gramaj";

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
      select: { id: true, r2Key: true, storedPath: true, fileType: true, gramaj: true },
    });
    if (!mf) return NextResponse.json({ error: "Model dosyası bulunamadı" }, { status: 404 });

    // Zaten okunmuşsa dosyaya hiç gitme.
    if (mf.gramaj != null) return NextResponse.json({ gramaj: mf.gramaj, cached: true });

    const gramaj = await readModelGramaj(mf);
    // Okunamadıysa 0 YAZMA — "bilinmiyor" ile "sıfır gram" aynı şey değil.
    if (gramaj == null || !Number.isFinite(gramaj) || gramaj <= 0) {
      return NextResponse.json({ gramaj: null, reason: "Bu dosyada gramaj yazmıyor" });
    }

    await prisma.productModelFile.update({ where: { id }, data: { gramaj } });
    return NextResponse.json({ gramaj });
  } catch (error) {
    return jsonError(error);
  }
}
