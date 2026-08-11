import { randomUUID } from "node:crypto";
import { batchWrite } from "@/lib/libsql-batch";
import { bustProductCaches } from "@/lib/cache-busting";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ShopifyClient, type ShopifyProductVariant } from "@/services/shopify-client";
import { getShopifyCredentials } from "@/services/shopify-settings";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { matchByPriority, uniqueIndex } from "@/lib/listing-index";

/**
 * Shopify ürün senkronu — 3 mod:
 *  - "add-new":        sadece YENİ ürünleri ekle (mevcutlara dokunma) → yazma ~0
 *  - "refresh-prices": mevcut listing'lerde SADECE değişen fiyatı yaz → yazma ~0
 *  - "full":           ikisi birden (yeni ekle + fiyat tazele)
 *
 * Turso embedded replica'da okuma bedava (yerel), yazma pahalı (eu-west-1). Bu yüzden
 * her iki mod da bol okuyup yalnızca gerekeni yazar — eski "her variant'ı upsert" yok.
 *
 * YAZMA BİÇİMİ: toplanan ifadeler TEK batch'te gönderilir (Trendyol/Hepsiburada ile aynı desen).
 * Eskiden her satır ayrı round-trip'ti: uzak-HTTP modunda ifade başına ~96ms ve bu süre boyunca
 * süreçteki HER sorgu aynı mutex'te bekliyordu → ilk kurulumda birkaç yüz ürün = dakikalarca
 * tam kilit. batchWrite() uygun olmayan modda (embedded replica) false döner → sıralı yola düşeriz.
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
  /** Ürün eşleştirme anahtarı: barkod → yoksa stok kodu → yoksa varyant kimliği. */
  identifier: string;
  price: number;
  sku: string;
  stock: number;
  name: string;
  categoryName: string;
  imageUrl: string | null;
  variantId: string;
  archived: boolean;
}

type Write = { sql: string; args: unknown[] };

/** Toplanan ifadeleri tek istekte gönder; mod uygun değilse (embedded replica) sıralı yola düş. */
async function flushWrites(writes: Write[]): Promise<void> {
  if (writes.length === 0) return;
  if (await batchWrite(writes)) return;
  for (const w of writes) {
    await prisma.$executeRawUnsafe(w.sql, ...(w.args as never[]));
  }
}

