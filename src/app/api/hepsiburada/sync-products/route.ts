/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { HepsiburadaClient } from "@/services/hepsiburada-client";
import { getHepsiburadaCredentials } from "@/services/hepsiburada-settings";
import { jsonError } from "@/lib/api-error";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

/**
 * Hepsiburada ürün/listing senkronu — Trendyol ile aynı mantık (Shopify ana ürün kaynağı):
 *  - "add-new":        barkodu eşleşen HB listing'lerini Listing olarak bağla; eşleşmeyenleri
 *                      UnmatchedListing havuzunda tazele ("Ürün Seç" ile manuel eşleştirilir).
 *  - "refresh-prices": mevcut HB listing'lerinde yalnızca değişen fiyatı yaz.
 *  - "full":           ikisi birden.
 *
 * NOT: HB listing yanıt şekli hesapla doğrulanana dek DEFANSİF okunuyor (çok olası alan adları
 * denenir). Test'te gerçek örneği görünce mapListing tek yerde keskinleştirilir.
 */
const Schema = z.object({
  mode: z.enum(["full", "add-new", "refresh-prices"]).default("full"),
  maxPages: z.coerce.number().int().min(1).max(200).default(100),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

interface FetchedHb {
  barcode: string;
  sku: string;
  name: string;
  categoryName: string;
  price: number;
  listPrice: number | null;
  stock: number;
  imageUrl: string | null;
  hbId: string;
  isActive: boolean;
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "amount" in (v as any)) return Number((v as any).amount) || 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function firstStr(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
}

function extractImage(item: any): string | null {
  const img = item.image ?? item.imageUrl ?? (Array.isArray(item.images) ? item.images[0] : undefined);
  if (!img) return null;
  if (typeof img === "string") return img;
  if (typeof img === "object" && img.url) return String(img.url);
  return null;
}

/** HB listing yanıtından öğeleri çıkar (olası saklayıcı alanlar). */
function extractItems(res: any): any[] {
  if (Array.isArray(res)) return res;
  if (!res || typeof res !== "object") return [];
  for (const key of ["listings", "items", "data", "content", "products", "result"]) {
    if (Array.isArray(res[key])) return res[key];
  }
  // data.listings gibi iç içe
  if (res.data && typeof res.data === "object") {
    for (const key of ["listings", "items", "content", "products"]) {
      if (Array.isArray(res.data[key])) return res.data[key];
    }
  }
  return [];
}

function mapListing(item: any): FetchedHb | null {
  const barcode = firstStr(item.barcode, item.productBarcode, item.gtin, item.merchantSku, item.stockCode);
  if (!barcode) return null;
  const hbId = firstStr(item.hepsiburadaSku, item.listingId, item.id, item.merchantSku, barcode);
  return {
    barcode,
    sku: firstStr(item.merchantSku, item.stockCode, item.sku, barcode),
    name: firstStr(item.productName, item.title, item.name, item.description) || barcode,
    categoryName: firstStr(item.categoryName, item.category) || "Hepsiburada",
    price: num(item.price ?? item.salePrice ?? item.listingPrice ?? item.unitPrice),
    listPrice: item.listPrice != null || item.originalPrice != null ? num(item.listPrice ?? item.originalPrice) : null,
    stock: Math.max(0, Math.floor(num(item.availableStock ?? item.stock ?? item.quantity))),
    imageUrl: extractImage(item),
    hbId,
    isActive: item.isActive ?? item.isSalable ?? (item.archived != null ? !item.archived : true),
  };
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const input = Schema.parse(await req.json().catch(() => ({})));
    const client = new HepsiburadaClient(await getHepsiburadaCredentials());

    // Tüm sayfaları çek (offset/limit) → barcode -> veri
    const fetched = new Map<string, FetchedHb>();
    for (let page = 0; page < input.maxPages; page += 1) {
      const res = await client.listListings({ offset: page * input.limit, limit: input.limit });
      const items = extractItems(res);
      if (items.length === 0) break;
      for (const it of items) {
        const data = mapListing(it);
        if (data && !fetched.has(data.barcode)) fetched.set(data.barcode, data);
      }
      if (items.length < input.limit) break;
    }

    async function refreshPrices() {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ listingId: string; salePrice: number; productId: string; barcode: string }>
      >(
        `SELECT l.id AS listingId, l.salePrice AS salePrice, p.id AS productId, p.barcode AS barcode
         FROM Listing l JOIN Product p ON l.productId = p.id
         WHERE l.platform = 'hepsiburada'`
      );
      let changed = 0;
      const history: { productId: string; oldPrice: number; newPrice: number; changeSource: string }[] = [];
      for (const row of rows) {
        const f = fetched.get(row.barcode);
        if (!f) continue;
        if (Math.abs(f.price - row.salePrice) <= 0.001) continue;
        history.push({ productId: row.productId, oldPrice: row.salePrice, newPrice: f.price, changeSource: "hepsiburada_sync" });
        await prisma.$executeRawUnsafe(
          `UPDATE Listing SET salePrice = ?, listPrice = ?, lastSyncedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
          f.price, f.listPrice, row.listingId
        );
        changed++;
      }
      if (history.length) await prisma.priceHistory.createMany({ data: history });
      return { checked: rows.length, changed };
    }

    async function addNew() {
      const prods = await prisma.$queryRawUnsafe<Array<{ id: string; barcode: string }>>(`SELECT id, barcode FROM Product`);
      const barcodeToProductId = new Map(prods.map((p) => [p.barcode, p.id]));
      const listed = await prisma.$queryRawUnsafe<Array<{ productId: string }>>(
        `SELECT productId FROM Listing WHERE platform = 'hepsiburada'`
      );
      const listedSet = new Set(listed.map((l) => l.productId));

      let linked = 0;
      let unmatched = 0;
      for (const [barcode, f] of fetched) {
        const productId = barcodeToProductId.get(barcode);
        if (productId) {
          if (!listedSet.has(productId)) {
            await prisma.$executeRawUnsafe(
              `INSERT INTO Listing (id, productId, platform, externalId, externalSku, barcode, salePrice, listPrice, stock, isActive, lastSyncedAt, createdAt, updatedAt)
               VALUES (?, ?, 'hepsiburada', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
              `listing_${productId}_hepsiburada`, productId, f.hbId, f.sku, barcode, f.price, f.listPrice, f.stock, f.isActive ? 1 : 0
            );
            listedSet.add(productId);
            linked++;
          }
        } else {
          await prisma.$executeRawUnsafe(
            `INSERT INTO UnmatchedListing (id, platform, externalId, externalSku, barcode, name, categoryName, price, stock, imageUrl, lastSeenAt, createdAt)
             VALUES (?, 'hepsiburada', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(platform, externalId) DO UPDATE SET
               externalSku=excluded.externalSku, barcode=excluded.barcode, name=excluded.name,
               categoryName=excluded.categoryName, price=excluded.price, stock=excluded.stock,
               imageUrl=excluded.imageUrl, lastSeenAt=CURRENT_TIMESTAMP`,
            `unmatched_hepsiburada_${f.hbId || barcode}`, f.hbId, f.sku, barcode, f.name, f.categoryName, f.price, f.stock, f.imageUrl
          );
          unmatched++;
        }
      }
      return { linked, unmatched };
    }

    let result: Record<string, number> = {};
    if (input.mode === "refresh-prices") result = await refreshPrices();
    else if (input.mode === "add-new") result = await addNew();
    else result = { ...(await addNew()), ...(await refreshPrices()) };

    await prisma.appSetting.upsert({
      where: { key: "hepsiburadaLastSyncAt" },
      create: { key: "hepsiburadaLastSyncAt", value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    });

    return NextResponse.json({ mode: input.mode, fetched: fetched.size, ...result });
  } catch (error) {
    return jsonError(error);
  }
}
