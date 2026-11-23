import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { gorselOku } from "@/lib/model-gorseli";
import { bustModelCaches } from "@/lib/cache-busting";
import { modelSatirlariniSil, type ModelSatiri } from "@/lib/model-file-cleanup";

const PatchSchema = z.object({
  label: z.string().trim().max(80, "Ad en çok 80 karakter olabilir").nullable().optional(),
  gramaj: z.coerce.number().min(0).nullable().optional(),
  estPrintMin: z.coerce.number().int().min(0).nullable().optional(),
});

/** Tek model kaydı (görselleştirme boru hattı taze contentMd5/thumbnail okur). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const mf = await prisma.productModelFile.findUnique({
      where: { id },
      select: { id: true, originalName: true, sizeBytes: true, contentMd5: true, fileType: true, printerConfigId: true },
    });
    if (!mf) return NextResponse.json({ error: "Dosya bulunamadı — silinmiş olabilir" }, { status: 404 });
    return NextResponse.json({ ...mf, thumbnail: await gorselOku(id) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const data = PatchSchema.parse(await req.json());
    // Silinmiş dosyayı adlandırma: ham veritabanı hatası yerine kısa Türkçe ileti.
    const varMi = await prisma.productModelFile.findUnique({ where: { id }, select: { id: true } });
    if (!varMi) return NextResponse.json({ error: "Dosya bulunamadı — silinmiş olabilir" }, { status: 404 });
    const updated = await prisma.productModelFile.update({
      where: { id },
      data,
      // Görselin kendisi (ortalama 61 KB) geri gönderilmez — ekran yalnız bu alanları kullanır.
      select: { id: true, label: true, gramaj: true, estPrintMin: true, r2Key: true, storedPath: true },
    });
    // ?allVariants=1 → "Tüm varyantlara uygula" AÇIKKEN düzenleme: aynı dosyayı (ortak
    // r2Key/storedPath) paylaşan diğer varyant satırları da aynı adı/değeri alır. Silme ile
    // aynı kural — yoksa ad yalnız bu varyantta değişir, diğerlerinde eskisi kalırdı.
    if (new URL(req.url).searchParams.get("allVariants") === "1" && Object.keys(data).length > 0) {
      if (updated.r2Key) {
        await prisma.productModelFile.updateMany({ where: { r2Key: updated.r2Key, id: { not: id } }, data });
      } else if (updated.storedPath) {
        // storedPath="" R2 satırlarının ortak değeri → onunla eşleştirme YAPMA.
        await prisma.productModelFile.updateMany({ where: { storedPath: updated.storedPath, id: { not: id } }, data });
      }
    }
    bustModelCaches(); // kütüphane yeni adı hemen görsün
    return NextResponse.json({ id: updated.id, label: updated.label, gramaj: updated.gramaj, estPrintMin: updated.estPrintMin });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Parçayı sil. Tek güvenli yol `modelSatirlariniSil`: satırları siler, artık kimsenin kullanmadığı
 * bulut nesnelerini (baskı dosyası + kaynak model) ve önizleme görsellerini temizler.
 *
 * - `?allVariants=1` → aynı dosyayı (ortak r2Key / gerçek storedPath) paylaşan TÜM varyant satırları.
 *   Eskiden yalnız tıklanan satırın kaynak modeline bakılıyordu; kardeşlerinki sahipsiz kalıyordu.
 * - `?ek=<id>,<id>` → ailedeki İKİZ kopyalar (aynı içerik iki U1'e ayrı yüklenmiş). Pencere onları
 *   tek parça gösterdiği için yalnız biri siliniyor, öbürü yeniden açınca geri çıkıyordu.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const url = new URL(req.url);
    const allVariants = url.searchParams.get("allVariants") === "1";
    const ek = (url.searchParams.get("ek") ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 50);
    const secim = { id: true, r2Key: true, meshR2Key: true, storedPath: true, productId: true } as const;

    const temel = await prisma.productModelFile.findMany({
      where: { id: { in: [id, ...ek] }, NOT: { productId: "__custom__" } },
      select: secim,
    });
    if (!temel.some((r) => r.id === id)) {
      return NextResponse.json({ error: "Dosya bulunamadı — zaten silinmiş olabilir" }, { status: 404 });
    }
    const silinecek = new Map<string, ModelSatiri>(temel.map((r) => [r.id, r]));
    if (allVariants) {
      const r2Keyler = [...new Set(temel.map((r) => r.r2Key).filter((k): k is string => !!k))];
      // storedPath="" R2 satırlarının ortak değeri → onunla eşleştirme YAPMA (yalnız gerçek yerel yol).
      const yollar = [...new Set(temel.filter((r) => !r.r2Key && r.storedPath).map((r) => r.storedPath))];
      if (r2Keyler.length || yollar.length) {
        const kardesler = await prisma.productModelFile.findMany({
          where: {
            NOT: { productId: "__custom__" },
            OR: [
              ...(r2Keyler.length ? [{ r2Key: { in: r2Keyler } }] : []),
              ...(yollar.length ? [{ storedPath: { in: yollar } }] : []),
            ],
          },
          select: secim,
        });
        for (const k of kardesler) silinecek.set(k.id, k);
      }
    }
    const sonuc = await modelSatirlariniSil([...silinecek.values()]);
    return NextResponse.json({ ok: true, silinen: sonuc.satir });
  } catch (error) {
    return jsonError(error);
  }
}
