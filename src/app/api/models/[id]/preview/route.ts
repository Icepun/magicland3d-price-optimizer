import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

/**
 * Kayıtlı önizleme görselini SERVİS et.
 *
 * ⚠️ NEDEN AYRI UÇ: görseller data-URL olarak saklanıyor ve ortalama 61 KB. Kütüphane
 * listesine gömülselerdi yanıt 12,5 MB büyürdü (470 dosyanın 122'sinde görsel var). Burada
 * tek tek, ikili olarak ve UZUN önbellekle veriliyor — tarayıcı ikinci kez hiç istemiyor.
 *
 * Önbellek güvenli: görsel dosyanın İÇERİĞİNE ait ve dosya değişmez (yeni dosya = yeni kayıt).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const mf = await prisma.productModelFile.findUnique({
      where: { id },
      select: { thumbnail: true },
    });
    const thumb = mf?.thumbnail ?? "";
    const match = /^data:(image\/(?:png|webp|jpeg));base64,(.+)$/.exec(thumb);
    // Görsel yok → 404. Boş bir gövde döndürmek yerine açıkça yok demek, arayüzün yer
    // tutucuya düşmesini sağlar (kırık resim ikonu göstermez).
    if (!match) return new NextResponse(null, { status: 404 });

    return new NextResponse(Buffer.from(match[2], "base64") as unknown as BodyInit, {
      headers: {
        "Content-Type": match[1],
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * İstemcide üretilen (gcode-render) önizleme görselini kaydet — yalnız kayıtta görsel YOKSA.
 * Dilimleyicinin gömdüğü görsel varsa o korunur (daha zengin gölgeli); bu rota dilimleyicisi
 * görsel gömmeyen dosyaların (örn. bazı profiller) boşluğunu doldurur.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { thumbnail?: unknown };
    const thumb = typeof body.thumbnail === "string" ? body.thumbnail : "";
    if (!/^data:image\/(png|webp|jpeg);base64,/.test(thumb) || thumb.length > 1_000_000) {
      return NextResponse.json({ error: "Geçersiz görsel" }, { status: 400 });
    }
    const mf = await prisma.productModelFile.findUnique({ where: { id }, select: { id: true, thumbnail: true } });
    if (!mf) return NextResponse.json({ error: "Model dosyası bulunamadı" }, { status: 404 });
    if (mf.thumbnail) return NextResponse.json({ ok: true, kept: true }); // mevcut görsel korunur

    await prisma.productModelFile.update({ where: { id }, data: { thumbnail: thumb } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
