import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { dedupeFiles, familyMemberIds } from "@/core/printers/printer-family";

export const dynamic = "force-dynamic";

/** Bu yazıcı için dosyası olan ürünler (yazıcı kartındaki "Baskı Başlat" buradan beslenir).
 *  Seçicinin ürün/grup → varyant → dosya hiyerarşisini kurabilmesi için varyant grubu +
 *  takma ad + paylaşım anahtarı (shareKey) da döner.
 *
 *  AİLE: aynı marka + modeldeki yazıcıların dosyaları ORTAKTIR (bkz. core/printers/printer-family).
 *  İkinci U1 eklenince ürün dosyaları ona hiç görünmüyordu; kullanıcı aynı dosyaları tekrar
 *  yüklüyordu. Aynı dosya iki yazıcıya ayrı ayrı yüklenmişse listede BİR kez çıkar (önce bu
 *  yazıcınınki). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const yazicilar = await prisma.printerConfig.findMany({
      select: { id: true, type: true, brand: true, model: true },
    });
    const aile = familyMemberIds(yazicilar, id);
    const files = await prisma.productModelFile.findMany({
      // "__custom__" = özel baskı dosyaları (ürüne bağlı değil) → ürün listesinde gösterme.
      where: { printerConfigId: { in: aile }, NOT: { productId: "__custom__" } },
      // KOLONLAR TEK TEK SEÇİLİR — `include` bütün satırı çekiyordu ve `thumbnail` kolonunda
      // dilimleyicinin gömdüğü önizleme görselleri (data URL) duruyor. ÖLÇÜLDÜ (14 Ağu 2026):
      // bu yazıcı için 102 satır = 4,55 MB thumbnail, oysa aşağıda kullanılan alanların toplamı
      // 0,01 MB — 455 kat fazlası boşuna çekiliyordu. Uzak-HTTP libSQL'de sorgular SIRALI
      // olduğu için bu tek istek arkasındaki her sorguyu bekletiyor, "Baskı Başlat" açılmıyor
      // ve uygulama kilitleniyordu. Yeni alan eklersen BURAYA da ekle.
      select: {
        id: true, productId: true, label: true, originalName: true, printerConfigId: true,
        sizeBytes: true, gramaj: true, r2Key: true, storedPath: true, contentMd5: true,
        product: {
          select: {
            id: true, name: true, imageUrl: true, alias: true,
            variantGroupId: true, variantLabel: true,
            variantGroup: { select: { name: true } },
          },
        },
      },
      orderBy: [{ productId: "asc" }, { sortOrder: "asc" }],
    });
    // Önce BU yazıcının dosyaları: aynı içerik kardeş yazıcıya da yüklendiyse bunun satırı kalır
    // (yazıcıdaki "zaten var" kontrolü ve eşleştirme geçmişi bu yazıcının adıyla tutuluyor).
    const sirali = [...files].sort(
      (a, b) => Number(b.printerConfigId === id) - Number(a.printerConfigId === id),
    );
    // Tekrar ayıklama ÜRÜN içinde yapılır: iki ürün aynı dosyayı paylaşıyorsa ikisinde de görünmeli.
    const urunBasina = new Map<string, typeof sirali>();
    for (const f of sirali) {
      const liste = urunBasina.get(f.productId) ?? [];
      liste.push(f);
      urunBasina.set(f.productId, liste);
    }
    const tekil = [...urunBasina.values()].flatMap((liste) => dedupeFiles(liste));
    const sira = new Map(files.map((f, i) => [f.id, i]));
    tekil.sort((a, b) => (sira.get(a.id) ?? 0) - (sira.get(b.id) ?? 0));

    return NextResponse.json({
      models: tekil
        .filter((f) => f.product) // ürünü silinmiş yetim dosyaları ele
        .map((f) => ({
        fileId: f.id,
        productId: f.productId,
        productName: f.product!.name,
        imageUrl: f.product!.imageUrl,
        alias: f.product!.alias,
        variantGroupId: f.product!.variantGroupId,
        variantGroupName: f.product!.variantGroup?.name ?? null,
        variantLabel: f.product!.variantLabel,
        label: f.label,
        originalName: f.originalName,
        sizeBytes: f.sizeBytes,
        gramaj: f.gramaj,
        // Aynı fiziksel dosya (varyantlar arası paylaşılan) → aynı referans → aynı shareKey.
        // R2'de storedPath boş; r2Key paylaşılan anahtardır.
        shareKey: f.r2Key || path.basename(f.storedPath),
      })),
    });
  } catch (error) {
    return jsonError(error);
  }
}
