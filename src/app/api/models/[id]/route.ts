import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { getR2Config, deleteObject } from "@/lib/r2";
import { bustModelCaches } from "@/lib/cache-busting";

const PatchSchema = z.object({
  label: z.string().trim().max(80).nullable().optional(),
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
      select: { id: true, originalName: true, sizeBytes: true, contentMd5: true, thumbnail: true, fileType: true, printerConfigId: true },
    });
    if (!mf) return NextResponse.json({ error: "Model dosyası bulunamadı" }, { status: 404 });
    return NextResponse.json(mf);
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const data = PatchSchema.parse(await req.json());
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

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    // ?allVariants=1 → "Tüm varyantlara uygula" AÇIKKEN silme: aynı dosyayı (ortak r2Key/storedPath)
    // paylaşan TÜM varyant satırlarını sil (kullanıcı kutucuk seçiliyken hepsinden gitsin bekliyor).
    const allVariants = new URL(req.url).searchParams.get("allVariants") === "1";
    const mf = await prisma.productModelFile.findUnique({ where: { id } });
    if (!mf) return NextResponse.json({ ok: true });

    if (allVariants && mf.r2Key) {
      await prisma.productModelFile.deleteMany({ where: { r2Key: mf.r2Key } });
    } else if (allVariants && mf.storedPath) {
      // storedPath="" R2 satırlarının ortak değeri → onunla deleteMany YAPMA (yalnız gerçek yerel yol).
      await prisma.productModelFile.deleteMany({ where: { storedPath: mf.storedPath } });
    } else {
      await prisma.productModelFile.delete({ where: { id } });
    }
    bustModelCaches(); // satır gitti — kütüphane silineni göstermeye devam etmesin

    /**
     * KAYNAK MODEL de aynı kuralla temizlenir: parça silindiyse ona bağlı görüntüleme dosyası
     * da gitmeli, ama başka satır (varyant) hâlâ referans veriyorsa DOKUNULMAZ.
     * Eklenmezse R2'de sahipsiz nesne kalır; hademe 24 saat sonra toplar ama gereksiz durur.
     */
    if (mf.meshR2Key) {
      const meshKullanan = await prisma.productModelFile.count({ where: { meshR2Key: mf.meshR2Key } });
      if (meshKullanan === 0) {
        const cfg = await getR2Config();
        if (cfg) {
          try { await deleteObject(mf.meshR2Key, cfg); } catch { /* R2 silme kritik değil */ }
        }
      }
    }

    // Dosyayı (R2 objesi / disk) YALNIZCA hiç referans kalmayınca sil.
    if (mf.r2Key) {
      const stillUsed = await prisma.productModelFile.count({ where: { r2Key: mf.r2Key } });
      if (stillUsed === 0) {
        const cfg = await getR2Config();
        if (cfg) {
          try { await deleteObject(mf.r2Key, cfg); } catch { /* R2 silme kritik değil */ }
        }
      }
    } else if (mf.storedPath) {
      const stillUsed = await prisma.productModelFile.count({ where: { storedPath: mf.storedPath } });
      if (stillUsed === 0) {
        try { fs.unlinkSync(mf.storedPath); } catch { /* yoksa boşver */ }
      }
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
