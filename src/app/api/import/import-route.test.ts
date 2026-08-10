import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-import-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

// Toplu yazımı gerçek DB'ye uygulayan sahte batch: hem "tek istekte gönderildi mi",
// hem de üretilen SQL'in gerçekten çalıştığı doğrulanır.
const batch = vi.hoisted(() => ({ calls: [] as { sql: string; args?: unknown[] }[][], fail: false }));
vi.mock("@/lib/libsql-batch", () => ({
  batchWrite: async (statements: { sql: string; args?: unknown[] }[]) => {
    batch.calls.push(statements);
    // Embedded replica modunu taklit et: batch kullanılamaz → çağıran sıralı yola düşmeli.
    if (batch.fail) return false;
    const { prisma } = await import("@/lib/prisma");
    for (const s of statements) {
      await prisma.$executeRawUnsafe(s.sql, ...((s.args ?? []) as never[]));
    }
    return true;
  },
}));

let importProducts: typeof import("./route").POST;
let db: typeof import("@/lib/prisma").prisma;

function request(body: unknown) {
  return new Request("http://localhost/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;
}

function importRows(rows: Record<string, string>[]) {
  return importProducts(request({ type: "products", rows }));
}

beforeAll(async () => {
  ({ POST: importProducts } = await import("./route"));
  ({ prisma: db } = await import("@/lib/prisma"));
});

afterAll(async () => {
  await db?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("CSV ürün içe aktarma", () => {
  it("yeni ürünleri ve maliyetlerini TEK toplu yazımda oluşturur", async () => {
    const res = await importRows([
      { barcode: "B1", sku: "S1", name: "Kupa", category: "Dekor", sale_price: "150", stock: "4" },
      {
        barcode: "B2",
        name: "Vazo",
        sale_price: "200",
        list_price: "250",
        desi: "1.5",
        weight: "0.4",
        product_cost: "60",
        packaging_cost: "10",
      },
      { barcode: "B3", name: "Saksı", sale_price: "90" },
    ]);

    expect(await res.json()).toEqual({
      created: 3,
      updated: 0,
      errors: [],
      total: 3,
      processed: 3,
      unchanged: 0,
    });
    // Satır başına ayrı gidiş-dönüş değil: hepsi tek istekte.
    expect(batch.calls).toHaveLength(1);

    const b1 = await db.product.findUnique({ where: { barcode: "B1" }, include: { cost: true } });
    expect(b1).toMatchObject({ sku: "S1", name: "Kupa", categoryName: "Dekor", currentSalePrice: 150, stock: 4 });
    expect(b1?.cost).toBeNull();
    expect(b1?.updatedAt).toBeInstanceOf(Date);

    const b2 = await db.product.findUnique({ where: { barcode: "B2" }, include: { cost: true } });
    // sku boşsa barkod, kategori boşsa "Genel" — eski davranış korunuyor.
    expect(b2).toMatchObject({ sku: "B2", categoryName: "Genel", listPrice: 250, desi: 1.5, weight: 0.4, stock: 0 });
    expect(b2?.cost).toMatchObject({
      costMode: "manual",
      manualCost: 60,
      packagingCost: 10,
      totalCost: 70,
    });
  });

  it("aynı dosya tekrar aktarılınca hiçbir satır yazılmaz", async () => {
    const before = batch.calls.length;
    const res = await importRows([
      { barcode: "B1", sku: "S1", name: "Kupa", category: "Dekor", sale_price: "150", stock: "4" },
      {
        barcode: "B2",
        name: "Vazo",
        sale_price: "200",
        list_price: "250",
        desi: "1.5",
        weight: "0.4",
        product_cost: "60",
        packaging_cost: "10",
      },
    ]);

    expect(await res.json()).toMatchObject({ created: 0, updated: 2, unchanged: 2, errors: [] });
    expect(batch.calls).toHaveLength(before); // yazacak bir şey yok → istek bile gitmedi
  });

  it("sadece değişen alanı yazar, boş hücre mevcut değeri silmez", async () => {
    const res = await importRows([
      // list_price/desi/weight kolonları boş: B2'nin mevcut değerleri korunmalı.
      { barcode: "B2", name: "Vazo", sale_price: "220", product_cost: "60", packaging_cost: "10" },
    ]);

    expect(await res.json()).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
    const last = batch.calls.at(-1)!;
    expect(last).toHaveLength(1); // maliyet değişmediği için yalnız ürün güncellemesi
    expect(last[0].sql).toContain("UPDATE Product SET currentSalePrice = ?");

    const b2 = await db.product.findUnique({ where: { barcode: "B2" }, include: { cost: true } });
    expect(b2).toMatchObject({ currentSalePrice: 220, listPrice: 250, desi: 1.5, weight: 0.4 });
    expect(b2?.cost).toMatchObject({ totalCost: 70 });
  });

  it("maliyet değişince maliyet satırını günceller", async () => {
    const res = await importRows([
      { barcode: "B2", name: "Vazo", sale_price: "220", product_cost: "80", packaging_cost: "5" },
    ]);

    expect(await res.json()).toMatchObject({ created: 0, updated: 1 });
    const b2 = await db.product.findUnique({ where: { barcode: "B2" }, include: { cost: true } });
    expect(b2?.cost).toMatchObject({ manualCost: 80, packagingCost: 5, totalCost: 85 });
  });

  it("hatalı satırları atlar ve hata mesajlarını satır bazında toplar", async () => {
    const res = await importRows([
      { name: "Barkodsuz", sale_price: "10" },
      { barcode: "B4", name: "Fiyatsız", sale_price: "" },
      { barcode: "B5", name: "Sıfır fiyat", sale_price: "0" },
      { barcode: "B6", name: "Bozuk stok", sale_price: "50", stock: "çok" },
      { barcode: "B7", name: "Geçerli", sale_price: "50" },
    ]);

    const payload = await res.json();
    expect(payload).toMatchObject({ created: 1, updated: 0, total: 5, processed: 1 });
    expect(payload.errors).toEqual([
      "Satir atlandi: barcode veya name eksik",
      "B4: sale_price sonlu ve 0'dan büyük bir sayı olmalı",
      "B5: sale_price sonlu ve 0'dan büyük bir sayı olmalı",
      "B6: stock sayı olmalı",
    ]);
    expect(await db.product.findUnique({ where: { barcode: "B6" } })).toBeNull();
    expect(await db.product.findUnique({ where: { barcode: "B7" } })).not.toBeNull();
  });

  it("aynı dosyadaki tekrar eden barkodu tek üründe birleştirir", async () => {
    const res = await importRows([
      { barcode: "B8", name: "İlk", sale_price: "10" },
      { barcode: "B8", name: "Son", sale_price: "30" },
    ]);

    expect(await res.json()).toMatchObject({ created: 1, updated: 1 });
    expect(await db.product.findUnique({ where: { barcode: "B8" } })).toMatchObject({
      name: "Son",
      currentSalePrice: 30,
    });
  });

  it("toplu yazım kullanılamazsa sıralı yola düşüp veriyi yine de yazar", async () => {
    batch.fail = true;
    try {
      const res = await importRows([
        { barcode: "B9", name: "Yedek yol", sale_price: "40", product_cost: "12" },
      ]);
      expect(await res.json()).toMatchObject({ created: 1, updated: 0, errors: [] });
    } finally {
      batch.fail = false;
    }

    const b9 = await db.product.findUnique({ where: { barcode: "B9" }, include: { cost: true } });
    expect(b9).toMatchObject({ currentSalePrice: 40 });
    expect(b9?.cost).toMatchObject({ manualCost: 12, packagingCost: 0, totalCost: 12 });
  });

  it("bilinmeyen içe aktarma türünü reddeder", async () => {
    const res = await importProducts(request({ type: "siparisler", rows: [] }));
    expect(res.status).toBe(400);
  });
});
