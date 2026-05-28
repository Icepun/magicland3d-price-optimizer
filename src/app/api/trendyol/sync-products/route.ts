import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { TrendyolClient, type TrendyolProduct } from "@/services/trendyol-client";
import { getTrendyolCredentials } from "@/services/trendyol-settings";
import { jsonError } from "@/lib/api-error";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

const Schema = z.object({
  approved: z.boolean().default(true),
  archived: z.boolean().default(false),
  startPage: z.coerce.number().int().min(0).default(0),
  maxPages: z.coerce.number().int().min(1).max(100).default(100),
  size: z.coerce.number().int().min(1).max(100).default(100),
});

function mapProduct(product: TrendyolProduct) {
  const imageUrl = product.images?.[0]?.url || null;
  const barcode = product.barcode.trim();
  return {
    barcode,
    sku: product.stockCode || product.productMainId || barcode,
    name: product.title || barcode,
    categoryName: product.categoryName || "Trendyol",
    currentSalePrice: Number(product.salePrice ?? 0),
    listPrice: product.listPrice === undefined ? undefined : Number(product.listPrice),
    stock: Math.max(0, Math.floor(Number(product.quantity ?? 0))),
    desi:
      product.dimensionalWeight === undefined
        ? undefined
        : Number(product.dimensionalWeight),
    imageUrl,
    isActive: product.archived ? false : true,
    source: "trendyol",
    trendyolId: String(product.id ?? product.productCode ?? ""),
    productMainId: product.productMainId ?? null,
  };
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const input = Schema.parse(await req.json().catch(() => ({})));
    const client = new TrendyolClient(await getTrendyolCredentials());

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let totalElements = 0;
  let totalPages = 0;
  let processedPages = 0;

  for (let page = input.startPage; page < input.startPage + input.maxPages; page += 1) {
    const result = await client.listProducts({
      page,
      size: input.size,
      approved: input.approved,
      archived: input.archived,
    });

    const products = result.content ?? [];
    totalElements = result.totalElements ?? totalElements;
    totalPages = result.totalPages ?? totalPages;
    processedPages += 1;

    if (products.length === 0) break;

    for (const trendyolProduct of products) {
      if (!trendyolProduct.barcode) {
        skipped += 1;
        continue;
      }

      const data = mapProduct(trendyolProduct);
      const existing = await prisma.product.findUnique({
        where: { barcode: data.barcode },
        select: { id: true, source: true },
      });

      if (!existing) {
        // Shopify ana ürünü yok — UnmatchedListing'e ekle, ürün oluşturma
        await prisma.$executeRawUnsafe(
          `INSERT INTO UnmatchedListing (id, platform, externalId, externalSku, barcode, name, categoryName, price, stock, imageUrl, lastSeenAt, createdAt)
           VALUES (?, 'trendyol', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT(platform, externalId) DO UPDATE SET
             externalSku=excluded.externalSku,
             barcode=excluded.barcode,
             name=excluded.name,
             categoryName=excluded.categoryName,
             price=excluded.price,
             stock=excluded.stock,
             imageUrl=excluded.imageUrl,
             lastSeenAt=CURRENT_TIMESTAMP`,
          `unmatched_trendyol_${data.trendyolId || data.barcode}`,
          data.trendyolId,
          data.sku,
          data.barcode,
          data.name,
          data.categoryName,
          data.currentSalePrice,
          data.stock,
          data.imageUrl
        );
        skipped += 1;
        continue;
      }

      // Mevcut ana ürün var — Trendyol external referansları güncelle, ana ürünü değiştirme
      await prisma.product.update({
        where: { id: existing.id },
        data: {
          trendyolId: data.trendyolId,
          productMainId: data.productMainId,
        },
      });
      updated += 1;

      // Trendyol Listing upsert
      const existingListing = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM Listing WHERE productId = ? AND platform = 'trendyol' LIMIT 1`,
        existing.id
      );

      if (existingListing.length > 0) {
        await prisma.$executeRawUnsafe(
          `UPDATE Listing SET externalId = ?, externalSku = ?, salePrice = ?, listPrice = ?, stock = ?, isActive = ?, lastSyncedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
          data.trendyolId,
          data.sku,
          data.currentSalePrice,
          data.listPrice ?? null,
          data.stock,
          data.isActive ? 1 : 0,
          existingListing[0].id
        );
      } else {
        const listingId = `listing_${existing.id}_trendyol`;
        await prisma.$executeRawUnsafe(
          `INSERT INTO Listing (id, productId, platform, externalId, externalSku, salePrice, listPrice, stock, isActive, lastSyncedAt, createdAt, updatedAt)
           VALUES (?, ?, 'trendyol', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          listingId,
          existing.id,
          data.trendyolId,
          data.sku,
          data.currentSalePrice,
          data.listPrice ?? null,
          data.stock,
          data.isActive ? 1 : 0
        );
      }
    }

    if (result.totalPages !== undefined && page >= result.totalPages - 1) break;
  }

  await prisma.appSetting.upsert({
    where: { key: "trendyolLastSyncAt" },
    create: { key: "trendyolLastSyncAt", value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });

    return NextResponse.json({
      created,
      updated,
      skipped,
      totalElements,
      totalPages,
      processedPages,
      nextPage: input.startPage + processedPages,
    });
  } catch (error) {
    return jsonError(error);
  }
}
