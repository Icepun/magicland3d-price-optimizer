/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { HepsiburadaClient } from "@/services/hepsiburada-client";
import { getHepsiburadaCredentials } from "@/services/hepsiburada-settings";
import { jsonError } from "@/lib/api-error";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

/**
 * Hepsiburada ürün/listing senkronu (Shopify ana ürün kaynağı):
 *  - "add-new":        barkodu/SKU'su eşleşen HB listing'lerini Listing olarak bağla; eşleşmeyenleri
 *                      UnmatchedListing havuzunda tazele ("Ürün Seç" ile manuel eşleştirilir).
 *  - "refresh-prices": mevcut HB listing'lerinde değişen fiyat/stok'u yaz.
 *  - "full":           ikisi birden.
 *
 * SADECE AKTİF ürünler: satışta + tükenen (stok 0). Satıcı-kapalı (deactivationReasons "ByMerchant"),
 * kilitli (isLocked), askıda/dondurulmuş (isSuspended/isFrozen) ATLANIR.
 *
 * İSİM/BARKOD: Listing API'si sadece sku/fiyat/stok verir → ürün ADI + HB barkodu KATALOG'tan
 * (all-products-of-merchant) merchantSku ile join edilir. (Görsel: katalog yalnız dosya adı verir,
 * çözülebilir CDN URL'i olmadığından şimdilik görsel yok.)
 */
