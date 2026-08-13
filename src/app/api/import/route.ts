import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { bustProductCaches } from "@/lib/cache-busting";
import { batchWrite } from "@/lib/libsql-batch";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { toDbDate } from "@/lib/sqlite-date";

/**
 * CSV ürün içe aktarma.
 *
 * NEDEN BU KURGU: eski hâli her satır için ayrı findUnique + update/create + cost upsert
 * yapıyordu. Uzak-HTTP libSQL'de her ifade ~96ms VE tüm sorgular süreç genelinde tek
 * mutex'te sıralı → 300 satırlık bir dosya ~2 dakika sürüyor, o süre boyunca uygulamanın
 * TAMAMI kuyrukta bekliyordu. Şimdi:
 *   1) mevcut ürünler + maliyetleri TOPLU okunur (birkaç sorgu, satır başına değil),
 *   2) yazımlar bellekte planlanır ve DEĞİŞMEYEN satır hiç yazılmaz,
 *   3) kalan yazımlar tek batch isteğinde gönderilir (batchWrite).
 * batchWrite uygun olmayan modda (embedded replica) false döner → sıralı yola düşülür,
 * veri kaybı olmaz. Bu yüzden tüm ifadeler idempotent (INSERT ... ON CONFLICT / UPDATE).
 */

interface ProductRow extends Record<string, string | undefined> {
  barcode?: string;
  sku?: string;
  name?: string;
  category?: string;
  sale_price?: string;
  list_price?: string;
  stock?: string;
  desi?: string;
  weight?: string;
  product_cost?: string;
  packaging_cost?: string;
}

type Stmt = { sql: string; args: unknown[] };

/** Tek satırın tüm yazımları — sıralı yola düşersek hata satır bazında raporlansın diye birlikte durur. */
type Job = { barcode: string; isNew: boolean; stmts: Stmt[] };

interface ExistingProduct {
  id: string;
  barcode: string;
  sku: string;
  name: string;
  categoryName: string;
  currentSalePrice: number;
  listPrice: number | null;
  stock: number;
  desi: number | null;
  weight: number | null;
}

interface ExistingCost {
  productId: string;
  costMode: string | null;
  manualCost: number | null;
  packagingCost: number | null;
  totalCost: number | null;
}

/** Boş hücre = "dokunma" (undefined). Dolu ama sayı değilse "gecersiz" → satır hatası. */
function parseNumberCell(raw: string | undefined, kind: "int" | "float"): number | undefined | "gecersiz" {
  const text = raw?.trim();
  if (!text) return undefined;
  const value = kind === "int" ? parseInt(text, 10) : parseFloat(text);
  return Number.isFinite(value) ? value : "gecersiz";
}

/** SQLite REAL/INTEGER değerlerini güvenli karşılaştır (null ↔ undefined aynı sayılır). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  return a === b;
}

/** Ham SQL okumasında sayısal kolonlar sürücüye göre BigInt gelebilir → karşılaştırma
 *  yanlış "değişti" demesin diye number'a normalle. */
function toNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

