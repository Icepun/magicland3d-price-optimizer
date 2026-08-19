import { batchWrite } from "@/lib/libsql-batch";
import { bustProductCaches } from "@/lib/cache-busting";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { TrendyolClient, type TrendyolProduct } from "@/services/trendyol-client";
import { getTrendyolCredentials } from "@/services/trendyol-settings";
import { jsonError } from "@/lib/api-error";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { matchByPriority, uniqueIndex } from "@/lib/listing-index";
import { nowDbDateSql } from "@/lib/sqlite-date";

/**
 * Trendyol ürün senkronu — 3 mod (Shopify ana ürün kaynağı, Trendyol eşleşen listing):
 *  - "add-new":        eşleşen (barkodu Shopify ürünüyle aynı) Trendyol ürünlerini
 *                      Listing olarak bağla; eşleşmeyenleri UnmatchedListing havuzunda tazele.
 *  - "refresh-prices": mevcut Trendyol listing'lerinde SADECE değişen fiyatı yaz.
 *  - "full":           ikisi birden.
 *
 * Turso'da okuma bedava, yazma pahalı → bol oku, yalnızca gerekeni yaz.
 */
const Schema = z
  .object({
    mode: z.enum(["full", "add-new", "refresh-prices"]).default("full"),
    maxPages: z.coerce.number().int().min(1).max(100).default(50),
    size: z.coerce.number().int().min(1).max(100).default(100),
  })
  /**
   * ÜRÜN V2 sert sınırı: sayfa × boyut çarpımı 10.000'i geçemez (v1'de böyle bir sınır yoktu).
   * Aşan istekte son sayfalar reddedilir ve senkron sessizce eksik kalır.
   */
  .refine((v) => v.maxPages * v.size <= 10_000, {
    message: "Sayfa sayısı × sayfa boyutu 10.000'i geçemez (Trendyol Ürün v2 sınırı).",
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
  /** Trendyol'un bildirdiği komisyon oranı — KESİR (0.21). Gelmezse null. */
  commissionRate: number | null;
}

/**
 * Trendyol komisyonu YÜZDE olarak geliyor (örn. 21.0); bizim hesabımız KESİR kullanıyor
 * (`salePrice * commissionRate`). Saçma değerler (0, negatif, %100 üstü) yok sayılır —
 * yanlış bir oran kâr rakamını sessizce bozar.
 */
function komisyonKesri(v: number | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const kesir = v > 1 ? v / 100 : v;
  if (kesir <= 0 || kesir >= 1) return null;
  return Math.round(kesir * 10000) / 10000;
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
    commissionRate: komisyonKesri(p.commission),
  };
}

/** Tek SQL ifadesine sığdırılacak kimlik sayısı — çok uzun parametre listesi hata verir. */
const ID_CHUNK = 300;

interface StoredUnmatched {
  id: string;
  externalId: string | null;
  externalSku: string | null;
  barcode: string;
  name: string;
  categoryName: string | null;
  price: number;
  stock: number;
  imageUrl: string | null;
}

/** Kayıt Trendyol'daki hâliyle birebir aynı mı? Aynıysa yeniden yazmayız (yazma pahalı). */
function sameUnmatched(prev: StoredUnmatched, f: FetchedTrendyol): boolean {
  const sameText = (a: string | null, b: string | null) => (a ?? "") === (b ?? "");
  return (
    sameText(prev.externalSku, f.sku) &&
    sameText(prev.barcode, f.barcode) &&
    sameText(prev.name, f.name) &&
    sameText(prev.categoryName, f.categoryName) &&
    Math.abs(Number(prev.price) - f.price) <= 0.001 &&
    Number(prev.stock) === f.stock &&
    sameText(prev.imageUrl, f.imageUrl)
  );
}

/** Uzun kimlik listelerini SQL'e sığacak gruplara böl. */
function chunkIds(ids: string[]): string[][] {
  const chunks: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += ID_CHUNK) {
    chunks.push(ids.slice(offset, offset + ID_CHUNK));
  }
  return chunks;
}

/** Trendyol ürünü AKTİF mi? Arşivli / satışa-kapalı (onSale:false) / reddedilmiş / kara-liste → HARİÇ.
 *  Tükendi (quantity 0 ama onSale:true) → DAHİL. (onSale tanımsızsa dahil sayılır — güvenli varsayılan.) */
