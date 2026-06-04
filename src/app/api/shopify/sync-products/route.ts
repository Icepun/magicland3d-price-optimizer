import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ShopifyClient, type ShopifyProductVariant } from "@/services/shopify-client";
import { getShopifyCredentials } from "@/services/shopify-settings";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

/**
 * Shopify ürün senkronu — 3 mod:
 *  - "add-new":        sadece YENİ ürünleri ekle (mevcutlara dokunma) → yazma ~0
 *  - "refresh-prices": mevcut listing'lerde SADECE değişen fiyatı yaz → yazma ~0
 *  - "full":           ikisi birden (yeni ekle + fiyat tazele)
 *
 * Turso embedded replica'da okuma bedava (yerel), yazma pahalı (eu-west-1). Bu yüzden
 * her iki mod da bol okuyup yalnızca gerekeni yazar — eski "her variant'ı upsert" yok.
 */
const Schema = z.object({
  mode: z.enum(["full", "add-new", "refresh-prices"]).default("full"),
});

function identifierFor(variant: ShopifyProductVariant): string {
  if (variant.barcode?.trim()) return variant.barcode.trim();
  if (variant.sku?.trim()) return variant.sku.trim();
  return `shopify-variant-${variant.id}`;
}

interface FetchedVariant {
  price: number;
  sku: string;
  stock: number;
  name: string;
  categoryName: string;
  imageUrl: string | null;
  variantId: string;
  archived: boolean;
}