/** IN (...) sorgularını parça parça çalıştır — tek sorguda binlerce parametre göndermeyelim. */
async function readInChunks<T>(
  keys: string[],
  build: (placeholders: string) => string
): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < keys.length; offset += 400) {
    const slice = keys.slice(offset, offset + 400);
    const rows = await prisma.$queryRawUnsafe<T[]>(
      build(slice.map(() => "?").join(",")),
      ...slice
    );
    out.push(...rows);
  }
  return out;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { type?: string; rows?: ProductRow[] };
    const type = body?.type;
    const rows = Array.isArray(body?.rows) ? body.rows : [];

    if (type !== "products") {
      return NextResponse.json({ error: "Unknown import type" }, { status: 400 });
    }

    await ensureRuntimeSchema();

    const created: string[] = [];
    const updated: string[] = [];
    const errors: string[] = [];

    // --- 1) Satırları doğrula ve ayrıştır (DB'ye hiç dokunmadan) -------------------
    interface PlannedRow {
      barcode: string;
      sku: string;
      name: string;
      categoryName: string;
      currentSalePrice: number;
      stock: number;
      listPrice?: number;
      desi?: number;
      weight?: number;
      cost: { costMode: "manual"; manualCost: number; packagingCost: number; totalCost: number } | null;
    }
    const planned: PlannedRow[] = [];

    for (const row of rows) {
      const barcode = row.barcode?.trim();
      const name = row.name?.trim();

      if (!barcode || !name) {
        errors.push("Satir atlandi: barcode veya name eksik");
        continue;
      }

      const salePriceText = row.sale_price?.trim() ?? "";
      const salePrice = Number(salePriceText);
      if (!salePriceText || !Number.isFinite(salePrice) || salePrice <= 0) {
        errors.push(`${barcode}: sale_price sonlu ve 0'dan büyük bir sayı olmalı`);
        continue;
      }

      const listPrice = parseNumberCell(row.list_price, "float");
      const stock = parseNumberCell(row.stock, "int");
      const desi = parseNumberCell(row.desi, "float");
      const weight = parseNumberCell(row.weight, "float");
      const invalid = (
        [
          ["list_price", listPrice],
          ["stock", stock],
          ["desi", desi],
          ["weight", weight],
        ] as const
      ).find(([, v]) => v === "gecersiz");
      if (invalid) {
        errors.push(`${barcode}: ${invalid[0]} sayı olmalı`);
        continue;
      }

      // Maliyet alanlarının anlamı ESKİSİYLE BİREBİR aynı (sayı değilse 0, paketleme yoksa 0).
      const cost = row.product_cost
        ? (() => {
            const manualCost = parseFloat(row.product_cost!) || 0;
            const packagingCost = row.packaging_cost ? parseFloat(row.packaging_cost) || 0 : 0;
            return {
              costMode: "manual" as const,
              manualCost,
              packagingCost,
              totalCost: manualCost + packagingCost,
            };
          })()
        : null;

      planned.push({
        barcode,
        sku: row.sku || barcode,
        name,
        categoryName: row.category || "Genel",
        currentSalePrice: salePrice,
        stock: (stock as number | undefined) ?? 0,
        listPrice: listPrice as number | undefined,
        desi: desi as number | undefined,
        weight: weight as number | undefined,
        cost,
      });
    }

    if (planned.length === 0) {
      return NextResponse.json({
        created: 0,
        updated: 0,
        errors,
        total: rows.length,
        processed: 0,
        unchanged: 0,
      });
    }

    // --- 2) Mevcut kayıtları TOPLU oku (satır başına findUnique yok) ---------------
    const barcodes = [...new Set(planned.map((p) => p.barcode))];
    const existingRows = (
      await readInChunks<ExistingProduct>(
        barcodes,
        (ph) =>
          `SELECT id, barcode, sku, name, categoryName, currentSalePrice, listPrice, stock, desi, weight
         FROM Product WHERE barcode IN (${ph})`
      )
    ).map((p) => ({
      ...p,
      currentSalePrice: toNum(p.currentSalePrice) ?? 0,
      listPrice: toNum(p.listPrice),
      stock: toNum(p.stock) ?? 0,
      desi: toNum(p.desi),
      weight: toNum(p.weight),
    }));
    const byBarcode = new Map(existingRows.map((p) => [p.barcode, p]));

    const costRows = existingRows.length
      ? (
          await readInChunks<ExistingCost>(
            existingRows.map((p) => p.id),
            (ph) =>
              `SELECT productId, costMode, manualCost, packagingCost, totalCost
             FROM ProductCost WHERE productId IN (${ph})`
          )
        ).map((c) => ({
          ...c,
          manualCost: toNum(c.manualCost),
          packagingCost: toNum(c.packagingCost),
          totalCost: toNum(c.totalCost),
        }))
      : [];
    const costByProductId = new Map(costRows.map((c) => [c.productId, c]));

    // --- 3) Yazımları planla; değişmeyen satırı HİÇ yazma --------------------------
    const jobs: Job[] = [];
    let unchanged = 0;
    // Tarih damgası HER ZAMAN `toDbDate()` ile üretilir: uzak Turso'da Prisma ISO METİN,
    // klasik yerel motorda epoch-ms TAMSAYI yazar. Buraya ham `Date.now()` bağlamak kolonu
    // karışık biçime düşürüyor ve "en son güncellenen" sıralaması sessizce bozuluyordu.
    const now = toDbDate(new Date());

    const COST_SQL = `INSERT INTO ProductCost (id, productId, costMode, manualCost, packagingCost, totalCost, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(productId) DO UPDATE SET
         costMode = excluded.costMode,
         manualCost = excluded.manualCost,
         packagingCost = excluded.packagingCost,
         totalCost = excluded.totalCost,
         updatedAt = excluded.updatedAt`;

    for (const p of planned) {
      const existing = byBarcode.get(p.barcode);
      const stmts: Stmt[] = [];
      const productId = existing?.id ?? randomUUID();

      if (existing) {
        // Yalnız CSV'de DOLU gelen kolonlar yazılır — boş hücre mevcut değeri silmez
        // (eski Prisma davranışı: undefined alan güncellenmez).
        const sets: string[] = [];
        const args: unknown[] = [];
        const put = (column: string, value: unknown) => {
          if (sameValue(existing[column as keyof ExistingProduct], value)) return;
          sets.push(`${column} = ?`);
          args.push(value);
        };
        put("sku", p.sku);
        put("name", p.name);
        put("categoryName", p.categoryName);
        put("currentSalePrice", p.currentSalePrice);
        put("stock", p.stock);
        if (p.listPrice !== undefined) put("listPrice", p.listPrice);
        if (p.desi !== undefined) put("desi", p.desi);
        if (p.weight !== undefined) put("weight", p.weight);

        if (sets.length > 0) {
          sets.push("updatedAt = ?");
          args.push(now, p.barcode);
          stmts.push({ sql: `UPDATE Product SET ${sets.join(", ")} WHERE barcode = ?`, args });
        }
      } else {
        stmts.push({
          sql: `INSERT INTO Product (id, barcode, sku, name, categoryName, currentSalePrice, stock, listPrice, desi, weight, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(barcode) DO UPDATE SET
                  sku = excluded.sku, name = excluded.name, categoryName = excluded.categoryName,
                  currentSalePrice = excluded.currentSalePrice, stock = excluded.stock,
                  listPrice = excluded.listPrice, desi = excluded.desi, weight = excluded.weight,
                  updatedAt = excluded.updatedAt`,
          args: [
            productId,
            p.barcode,
            p.sku,
            p.name,
            p.categoryName,
            p.currentSalePrice,
            p.stock,
            p.listPrice ?? null,
            p.desi ?? null,
            p.weight ?? null,
            now,
            now,
          ],
        });
      }

      if (p.cost) {
        const currentCost = costByProductId.get(productId);
        const costChanged =
          !currentCost ||
          !sameValue(currentCost.costMode, p.cost.costMode) ||
          !sameValue(currentCost.manualCost, p.cost.manualCost) ||
          !sameValue(currentCost.packagingCost, p.cost.packagingCost) ||
          !sameValue(currentCost.totalCost, p.cost.totalCost);
        if (costChanged) {
          stmts.push({
            sql: COST_SQL,
            args: [
              randomUUID(),
              productId,
              p.cost.costMode,
              p.cost.manualCost,
              p.cost.packagingCost,
              p.cost.totalCost,
              now,
            ],
          });
        }
      }

      if (existing) updated.push(p.barcode);
      else created.push(p.barcode);

      if (stmts.length === 0) {
        unchanged++;
        continue;
      }
      jobs.push({ barcode: p.barcode, isNew: !existing, stmts });

      // Aynı dosyada tekrar eden barkod: ikinci satır artık "mevcut" sayılır (eski
      // sıralı davranışta da ikinci satır ilkini güncelliyordu).
      if (!existing) {
        byBarcode.set(p.barcode, {
          id: productId,
          barcode: p.barcode,
          sku: p.sku,
          name: p.name,
          categoryName: p.categoryName,
          currentSalePrice: p.currentSalePrice,
          listPrice: p.listPrice ?? null,
          stock: p.stock,
          desi: p.desi ?? null,
          weight: p.weight ?? null,
        });
      }
      if (p.cost) {
        costByProductId.set(productId, { productId, ...p.cost });
      }
    }

    // --- 4) Tek istekte yaz; mod uygun değilse sıralı yola düş ---------------------
    const allStmts = jobs.flatMap((j) => j.stmts);
    if (allStmts.length > 0 && !(await batchWrite(allStmts))) {
      for (const job of jobs) {
        try {
          for (const s of job.stmts) {
            await prisma.$executeRawUnsafe(s.sql, ...(s.args as never[]));
          }
        } catch (e) {
          const list = job.isNew ? created : updated;
          const index = list.indexOf(job.barcode);
          if (index >= 0) list.splice(index, 1);
          errors.push(`${job.barcode}: ${e instanceof Error ? e.message : "Bilinmeyen hata"}`);
        }
      }
    }

    if (created.length > 0 || updated.length > 0) bustProductCaches();
    return NextResponse.json({
      created: created.length,
      updated: updated.length,
      errors,
      // Ek bilgi alanları (mevcut sözleşmeyi bozmaz): kaç satırdan kaçı işlendi.
      total: rows.length,
      processed: created.length + updated.length,
      unchanged,
    });
  } catch (error) {
    return jsonError(error);
  }
}