function isActiveTrendyolProduct(p: TrendyolProduct): boolean {
  if (p.archived === true) return false;
  if (p.onSale === false) return false;
  if (p.rejected === true || p.blacklisted === true) return false;
  return true;
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const input = Schema.parse(await req.json().catch(() => ({})));
    const client = new TrendyolClient(await getTrendyolCredentials());

    // Tüm sayfaları çek → barcode -> veri
    const fetched = new Map<string, FetchedTrendyol>();
    let totalElements = 0;
    /**
     * ÜRÜN V2: tek uç dörde bölündü. Yalnız fiyat yenileyeceksek HAFİF uç yeter —
     * başlık/görsel/kategori taşımadığı için aynı sayfa sayısında çok daha az veri iner.
     * Yeni ürün eklemede o alanlar gerektiği için onaylı ürün ucu kullanılır.
     */
    const yalnizFiyat = input.mode === "refresh-prices";
    for (let page = 0; page < input.maxPages; page += 1) {
      const res = yalnizFiyat
        ? await client.listApprovedInventoryAndPrice({ page, size: input.size })
        : await client.listApprovedProducts({ page, size: input.size });
      const products = res.content ?? [];
      totalElements = res.totalElements ?? totalElements;
      if (products.length === 0) break;
      for (const tp of products) {
        if (!tp.barcode?.trim()) continue;
        // Hafif uç durum bayraklarını taşımıyor; zaten yalnız onaylı ürünleri döndürüyor.
        if (!yalnizFiyat && !isActiveTrendyolProduct(tp)) continue; // sadece AKTİF (satışta + tükenen)
        const data = mapProduct(tp);
        if (!fetched.has(data.barcode)) fetched.set(data.barcode, data);
      }
      if (res.totalPages !== undefined && page >= res.totalPages - 1) break;
    }

    // ── refresh-prices: yalnızca değişen fiyatı yaz ──────────────────────────
    async function refreshPrices() {
      // Eşleştirme ürünün DEĞİL ilanın anahtarlarıyla yapılır: elle eşleştirilmiş ilanlarda
      // Product.barcode (Shopify) ile Listing.barcode (Trendyol) zaten farklıdır ve ürün
      // barkoduna bakan eski sorgu bu ilanların fiyatını hiç güncellemiyordu.
      const rows = await prisma.$queryRawUnsafe<
        Array<{
          listingId: string;
          salePrice: number;
          productId: string;
          externalId: string | null;
          listingBarcode: string | null;
          externalSku: string | null;
          productBarcode: string | null;
        }>
      >(
        `SELECT l.id AS listingId, l.salePrice AS salePrice, l.productId AS productId,
                l.externalId AS externalId, l.barcode AS listingBarcode, l.externalSku AS externalSku,
                p.barcode AS productBarcode
         FROM Listing l JOIN Product p ON l.productId = p.id
         WHERE l.platform = 'trendyol'`
      );
      const byExternalId = uniqueIndex(fetched.values(), (f) => f.trendyolId);
      const bySku = uniqueIndex(fetched.values(), (f) => f.sku);
      let changed = 0;
      const history: { productId: string; oldPrice: number; newPrice: number; changeSource: string }[] = [];
      const writes: { sql: string; args: unknown[] }[] = [];
      let atlananSifir = 0;
      for (const row of rows) {
        const f = matchByPriority<FetchedTrendyol>([
          [row.externalId, byExternalId],
          [row.listingBarcode, fetched],
          [row.externalSku, bySku],
          [row.productBarcode, fetched], // eski satırlar: ilan barkodu yazılmadan önce eklenmişler
        ]);
        if (!f) continue;
        /**
         * SIFIR FİYAT KORUMASI — Ürün v2 göçünün en pahalı hatası buydu.
         * Yanıt yapısı değiştiği için bir alan adı kayarsa `price` sessizce 0 gelir; kod
         * derlenir, hata çıkmaz, ama tüm ilanlara 0 TL yazılır ve fiyat geçmişi kalıcı olarak
         * bozulur. Geçersiz fiyat ASLA yazılmaz.
         */
        if (!Number.isFinite(f.price) || f.price <= 0) { atlananSifir++; continue; }
        if (Math.abs(f.price - row.salePrice) <= 0.001) continue;
        history.push({
          productId: row.productId,
          oldPrice: row.salePrice,
          newPrice: f.price,
          changeSource: "trendyol_sync",
        });
        /**
         * ⚠️ DÖNGÜ İÇİNDE YAZMA YOK. Uzak-HTTP libSQL'de her sorgu ~96 ms ve TÜM sorgular
         * süreç genelinde SIRALI. Satır satır UPDATE atmak 100 fiyat değişiminde ~10 saniye
         * demekti ve kullanıcı bunu "yenileme çok uzun sürüyor" olarak yaşıyordu.
         * İfadeler biriktirilip tek istekte gönderiliyor (aynı dosyadaki `addNew` da böyle).
         */
        writes.push({
          sql: `UPDATE Listing SET salePrice = ?, listPrice = ?, lastSyncedAt = ${nowDbDateSql()}, updatedAt = ${nowDbDateSql()} WHERE id = ?`,
          args: [f.price, f.listPrice, row.listingId],
        });
        changed++;
      }

      /**
       * TOPLU BOZULMA FRENİ: eşleşen satırların çoğunda fiyat geçersiz geldiyse sorun tek bir
       * üründe değil, yanıt biçimindedir (alan adı kaymış). Sessizce "0 değişiklik" demek
       * yerine durup haber ver — aksi hâlde bozuk göç fark edilmeden günlerce sürebilir.
       */
      const eslesen = atlananSifir + changed;
      if (eslesen >= 10 && atlananSifir > eslesen * 0.9) {
        throw new Error(
          "Trendyol'dan gelen fiyatların neredeyse tamamı geçersiz. Fiyatlar güncellenmedi — entegrasyon güncellemesi gerekiyor."
        );
      }

      // Tek istekte gönder; mod uygun değilse (embedded replica) sıralı yola düş.
      if (writes.length && !(await batchWrite(writes))) {
        for (const w of writes) {
          await prisma.$executeRawUnsafe(w.sql, ...(w.args as never[]));
        }
      }
      // Fiyat geçmişi — yalnızca değişenler, tek round-trip.
      if (history.length) await prisma.priceHistory.createMany({ data: history });
      return { checked: rows.length, changed };
    }

    // ── add-new: eşleşeni bağla, kalanı UnmatchedListing'e ────────────────────
    async function addNew() {
      const prods = await prisma.$queryRawUnsafe<
        Array<{ id: string; barcode: string; commissionRate: number | null; commissionSource: string | null }>
      >(`SELECT id, barcode, commissionRate, commissionSource FROM Product`);
      const barcodeToProductId = new Map(prods.map((p) => [p.barcode, p.id]));
      const listed = await prisma.$queryRawUnsafe<Array<{ productId: string }>>(
        `SELECT productId FROM Listing WHERE platform = 'trendyol'`
      );
      const listedSet = new Set(listed.map((l) => l.productId));

      // Eşleşmeyen havuzun mevcut hâli — yazmadan ÖNCE diff'lemek için. Eskiden her senkronda
      // havuzdaki tüm kayıtlar (yüzlerce) olduğu gibi yeniden yazılıyordu.
      const storedUnmatched = await prisma.$queryRawUnsafe<StoredUnmatched[]>(
        `SELECT id, externalId, externalSku, barcode, name, categoryName, price, stock, imageUrl
         FROM UnmatchedListing WHERE platform = 'trendyol'`
      );
      const storedById = new Map(storedUnmatched.map((row) => [row.id, row]));
      const storedByExternalId = new Map(
        storedUnmatched
          .filter((row): row is StoredUnmatched & { externalId: string } => Boolean(row.externalId))
          .map((row) => [row.externalId, row])
      );
      // Trendyol'da HÂLÂ duran kayıtlar (eşleşmiş ürünlerinki dahil) — temizlik bunlara dokunmaz.
      const stillOnTrendyol = new Set<string>();
      // İçeriği değişmemiş kayıtlar: yalnız "son görülme" damgası tazelenir.
      const touchIds: string[] = [];

      let linked = 0;
      let unmatched = 0;
      // Yazmaları TOPLA, sonra tek batch'te gönder. Eskiden her satır ayrı round-trip'ti:
      // eşleşmeyen havuz (~225 Trendyol kaydı) her senkronda tek tek yeniden yazılıyordu
      // → ~96ms × 225 ≈ 22sn ve bu süre boyunca uygulamanın tamamı DB kilidinde bekliyordu.
      const writes: { sql: string; args: unknown[] }[] = [];
      const LISTING_SQL = `INSERT INTO Listing (id, productId, platform, externalId, externalSku, barcode, salePrice, listPrice, stock, isActive, lastSyncedAt, createdAt, updatedAt)
               VALUES (?, ?, 'trendyol', ?, ?, ?, ?, ?, ?, ?, ${nowDbDateSql()}, ${nowDbDateSql()}, ${nowDbDateSql()})`;
      const UNMATCHED_SQL = `INSERT INTO UnmatchedListing (id, platform, externalId, externalSku, barcode, name, categoryName, price, stock, imageUrl, lastSeenAt, createdAt)
             VALUES (?, 'trendyol', ?, ?, ?, ?, ?, ?, ?, ?, ${nowDbDateSql()}, ${nowDbDateSql()})
             ON CONFLICT(platform, externalId) DO UPDATE SET
               externalSku=excluded.externalSku, barcode=excluded.barcode, name=excluded.name,
               categoryName=excluded.categoryName, price=excluded.price, stock=excluded.stock,
               imageUrl=excluded.imageUrl, lastSeenAt=${nowDbDateSql()}`;

      for (const [barcode, f] of fetched) {
        const productId = barcodeToProductId.get(barcode);
        const rowId = `unmatched_trendyol_${f.trendyolId || barcode}`;
        const prev =
          (f.trendyolId ? storedByExternalId.get(f.trendyolId) : undefined) ??
          storedById.get(rowId);
        if (prev) stillOnTrendyol.add(prev.id);
        if (productId) {
          if (!listedSet.has(productId)) {
            writes.push({
              sql: LISTING_SQL,
              args: [
                `listing_${productId}_trendyol`,
                productId,
                f.trendyolId,
                f.sku,
                barcode,
                f.price,
                f.listPrice,
                f.stock,
                f.isActive ? 1 : 0,
              ],
            });
            listedSet.add(productId);
            linked++;
          }
          // zaten listing varsa add-new dokunmaz (fiyat = refresh-prices'in işi)
        } else if (prev && sameUnmatched(prev, f)) {
          touchIds.push(prev.id); // hiçbir alanı değişmemiş → tam satırı yeniden yazma
          unmatched++;
        } else {
          writes.push({
            sql: UNMATCHED_SQL,
            args: [
              rowId,
              f.trendyolId,
              f.sku,
              barcode,
              f.name,
              f.categoryName,
              f.price,
              f.stock,
              f.imageUrl,
            ],
          });
          unmatched++;
        }
      }

      // Değişmeyenlerin damgası: tek tek değil, gruplar hâlinde tazelenir.
      for (const chunk of chunkIds(touchIds)) {
        writes.push({
          sql: `UPDATE UnmatchedListing SET lastSeenAt = ${nowDbDateSql()}
                WHERE id IN (${chunk.map(() => "?").join(",")})`,
          args: chunk,
        });
      }

      // Temizlik: artık AKTİF listede olmayanlar (arşivlenen/kapatılan/silinen). Trendyol hiç
      // ürün döndürmediyse (geçici durum) HİÇBİR ŞEY silinmez. Silme de gruplara bölünür —
      // tek dev listeyle sorgu, katalog büyüdüğünde tamamen hata veriyordu.
      const staleIds = fetched.size
        ? storedUnmatched.filter((row) => !stillOnTrendyol.has(row.id)).map((row) => row.id)
        : [];
      for (const chunk of chunkIds(staleIds)) {
        writes.push({
          sql: `DELETE FROM UnmatchedListing
                WHERE platform = 'trendyol' AND id IN (${chunk.map(() => "?").join(",")})`,
          args: chunk,
        });
      }

      // Tek istekte gönder; mod uygun değilse (embedded replica) sıralı yola düş.
      if (!(await batchWrite(writes))) {
        for (const w of writes) {
          await prisma.$executeRawUnsafe(w.sql, ...(w.args as never[]));
        }
      }

      /**
       * TRENDYOL'UN KENDİ KOMİSYON ORANI (Ürün v2 ile geldi).
       *
       * Bugüne kadar komisyon kategori kurallarından TAHMİN ediliyordu; artık Trendyol
       * ürün bazında bildiriyor. `Product.commissionRate` alanı bunun için açılmış ama
       * hiçbir yer yazmıyordu — `withProductCommissionRule` onu zaten tüm kategori
       * kurallarının önüne koyuyor, yani yazmak yeterli.
       *
       * ELLE GİRİLEN EZİLMEZ: ilan bazlı override (`Listing.commissionRate`) zaten daha
       * üstte; ürün bazında da yalnız kaynağı boş ya da 'trendyol' olan satırlar güncellenir.
       */
      const komisyonYazma: { sql: string; args: unknown[] }[] = [];
      const KOMISYON_SQL =
        `UPDATE Product SET commissionRate = ?, commissionSource = 'trendyol', ` +
        `commissionUpdatedAt = ${nowDbDateSql()}, updatedAt = ${nowDbDateSql()} WHERE id = ?`;
      for (const pr of prods) {
        if (pr.commissionSource && pr.commissionSource !== "trendyol") continue; // başka kaynak → dokunma
        const f = fetched.get(pr.barcode);
        const yeniOran = f?.commissionRate ?? null;
        if (yeniOran == null) continue;
        if (pr.commissionRate != null && Math.abs(pr.commissionRate - yeniOran) < 0.0001) continue;
        komisyonYazma.push({ sql: KOMISYON_SQL, args: [yeniOran, pr.id] });
      }
      if (komisyonYazma.length && !(await batchWrite(komisyonYazma))) {
        for (const w of komisyonYazma) await prisma.$executeRawUnsafe(w.sql, ...(w.args as never[]));
      }

      return { linked, unmatched, removed: staleIds.length, commission: komisyonYazma.length };
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

    // Senkron DB'yi değiştirdi → ürün/panel önbellekleri ve sipariş kârı tazelensin.
    bustProductCaches();
    return NextResponse.json({ mode: input.mode, totalElements, ...result });
  } catch (error) {
    return jsonError(error);
  }
}
