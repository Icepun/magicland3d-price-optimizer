import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ShopifyClient } from "@/services/shopify-client";
import { getShopifyCredentials } from "@/services/shopify-settings";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

/**
 * Shopify ürünlerini ana ürün listesi olarak çeker.
 *
 * - Status: "any" (active + draft + archived)
 * - Her variant için Product (barcode anahtar). Variant'ta barkod yoksa SKU'yu barkod olarak kullanır.
 * - Her variant için Shopify Listing oluşturur.
 *
 * Detaylı teşhis döner: totalProducts, totalVariants, missingIdentifier, vs.
 */
export async function POST() {
  try {
    await ensureRuntimeSchema();
    const credentials = await getShopifyCredentials();
    const client = new ShopifyClient(credentials);

    // Storefront API sadece "active" döner; draft/archived görünmez
    const shopifyProducts = await client.listAllProducts();

    const stats = {
      totalProducts: shopifyProducts.length,
      totalVariants: 0,
      usedBarcode: 0,
      usedSku: 0,
      usedVariantId: 0,
      created: 0,
      updated: 0,
      listingsCreated: 0,
      listingsUpdated: 0,
      sampleProducts: [] as Array<{ title: string; variantCount: number; hasBarcode: boolean }>,
    };

    // İlk 5 ürünü teşhis için raporla
    for (const p of shopifyProducts.slice(0, 5)) {
      stats.sampleProducts.push({
        title: p.title,
        variantCount: p.variants?.length ?? 0,
        hasBarcode: p.variants?.some((v) => Boolean(v.barcode)) ?? false,
      });
    }

    for (const product of shopifyProducts) {
      const variants = product.variants ?? [];
      stats.totalVariants += variants.length;

      for (const variant of variants) {
        // Identifier önceliği: barcode > sku > shopify variant ID
        // Variant ID kalıcı + benzersiz; ürün barkodsuz olsa da Shopify katalogunu
        // ana ürün listesi olarak kullanabiliriz. Trendyol/HB eşleştirmesi
        // sonradan manuel "Ürün Seç" modalı ile yapılır.
        let barcode: string;
        if (variant.barcode?.trim()) {
          barcode = variant.barcode.trim();
          stats.usedBarcode++;
        } else if (variant.sku?.trim()) {
          barcode = variant.sku.trim();
          stats.usedSku++;
        } else {
          barcode = `shopify-variant-${variant.id}`;
          stats.usedVariantId++;
        }
        const productName = `${product.title}${variant.title && variant.title !== "Default Title" ? ` — ${variant.title}` : ""}`;
        const price = Number(variant.price);

        const existingProduct = await prisma.product.findUnique({ where: { barcode } });

        let productId: string;
        if (existingProduct) {
          productId = existingProduct.id;
          stats.updated++;
        } else {
          const newProduct = await prisma.product.create({
            data: {
              barcode,
              sku: variant.sku || barcode,
              name: productName,
              categoryName: product.product_type || "Shopify",
              currentSalePrice: price || 0,
              stock: variant.inventory_quantity ?? 0,
              imageUrl: product.image?.src ?? null,
              isActive: product.status !== "archived",
              source: "shopify",
            },
          });
          productId = newProduct.id;
          stats.created++;
        }

        // Shopify Listing upsert
        const externalId = String(variant.id);
        const existingListing = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM Listing WHERE productId = ? AND platform = 'shopify' LIMIT 1`,
          productId
        );

        if (existingListing.length > 0) {
          await prisma.$executeRawUnsafe(
            `UPDATE Listing SET externalId = ?, externalSku = ?, salePrice = ?, stock = ?, isActive = 1, lastSyncedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
            externalId,
            variant.sku || barcode,
            price || 0,
            variant.inventory_quantity ?? 0,
            existingListing[0].id
          );
          stats.listingsUpdated++;
        } else {
          const id = `listing_${productId}_shopify`;
          await prisma.$executeRawUnsafe(
            `INSERT INTO Listing (id, productId, platform, externalId, externalSku, salePrice, stock, isActive, lastSyncedAt, createdAt, updatedAt)
             VALUES (?, ?, 'shopify', ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            id,
            productId,
            externalId,
            variant.sku || barcode,
            price || 0,
            variant.inventory_quantity ?? 0
          );
          stats.listingsCreated++;
        }
      }
    }

    await prisma.appSetting.upsert({
      where: { key: "shopifyLastSyncAt" },
      create: { key: "shopifyLastSyncAt", value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    });

    return NextResponse.json(stats);
  } catch (error) {
    return jsonError(error);
  }
}
