import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

const Schema = z.object({
  unmatchedListingId: z.string().min(1),
  productId: z.string().min(1),
});

interface UnmatchedRow {
  id: string;
  platform: string;
  externalId: string | null;
  externalSku: string | null;
  barcode: string;
  name: string;
  price: number;
  stock: number;
}

/**
 * Bir UnmatchedListing'i bir Product'a bağla:
 *  - Yeni/güncel Listing kaydı oluştur
 *  - UnmatchedListing'i sil
 */
export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const { unmatchedListingId, productId } = Schema.parse(await req.json());

    const rows = await prisma.$queryRawUnsafe<UnmatchedRow[]>(
      `SELECT id, platform, externalId, externalSku, barcode, name, price, stock FROM UnmatchedListing WHERE id = ? LIMIT 1`,
      unmatchedListingId
    );
    const unmatched = rows[0];
    if (!unmatched) {
      return NextResponse.json({ error: "Eşleşmemiş ürün bulunamadı" }, { status: 404 });
    }

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      return NextResponse.json({ error: "Ana ürün bulunamadı" }, { status: 404 });
    }

    // Aynı platform için listing varsa update, yoksa create
    const existing = await prisma.listing.findFirst({
      where: { productId, platform: unmatched.platform },
    });

    if (existing) {
      await prisma.listing.update({
        where: { id: existing.id },
        data: {
          externalId: unmatched.externalId,
          externalSku: unmatched.externalSku,
          salePrice: unmatched.price,
          stock: unmatched.stock,
          isActive: true,
          lastSyncedAt: new Date(),
        },
      });
    } else {
      await prisma.listing.create({
        data: {
          productId,
          platform: unmatched.platform,
          externalId: unmatched.externalId,
          externalSku: unmatched.externalSku,
          salePrice: unmatched.price,
          stock: unmatched.stock,
          isActive: true,
          lastSyncedAt: new Date(),
        },
      });
    }

    // Trendyol için Product.trendyolId güncelle
    if (unmatched.platform === "trendyol" && unmatched.externalId) {
      await prisma.product.update({
        where: { id: productId },
        data: { trendyolId: unmatched.externalId },
      });
    }

    // Unmatched'ı sil
    await prisma.$executeRawUnsafe(
      `DELETE FROM UnmatchedListing WHERE id = ?`,
      unmatchedListingId
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Match başarısız" },
      { status: 400 }
    );
  }
}