async function stampSync() {
  await prisma.appSetting.upsert({
    where: { key: "shopifyLastSyncAt" },
    create: { key: "shopifyLastSyncAt", value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });
}

const PRODUCT_SQL = `INSERT INTO Product (id, barcode, sku, name, categoryName, currentSalePrice, stock, imageUrl, isActive, source, createdAt, updatedAt)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'shopify', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
const LISTING_SQL = `INSERT INTO Listing (id, productId, platform, externalId, externalSku, salePrice, stock, isActive, lastSyncedAt, createdAt, updatedAt)
   VALUES (?, ?, 'shopify', ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
const LISTING_PRICE_SQL = `UPDATE Listing SET salePrice = ?, lastSyncedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`;
const PRODUCT_PRICE_SQL = `UPDATE Product SET currentSalePrice = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`;
const PRODUCT_IMAGE_SQL = `UPDATE Product SET imageUrl = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`;
/**
 * Yalnız İLAN stoğu. Ürünün GERÇEK stoğu uygulamada elle tutuluyor ve buradan ASLA ezilmez.
 * Bu değerin tek amacı "sitede stok bitmiş mi?" uyarısını besleyebilmek — mağaza sayfası
 * satışa kapanmışsa kullanıcı bunu fark etmeden öğrensin.
 */
const LISTING_STOCK_SQL = `UPDATE Listing SET stock = ?, lastSyncedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`;

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const { mode } = Schema.parse(await req.json().catch(() => ({})));
    const credentials = await getShopifyCredentials();
    const client = new ShopifyClient(credentials);
    const shopifyProducts = await client.listAllProducts();

    // Çekilen variant'ları düzleştir.
    //  - fetched: identifier (barcode/sku/variant-fallback) → YENİ ürün eklemenin anahtarı
    //  - all:     eşleştirme indeksleri bunun üzerinden kurulur
    const fetched = new Map<string, FetchedVariant>();
    const all: FetchedVariant[] = [];
    let totalVariants = 0;
    for (const product of shopifyProducts) {
      for (const variant of product.variants ?? []) {
        totalVariants++;
        const id = identifierFor(variant);
        const name = `${product.title}${
          variant.title && variant.title !== "Default Title" ? ` — ${variant.title}` : ""
        }`;
        const data: FetchedVariant = {
          identifier: id,
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
        all.push(data);
        if (!fetched.has(id)) fetched.set(id, data); // aynı identifier'da ilk gelen kazanır
      }
    }

    // ── refresh-prices: yalnızca değişen fiyatı yaz ──────────────────────────
    async function refreshPrices() {
      const rows = await prisma.$queryRawUnsafe<
        Array<{
          listingId: string;
          listingPrice: number;
          listingStock: number;
          productId: string;
          barcode: string;
          variantId: string | null;
          sku: string | null;
          listingSku: string | null;
          listingBarcode: string | null;
          productPrice: number;
          imageUrl: string | null;
          imageManual: number;
        }>
      >(
        `SELECT l.id AS listingId, l.salePrice AS listingPrice, l.stock AS listingStock, p.id AS productId,
                p.barcode AS barcode, l.externalId AS variantId, p.sku AS sku, l.externalSku AS listingSku,
                l.barcode AS listingBarcode,
                p.currentSalePrice AS productPrice, p.imageUrl AS imageUrl, p.imageManual AS imageManual
         FROM Listing l JOIN Product p ON l.productId = p.id
         WHERE l.platform = 'shopify'`
      );
      // Belirsiz anahtarlar (aynı SKU'yu paylaşan varyantlar) indeksten DÜŞER — kör eşleşme
      // yanlış varyantın fiyatını yazardı. Bkz. lib/listing-index.
      const byVariantId = uniqueIndex(all, (f) => f.variantId);
      const byIdentifier = uniqueIndex(all, (f) => f.identifier);
      const bySku = uniqueIndex(all, (f) => f.sku);

      let changed = 0;
      let imagesFixed = 0;
      const writes: Write[] = [];
      const history: { productId: string; oldPrice: number; newPrice: number; changeSource: string }[] = [];
      for (const row of rows) {
        // Güven sırası: Shopify varyant kimliği > ilan barkodu > ürün barkodu > ilan stok kodu > ürün stok kodu.
        // Kullanıcı ürün barkodunu (sipariş eşleştirmesi için) elle değiştirmiş olabilir; bu yüzden
        // önce DEĞİŞMEZ varyant kimliği denenir, barkodsuz (yalnız SKU'lu) ürünler de eşleşsin diye
        // SKU indeksine düşülür.
        const f = matchByPriority<FetchedVariant>([
          [row.variantId, byVariantId],
          [row.listingBarcode, byIdentifier],
          [row.barcode, byIdentifier],
          [row.listingSku, bySku],
          [row.sku, bySku],
        ]);
        if (!f) continue;
        // Görsel backfill/düzeltme — yalnızca elle ayarlanmamış (imageManual=0) ürünlerde,
        // ve gerçekten değişmişse (diff-write → tekrar tekrar yazma yok).
        if (!row.imageManual && f.imageUrl && f.imageUrl !== row.imageUrl) {
          writes.push({ sql: PRODUCT_IMAGE_SQL, args: [f.imageUrl, row.productId] });
          imagesFixed++;
        }
        // Site stoğu değiştiyse ilan stoğunu tazele (yalnız DEĞİŞMİŞSE — gereksiz yazma yok).
        if (f.stock !== row.listingStock) {
          writes.push({ sql: LISTING_STOCK_SQL, args: [f.stock, row.listingId] });
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
          writes.push({ sql: LISTING_PRICE_SQL, args: [f.price, row.listingId] });
        }
        if (productChanged) {
          writes.push({ sql: PRODUCT_PRICE_SQL, args: [f.price, row.productId] });
        }
        changed++;
      }

      await flushWrites(writes);
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
      // Ürün + ilan ifadeleri ARDIŞIK ve ÇİFT hâlinde toplanır: batch 500'lük dilimlere bölünürken
      // (çift sayı) bir ürünün ilanı asla ayrı dilime düşmez.
      const writes: Write[] = [];
      for (const [id, f] of fetched) {
        if (existingSet.has(id)) continue;
        const productId = `shp_${randomUUID().replace(/-/g, "")}`;
        writes.push({
          sql: PRODUCT_SQL,
          args: [
            productId,
            id,
            f.sku,
            f.name,
            f.categoryName,
            f.price,
            f.stock,
            f.imageUrl,
            f.archived ? 0 : 1,
          ],
        });
        writes.push({
          sql: LISTING_SQL,
          args: [`listing_${productId}_shopify`, productId, f.variantId, f.sku, f.price, f.stock],
        });
        existingSet.add(id);
        added++;
      }

      await flushWrites(writes);
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
    // Senkron DB'yi değiştirdi → ürün/panel önbellekleri ve sipariş kârı tazelensin.
    // (Bu olmadan "Yenile" bitiyor ama liste 2 dakika ESKİ fiyatı gösteriyordu.)
    bustProductCaches();
    return NextResponse.json({ mode, totalProducts: shopifyProducts.length, totalVariants, ...result });
  } catch (error) {
    return jsonError(error);
  }
}
