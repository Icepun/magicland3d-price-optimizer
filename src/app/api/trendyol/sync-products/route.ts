import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { TrendyolClient, type TrendyolProduct } from "@/services/trendyol-client";
import { getTrendyolCredentials } from "@/services/trendyol-settings";
import { jsonError } from "@/lib/api-error";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

/**
 * Trendyol ürün senkronu — 3 mod (Shopify ana ürün kaynağı, Trendyol eşleşen listing):
 *  - "add-new":        eşleşen (barkodu Shopify ürünüyle aynı) Trendyol ürünlerini
 *                      Listing olarak bağla; eşleşmeyenleri UnmatchedListing havuzunda tazele.
 *  - "refresh-prices": mevcut Trendyol listing'lerinde SADECE değişen fiyatı yaz.
 *  - "full":           ikisi birden.
 *
 * Turso'da okuma bedava, yazma pahalı → bol oku, yalnızca gerekeni yaz.
 */
const Schema = z.object({
  mode: z.enum(["full", "add-new", "refresh-prices"]).default("full"),
  approved: z.boolean().default(true),
  maxPages: z.coerce.number().int().min(1).max(100).default(50),
  size: z.coerce.number().int().min(1).max(100).default(100),
});

interface FetchedTrendyol {
  barcode: string;
  sku: string;
  name: string;
  categoryName: string;
  price: number;
  listPrice: number | null;
  stock: number;
  imageUrl: string | null;
  trendyolId: string;
  productMainId: string | null;
  isActive: boolean;
}

function mapProduct(p: TrendyolProduct): FetchedTrendyol {
  const barcode = p.barcode.trim();
  return {
    barcode,
    sku: p.stockCode || p.productMainId || barcode,
    name: p.title || barcode,
    categoryName: p.categoryName || "Trendyol",
    price: Number(p.salePrice ?? 0),
    listPrice: p.listPrice === undefined ? null : Number(p.listPrice),
    stock: Math.max(0, Math.floor(Number(p.quantity ?? 0))),
    imageUrl: p.images?.[0]?.url || null,
    trendyolId: String(p.id ?? p.productCode ?? ""),
    productMainId: p.productMainId ?? null,
    isActive: !p.archived,
  };
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const input = Schema.parse(await req.json().catch(() => ({})));
    const client = new TrendyolClient(await getTrendyolCredentials());

    // Tüm sayfaları çek → barcode -> veri
    const fetched = new Map<string, FetchedTrendyol>();
    let totalElements = 0;
    for (let page = 0; page < input.maxPages; page += 1) {
      const res = await client.listProducts({ page, size: input.size, approved: input.approved });
      const products = res.content ?? [];
      totalElements = res.totalElements ?? totalElements;
      if (products.length === 0) break;
      for (const tp of products) {
        if (!tp.barcode?.trim()) continue;
        const data = mapProduct(tp);
        if (!fetched.has(data.barcode)) fetched.set(data.barcode, data);
      }
      if (res.totalPages !== undefined && page >= res.totalPages - 1) break;
    }

    // ── refresh-prices: yalnızca değişen fiyatı yaz ──────────────────────────
    async function refreshPrices() {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ listingId: string; salePrice: number; barcode: string }>
      >(
        `SELECT l.id AS listingId, l.salePrice AS salePrice, p.barcode AS barcode
         FROM Listing l JOIN Product p ON l.productId = p.id
         WHERE l.platform = 'trendyol'`
      );
      let changed = 0;
      for (const row of rows) {
        const f = fetched.get(row.barcode);
        if (!f) continue;
        if (Math.abs(f.price - row.salePrice) <= 0.001) continue;
        await prisma.$executeRawUnsafe(
          `UPDATE Listing SET salePrice = ?, listPrice = ?, lastSyncedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
          f.price,
          f.listPrice,
          row.listingId
        );
        changed++;
      }
      return { checked: rows.length, changed };
    }

    // ── add-new: eşleşeni bağla, kalanı UnmatchedListing'e ────────────────────
    async function addNew() {
      const prods = await prisma.$queryRawUnsafe<Array<{ id: string; barcode: string }>>(
        `SELECT id, barcode FROM Product`
      );
      const barcodeToProductId = new Map(prods.map((p) => [p.barcode, p.id]));
      const listed = await prisma.$queryRawUnsafe<Array<{ productId: string }>>(
        `SELECT productId FROM Listing WHERE platform = 'trendyol'`
      );
      const listedSet = new Set(listed.map((l) => l.productId));

      let linked = 0;
      let unmatched = 0;
      for (const [barcode, f] of fetched) {
        const productId = barcodeToProductId.get(barcode);
        if (productId) {
          if (!listedSet.has(productId)) {
            await prisma.$executeRawUnsafe(
              `INSERT INTO Listing (id, productId, platform, externalId, externalSku, salePrice, listPrice, stock, isActive, lastSyncedAt, createdAt, updatedAt)
               VALUES (?, ?, 'trendyol', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
              `listing_${productId}_trendyol`,
              productId,
              f.trendyolId,
              f.sku,
              f.price,
              f.listPrice,
              f.stock,
              f.isActive ? 1 : 0
            );
            listedSet.add(productId);
            linked++;
          }
          // zaten listing varsa add-new dokunmaz (fiyat = refresh-prices'in işi)
        } else {
          await prisma.$executeRawUnsafe(
            `INSERT INTO UnmatchedListing (id, platform, externalId, externalSku, barcode, name, categoryName, price, stock, imageUrl, lastSeenAt, createdAt)
             VALUES (?, 'trendyol', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(platform, externalId) DO UPDATE SET
               externalSku=excluded.externalSku, barcode=excluded.barcode, name=excluded.name,
               categoryName=excluded.categoryName, price=excluded.price, stock=excluded.stock,
               imageUrl=excluded.imageUrl, lastSeenAt=CURRENT_TIMESTAMP`,
            `unmatched_trendyol_${f.trendyolId || barcode}`,
            f.trendyolId,
            f.sku,
            barcode,
            f.name,
            f.categoryName,
            f.price,
            f.stock,
            f.imageUrl
          );
          unmatched++;
        }
      }
      return { linked, unmatched };
    }

    let result: Record<string, number> = {};
    if (input.mode === "refresh-prices") {
      result = await refreshPrices();
    } else if (input.mode === "add-new") {
      result = await addNew();
    } else {
      const a = await addNew();
      const r = await refreshPrices();
      result = { ...a, ...r };
    }

    await prisma.appSetting.upsert({
      where: { key: "trendyolLastSyncAt" },
      create: { key: "trendyolLastSyncAt", value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    });

    return NextResponse.json({ mode: input.mode, totalElements, ...result });
  } catch (error) {
    return jsonError(error);
  }
}
