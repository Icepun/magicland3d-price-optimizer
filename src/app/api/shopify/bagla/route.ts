import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { bustProductCaches } from "@/lib/cache-busting";
import { nowDbDateSql } from "@/lib/sqlite-date";
import { katalogGetir, yoksayilanlariGuncelle } from "@/lib/shopify-katalog-sunucu";

/**
 * Bir Shopify varyantını VAR OLAN ürüne bağla — kopya ürün açmadan.
 *
 * Ürünün Shopify ilanı varsa (ör. ürün Shopify'da silinip yeniden açılmış, eski ilan ölü)
 * ilan yeni varyanta taşınır; maliyet, komisyon ayarları, geçmiş aynen kalır. İlan yoksa
 * (ürün Trendyol'dan gelmiş) yeni Shopify ilanı açılır.
 */
const Schema = z.object({ varyantId: z.string().min(1), urunId: z.string().min(1) });

export async function POST(req: Request) {
  try {
    await ensureRuntimeSchema();
    const { varyantId, urunId } = Schema.parse(await req.json());

    let { urunler: katalog } = await katalogGetir(false);
    let v = katalog.flatMap((k) => k.varyantlar).find((x) => x.id === varyantId);
    if (!v) {
      katalog = (await katalogGetir(true)).urunler;
      v = katalog.flatMap((k) => k.varyantlar).find((x) => x.id === varyantId);
    }
    if (!v) return NextResponse.json({ error: "Shopify'da bu ürün bulunamadı" }, { status: 404 });

    const urun = await prisma.product.findUnique({
      where: { id: urunId },
      select: { id: true, imageUrl: true, imageManual: true, listings: { select: { id: true, platform: true } } },
    });
    if (!urun) return NextResponse.json({ error: "Ürün bulunamadı" }, { status: 404 });

    const baskasi = await prisma.listing.findFirst({
      where: { platform: "shopify", externalId: varyantId, productId: { not: urunId } },
      select: { product: { select: { name: true } } },
    });
    if (baskasi) {
      return NextResponse.json(
        { error: `Bu Shopify ürünü zaten "${baskasi.product.name}" ürününe bağlı` },
        { status: 409 }
      );
    }

    const simdi = nowDbDateSql();
    const ilan = urun.listings.find((l) => l.platform === "shopify");
    if (ilan) {
      await prisma.$executeRawUnsafe(
        `UPDATE Listing SET externalId = ?, externalSku = ?, barcode = COALESCE(?, barcode), salePrice = ?, stock = ?,
                isActive = 1, lastSyncedAt = ${simdi}, updatedAt = ${simdi}
          WHERE id = ?`,
        varyantId,
        v.sku,
        v.barkod,
        v.fiyat,
        v.stok,
        ilan.id
      );
    } else {
      await prisma.$executeRawUnsafe(
        `INSERT INTO Listing (id, productId, platform, externalId, externalSku, barcode, salePrice, stock, isActive,
                lastSyncedAt, createdAt, updatedAt)
         VALUES (?, ?, 'shopify', ?, ?, ?, ?, ?, 1, ${simdi}, ${simdi}, ${simdi})`,
        `listing_${urunId}_shopify_${randomUUID().slice(0, 8)}`,
        urunId,
        varyantId,
        v.sku,
        v.barkod,
        v.fiyat,
        v.stok
      );
    }
    // Shopify fiyatı ürünün satış fiyatıdır (fiyat tazelemesi de böyle yazıyor). Görsel yalnız
    // boşsa ve elle seçilmemişse doldurulur.
    await prisma.$executeRawUnsafe(
      `UPDATE Product SET currentSalePrice = ?,
              imageUrl = CASE WHEN (imageUrl IS NULL OR imageUrl = '') AND imageManual = 0 THEN ? ELSE imageUrl END,
              updatedAt = ${simdi}
        WHERE id = ?`,
      v.fiyat,
      v.gorsel,
      urunId
    );

    await yoksayilanlariGuncelle([], [varyantId]).catch(() => {});
    bustProductCaches();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