async function stampSync() {
  await prisma.appSetting.upsert({
    where: { key: "shopifyLastSyncAt" },
    create: { key: "shopifyLastSyncAt", value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const { mode } = Schema.parse(await req.json().catch(() => ({})));
    const credentials = await getShopifyCredentials();
    const client = new ShopifyClient(credentials);
    const shopifyProducts = await client.listAllProducts();

    // Çekilen variant'ları düzleştir. İKİ harita:
    //  - fetched: identifier (barcode/sku/variant-fallback) → ilk kurulumdaki eşleştirme
    //  - fetchedByVariantId: Shopify variant id → DEĞİŞMEZ anahtar. Kullanıcı ürün barkodunu
    //    (Trendyol/sipariş eşleştirmesi için) elle değiştirince barkod-eşleşmesi kaçar; bu yüzden
    //    fiyat/görsel tazelemesi Listing.externalId (=variant id) ile yapılır → barkoddan bağımsız.
    const fetched = new Map<string, FetchedVariant>();
    const fetchedByVariantId = new Map<string, FetchedVariant>();
    let totalVariants = 0;
    for (const product of shopifyProducts) {
      for (const variant of product.variants ?? []) {
        totalVariants++;
        const id = identifierFor(variant);
        const name = `${product.title}${
          variant.title && variant.title !== "Default Title" ? ` — ${variant.title}` : ""
        }`;
        const data: FetchedVariant = {
          price: Number(variant.price) || 0,
          sku: variant.sku || id,
          stock: variant.inventory_quantity ?? 0,
          name,
          categoryName: product.product_type || "Shopify",
          // Varyanta özel görsel öncelikli; yoksa ürün featuredImage'ine düş.
          imageUrl: variant.image ?? product.image?.src ?? null,
          variantId: String(variant.id),
          archived: product.status === "archived",
        };
        fetchedByVariantId.set(data.variantId, data);
        if (!fetched.has(id)) fetched.set(id, data); // aynı identifier'da ilk gelen kazanır
      }
    }

    // ── refresh-prices: yalnızca değişen fiyatı yaz ──────────────────────────
    async function refreshPrices() {
      const rows = await prisma.$queryRawUnsafe<
        Array<{
          listingId: string;
          listingPrice: number;
          productId: string;
          barcode: string;
          variantId: string | null;
          sku: string | null;
          listingSku: string | null;
          productPrice: number;
          imageUrl: string | null;
          imageManual: number;
        }>
      >(
        `SELECT l.id AS listingId, l.salePrice AS listingPrice, p.id AS productId,
                p.barcode AS barcode, l.externalId AS variantId, p.sku AS sku, l.externalSku AS listingSku,
                p.currentSalePrice AS productPrice, p.imageUrl AS imageUrl, p.imageManual AS imageManual
         FROM Listing l JOIN Product p ON l.productId = p.id
         WHERE l.platform = 'shopify'`
      );
      let changed = 0;
      let imagesFixed = 0;
      const history: { productId: string; oldPrice: number; newPrice: number; changeSource: string }[] = [];
      for (const row of rows) {
        // Önce DEĞİŞMEZ variant id ile eşleştir (kullanıcı barkodu değiştirmiş olabilir),
        // olmazsa barkod → SKU'ya düş. Böylece barkodu düzenlenen VEYA barkodsuz (SKU'lu) ürünlerin de
        // fiyat/görseli tazelenir. (Eskiden yalnız variantId+barkod → barkodsuzlar atlanıyordu.)
        const f =
          (row.variantId ? fetchedByVariantId.get(row.variantId) : undefined) ??
          (row.barcode ? fetched.get(row.barcode) : undefined) ??
          (row.sku ? fetched.get(row.sku) : undefined) ??
          (row.listingSku ? fetched.get(row.listingSku) : undefined);
        if (!f) continue;
        // Görsel backfill/düzeltme — yalnızca elle ayarlanmamış (imageManual=0) ürünlerde,
        // ve gerçekten değişmişse (diff-write → tekrar tekrar yazma yok).
        if (!row.imageManual && f.imageUrl && f.imageUrl !== row.imageUrl) {
          await prisma.$executeRawUnsafe(
            `UPDATE Product SET imageUrl = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
            f.imageUrl,
            row.productId
          );
          imagesFixed++;
        }
        const listingChanged = Math.abs(f.price - row.listingPrice) > 0.001;
        const productChanged = Math.abs(f.price - row.productPrice) > 0.001;
        if (!listingChanged && !productChanged) continue;
        if (listingChanged) {
          history.push({
            productId: row.productId,
            oldPrice: row.listingPrice,
            newPrice: f.price,
            changeSource: "shopify_sync",
          });
          await prisma.$executeRawUnsafe(
            `UPDATE Listing SET salePrice = ?, lastSyncedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
            f.price,
            row.listingId
          );
        }
        if (productChanged) {
          await prisma.$executeRawUnsafe(
            `UPDATE Product SET currentSalePrice = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
            f.price,
            row.productId
          );
        }
        changed++;
      }
      // Fiyat geçmişi — yalnızca değişenler, tek round-trip (Turso yazma maliyeti).
      if (history.length) await prisma.priceHistory.createMany({ data: history });
      return { checked: rows.length, changed, imagesFixed };
    }

    // ── add-new: yalnızca eksik ürünleri ekle ────────────────────────────────
    async function addNew() {
      const existing = await prisma.$queryRawUnsafe<Array<{ barcode: string }>>(
        `SELECT barcode FROM Product`
      );
      const existingSet = new Set(existing.map((r) => r.barcode));
      let added = 0;
      for (const [id, f] of fetched) {
        if (existingSet.has(id)) continue;
        const newProduct = await prisma.product.create({
          data: {
            barcode: id,
            sku: f.sku,
            name: f.name,
            categoryName: f.categoryName,
            currentSalePrice: f.price,
            stock: f.stock,
            imageUrl: f.imageUrl,
            isActive: !f.archived,
            source: "shopify",
          },
        });
        await prisma.$executeRawUnsafe(
          `INSERT INTO Listing (id, productId, platform, externalId, externalSku, salePrice, stock, isActive, lastSyncedAt, createdAt, updatedAt)
           VALUES (?, ?, 'shopify', ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          `listing_${newProduct.id}_shopify`,
          newProduct.id,
          f.variantId,
          f.sku,
          f.price,
          f.stock
        );
        existingSet.add(id);
        added++;
      }
      return { added };
    }

    let result: Record<string, number> = {};
    if (mode === "refresh-prices") {
      result = await refreshPrices();
    } else if (mode === "add-new") {
      result = await addNew();
    } else {
      // full = önce yeni ekle, sonra fiyatları tazele
      const a = await addNew();
      const r = await refreshPrices();
      result = { ...a, ...r };
    }

    await stampSync();
    return NextResponse.json({ mode, totalProducts: shopifyProducts.length, totalVariants, ...result });
  } catch (error) {
    return jsonError(error);
  }
}
