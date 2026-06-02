import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

/**
 * Bir UnmatchedListing'i (Shopify'da olmayan, sadece Trendyol/HB'de bulunan ürün) doğrudan
 * YENİ bir Product'a çevir — adı/resmi/fiyatı/stoğu/kategorisi pazaryeri verisinden gelir.
 * Eşleştirme (match) akışının tersi: mevcut Shopify ürününe bağlamak yerine yeni ürün yaratır.
 *  - Product + ilgili platform Listing'i oluşturur (barkod dahil → siparişler eşleşir)
 *  - UnmatchedListing'i siler
 *  - Barkod zaten bir üründe varsa 409 (kullanıcı 'Ürün Seç' ile eşleştirmeli)
 */
interface UnmatchedRow {
  id: string;
  platform: string;
  externalId: string | null;
  externalSku: string | null;
  barcode: string;
  name: string;
  categoryName: string | null;
  price: number;
  stock: number;
  imageUrl: string | null;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;

    const rows = await prisma.$queryRawUnsafe<UnmatchedRow[]>(
      `SELECT id, platform, externalId, externalSku, barcode, name, categoryName, price, stock, imageUrl
       FROM UnmatchedListing WHERE id = ? LIMIT 1`,
      id
    );
    const u = rows[0];
    if (!u) {
      return NextResponse.json({ error: "Pazaryeri listing'i bulunamadı" }, { status: 404 });
    }

    // Barkod UNIQUE — aynı barkodlu ürün zaten varsa yeni ürün yaratma, eşleştirmeye yönlendir.
    const existing = await prisma.product.findUnique({ where: { barcode: u.barcode } });
    if (existing) {
      return NextResponse.json(
        { error: "Bu barkodlu ürün zaten var — 'Ürün Seç' ile eşleştirebilirsin." },
        { status: 409 }
      );
    }

    const platformLabel = u.platform === "hepsiburada" ? "Hepsiburada" : "Trendyol";
    const product = await prisma.product
      .create({
        data: {
          barcode: u.barcode,
          sku: u.externalSku || u.barcode,
          name: u.name,
          categoryName: u.categoryName || platformLabel,
          currentSalePrice: u.price || 0,
          stock: u.stock,
          imageUrl: u.imageUrl,
          source: u.platform,
          isActive: true,
          ...(u.platform === "trendyol" && u.externalId ? { trendyolId: u.externalId } : {}),
          listings: {
            create: {
              platform: u.platform,
              externalId: u.externalId,
              externalSku: u.externalSku,
              barcode: u.barcode,
              salePrice: u.price || 0,
              stock: u.stock,
              isActive: true,
              lastSyncedAt: new Date(),
            },
          },
        },
      })
      .catch((e: unknown) => {
        if ((e as { code?: string })?.code === "P2002") return null; // yarış: araya barkod girdi
        throw e;
      });

    if (!product) {
      return NextResponse.json(
        { error: "Bu barkodlu ürün zaten var — 'Ürün Seç' ile eşleştirebilirsin." },
        { status: 409 }
      );
    }

    await prisma.$executeRawUnsafe(`DELETE FROM UnmatchedListing WHERE id = ?`, id);
    return NextResponse.json(product, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Ürün eklenemedi" },
      { status: 400 }
    );
  }
}