const Schema = z.object({
  mode: z.enum(["full", "add-new", "refresh-prices"]).default("full"),
  maxPages: z.coerce.number().int().min(1).max(200).default(100),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

interface FetchedHb {
  merchantSku: string; // satıcı stok kodu — siparişlerin eşleştiği anahtar (externalSku)
  hbBarcode: string;   // HB ürün barkodu (katalog) — gösterim/referans (#7)
  hbSku: string;       // hepsiburadaSku (externalId)
  name: string;
  categoryName: string;
  price: number;
  stock: number;
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
function arrField(res: any, keys: string[]): any[] {
  if (Array.isArray(res)) return res;
  if (!res || typeof res !== "object") return [];
  for (const k of keys) if (Array.isArray(res[k])) return res[k];
  if (res.data && typeof res.data === "object") for (const k of keys) if (Array.isArray(res.data[k])) return res.data[k];
  return [];
}

/** Listing AKTİF mi? Kilitli/askıda/dondurulmuş VEYA satıcı-kapalı (ByMerchant) → HARİÇ.
 *  Boş deactivationReasons (satışta) veya sadece stok/fiyat-0 (tükendi) → DAHİL. (Canlı veriyle doğrulandı.) */
function isActiveHbListing(item: any): boolean {
  if (item?.isLocked === true || item?.isSuspended === true || item?.isFrozen === true) return false;
  const reasons = Array.isArray(item?.deactivationReasons) ? item.deactivationReasons : [];
  if (reasons.includes("ByMerchant")) return false;
  return true;
}

interface CatalogInfo { productName: string; barcode: string; categoryName: string }

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const input = Schema.parse(await req.json().catch(() => ({})));
    const client = new HepsiburadaClient(await getHepsiburadaCredentials());

    // 1) KATALOG: merchantSku → ürün adı + HB barkod + kategori (isim/barkod zenginleştirme).
    const catalog = new Map<string, CatalogInfo>();
    for (let page = 0; page < 60; page++) {
      const res = (await client.listCatalogProducts({ page, size: 100 })) as any;
      const items = arrField(res, ["data", "content", "products", "items"]);
      for (const it of items as any[]) {
        const msku = firstStr(it.merchantSku, it.stockCode);
        if (!msku || catalog.has(msku)) continue;
        catalog.set(msku, {
          productName: firstStr(it.productName, it.title, it.name),
          barcode: firstStr(it.barcode, it.gtin),
          categoryName: firstStr(it.categoryName, it.category),
        });
      }
      const totalPages = Number(res?.totalPages);
      if (res?.last === true || items.length === 0 || (Number.isFinite(totalPages) && page + 1 >= totalPages)) break;
    }

    // 2) LISTING'ler (fiyat/stok/aktiflik) — sayfalı; SADECE AKTİF + katalogla join. Key = merchantSku.
    const fetched = new Map<string, FetchedHb>();
    for (let page = 0; page < input.maxPages; page += 1) {
      const res = await client.listListings({ offset: page * input.limit, limit: input.limit });
      const items = arrField(res, ["listings", "items", "data", "content", "products", "result"]);
      if (items.length === 0) break;
      for (const it of items as any[]) {
        if (!isActiveHbListing(it)) continue;
        const msku = firstStr(it.merchantSku, it.stockCode, it.sku);
        if (!msku || fetched.has(msku)) continue;
        const cat = catalog.get(msku);
        fetched.set(msku, {
          merchantSku: msku,
          hbBarcode: firstStr(cat?.barcode, it.barcode) || msku,
          hbSku: firstStr(it.hepsiburadaSku, it.listingId, it.productId) || msku,
          name: firstStr(cat?.productName) || msku,
          categoryName: firstStr(cat?.categoryName) || "Hepsiburada",
          price: num(it.price ?? it.salePrice ?? it.listingPrice),
          stock: Math.max(0, Math.floor(num(it.availableStock ?? it.stock ?? it.quantity))),
        });
      }
      if (items.length < input.limit) break;
    }

    async function refreshPrices() {
      // HB Listing → fetched eşlemesi externalSku (=merchantSku) ile (product.barcode = Trendyol barkodu, DEĞİL).
      const rows = await prisma.$queryRawUnsafe<
        Array<{ listingId: string; salePrice: number; productId: string; externalSku: string | null; barcode: string | null }>
      >(
        `SELECT l.id AS listingId, l.salePrice AS salePrice, l.productId AS productId, l.externalSku AS externalSku, l.barcode AS barcode
         FROM Listing l WHERE l.platform = 'hepsiburada'`
      );
      const byBarcode = new Map<string, FetchedHb>();
      for (const f of fetched.values()) byBarcode.set(f.hbBarcode, f);
      let changed = 0;
      const history: { productId: string; oldPrice: number; newPrice: number; changeSource: string }[] = [];
      for (const row of rows) {
        const f = (row.externalSku && fetched.get(row.externalSku)) || (row.barcode && byBarcode.get(row.barcode)) || null;
        if (!f) continue;
        if (Math.abs(f.price - row.salePrice) <= 0.001) continue;
        history.push({ productId: row.productId, oldPrice: row.salePrice, newPrice: f.price, changeSource: "hepsiburada_sync" });
        await prisma.$executeRawUnsafe(
          `UPDATE Listing SET salePrice = ?, stock = ?, lastSyncedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
          f.price, f.stock, row.listingId
        );
        changed++;
      }
      if (history.length) await prisma.priceHistory.createMany({ data: history });
      return { checked: rows.length, changed };
    }

    async function addNew() {
      const prods = await prisma.$queryRawUnsafe<Array<{ id: string; barcode: string; sku: string }>>(`SELECT id, barcode, sku FROM Product`);
      const keyToProductId = new Map<string, string>();
      for (const p of prods) { if (p.barcode) keyToProductId.set(p.barcode, p.id); if (p.sku) keyToProductId.set(p.sku, p.id); }
      const listed = await prisma.$queryRawUnsafe<Array<{ productId: string }>>(
        `SELECT productId FROM Listing WHERE platform = 'hepsiburada'`
      );
      const listedSet = new Set(listed.map((l) => l.productId));

      let linked = 0;
      let unmatched = 0;
      for (const f of fetched.values()) {
        // HB barkodu VEYA merchantSku ürünün barcode/sku'suyla tutarsa otomatik bağla; tutmazsa havuz.
        const productId = keyToProductId.get(f.hbBarcode) || keyToProductId.get(f.merchantSku);
        if (productId) {
          if (!listedSet.has(productId)) {
            await prisma.$executeRawUnsafe(
              `INSERT INTO Listing (id, productId, platform, externalId, externalSku, barcode, salePrice, listPrice, stock, isActive, lastSyncedAt, createdAt, updatedAt)
               VALUES (?, ?, 'hepsiburada', ?, ?, ?, ?, NULL, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
              `listing_${productId}_hepsiburada`, productId, f.hbSku, f.merchantSku, f.hbBarcode, f.price, f.stock
            );
            listedSet.add(productId);
            linked++;
          }
        } else {
          await prisma.$executeRawUnsafe(
            `INSERT INTO UnmatchedListing (id, platform, externalId, externalSku, barcode, name, categoryName, price, stock, imageUrl, lastSeenAt, createdAt)
             VALUES (?, 'hepsiburada', ?, ?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(platform, externalId) DO UPDATE SET
               externalSku=excluded.externalSku, barcode=excluded.barcode, name=excluded.name,
               categoryName=excluded.categoryName, price=excluded.price, stock=excluded.stock, lastSeenAt=CURRENT_TIMESTAMP`,
            `unmatched_hepsiburada_${f.hbSku || f.merchantSku}`, f.hbSku, f.merchantSku, f.hbBarcode, f.name, f.categoryName, f.price, f.stock
          );
          unmatched++;
        }
      }

      // Temizlik: artık AKTİF listede olmayan HB unmatched'leri sil (kapatılan/kilitlenen/silinen).
      // (Tüm aktif set güvenle çekildi — herhangi bir sayfa hatası tüm sync'i throw eder, buraya gelinmez.)
      // keepIds boşsa (hiç aktif ürün gelmedi — muhtemelen geçici API durumu) → TEMİZLİK YOK (veri silme riski).
      const keepIds = [...fetched.values()].map((f) => `unmatched_hepsiburada_${f.hbSku || f.merchantSku}`);
      if (keepIds.length) {
        const ph = keepIds.map(() => "?").join(",");
        await prisma.$executeRawUnsafe(
          `DELETE FROM UnmatchedListing WHERE platform = 'hepsiburada' AND id NOT IN (${ph})`,
          ...keepIds
        );
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

    return NextResponse.json({ mode: input.mode, fetched: fetched.size, catalog: catalog.size, ...result });
  } catch (error) {
    return jsonError(error);
  }
}
