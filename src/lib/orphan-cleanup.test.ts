/**
 * Regresyon testi: ürün silinince ONA BAĞLI SATIR KALMAMALI.
 *
 * Bulut şemasında (runtime-schema.ts) ProductCost / PriceHistory / ProductModelFile /
 * PrintFileProduct için silme zinciri (FOREIGN KEY … CASCADE) yok. Yetim kalan tek bir satır,
 * yedek geri yüklemesini tamamen bozuyordu. Bu test mock değil, gerçek SQLite üzerinde davranış
 * testidir — tablolar da uygulamanın kendi şema göçüyle yaratılır.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-orphan-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

let db: typeof import("@/lib/prisma").prisma;
let cleanupProductOrphans: typeof import("./orphan-cleanup").cleanupProductOrphans;
let buildOrphanCleanupStatements: typeof import("./orphan-cleanup").buildOrphanCleanupStatements;

/** Bir ürün + ona bağlı TÜM satır türlerini oluşturur. */
async function seedProduct(id: string, spoolId: string) {
  await db.product.create({
    data: {
      id,
      barcode: `bc-${id}`,
      sku: `sku-${id}`,
      name: `Ürün ${id}`,
      categoryName: "Test",
      currentSalePrice: 100,
    },
  });
  await db.productCost.create({ data: { id: `cost-${id}`, productId: id, manualCost: 42 } });
  await db.priceHistory.create({
    data: { id: `ph-${id}`, productId: id, oldPrice: 90, newPrice: 100, changeSource: "manual" },
  });
  await db.listing.create({
    data: { id: `ls-${id}`, productId: id, platform: "shopify", salePrice: 100 },
  });
  await db.productModelFile.create({
    data: {
      id: `mf-${id}`,
      productId: id,
      printerConfigId: "printer-1",
      originalName: "parca.gcode",
      storedPath: `/tmp/${id}.gcode`,
      fileType: "gcode",
    },
  });
  await db.printFileProduct.create({
    data: { id: `pfp-${id}`, printerConfigId: "printer-1", filename: `${id}.gcode`, productId: id },
  });
  await db.filamentUsage.create({
    data: { id: `fu-${id}`, spoolId, productId: id, productName: `Ürün ${id}`, grams: 12.5 },
  });
}

/** Bir ürüne bakan satır sayıları. */
async function refCounts(id: string) {
  return {
    cost: await db.productCost.count({ where: { productId: id } }),
    priceHistory: await db.priceHistory.count({ where: { productId: id } }),
    listing: await db.listing.count({ where: { productId: id } }),
    modelFile: await db.productModelFile.count({ where: { productId: id } }),
    printFile: await db.printFileProduct.count({ where: { productId: id } }),
    filamentUsage: await db.filamentUsage.count({ where: { productId: id } }),
  };
}

beforeAll(async () => {
  const { ensureRuntimeSchema } = await import("./runtime-schema");
  ({ prisma: db } = await import("@/lib/prisma"));
  ({ cleanupProductOrphans, buildOrphanCleanupStatements } = await import("./orphan-cleanup"));
  await ensureRuntimeSchema();
  await db.filamentSpool.create({ data: { id: "spool-1", name: "Test Makara" } });
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("cleanupProductOrphans — ürün silinince yetim satır kalmaz", () => {
  it("ürün silindikten sonra ona bakan hiçbir satır kalmaz", async () => {
    await seedProduct("p1", "spool-1");
    const before = await refCounts("p1");
    expect(before.cost).toBe(1);
    expect(before.priceHistory).toBe(1);
    expect(before.modelFile).toBe(1);
    expect(before.printFile).toBe(1);

    // Silme rotasının yaptığı sıra: önce ürün satırı, sonra açık temizlik.
    await db.product.delete({ where: { id: "p1" } });
    await cleanupProductOrphans(["p1"]);

    const after = await refCounts("p1");
    expect(after).toEqual({
      cost: 0,
      priceHistory: 0,
      listing: 0,
      modelFile: 0,
      printFile: 0,
      filamentUsage: 0,
    });
  });

  it("filament kullanım kaydını SİLMEZ, yalnız ürün bağını koparır", async () => {
    await seedProduct("p2", "spool-1");
    await db.product.delete({ where: { id: "p2" } });
    await cleanupProductOrphans(["p2"]);

    const usage = await db.filamentUsage.findUnique({ where: { id: "fu-p2" } });
    expect(usage).not.toBeNull(); // makara geçmişi korunur
    expect(usage!.productId).toBeNull(); // ama artık olmayan ürüne bakmaz
    expect(usage!.productName).toBe("Ürün p2");
    expect(usage!.grams).toBe(12.5);
  });

  it("başka ürünlerin satırlarına dokunmaz", async () => {
    await seedProduct("p3", "spool-1");
    await seedProduct("p4", "spool-1");

    await db.product.delete({ where: { id: "p3" } });
    await cleanupProductOrphans(["p3"]);

    expect(await refCounts("p4")).toEqual({
      cost: 1,
      priceHistory: 1,
      listing: 1,
      modelFile: 1,
      printFile: 1,
      filamentUsage: 1,
    });
  });

  it("toplu silmede tüm ürünlerin bağlı satırlarını temizler", async () => {
    await seedProduct("p5", "spool-1");
    await seedProduct("p6", "spool-1");

    await db.product.deleteMany({ where: { id: { in: ["p5", "p6"] } } });
    await cleanupProductOrphans(["p5", "p6"]);

    for (const id of ["p5", "p6"]) {
      expect(await refCounts(id)).toEqual({
        cost: 0,
        priceHistory: 0,
        listing: 0,
        modelFile: 0,
        printFile: 0,
        filamentUsage: 0,
      });
    }
  });

  it("aynı kimlikle tekrar çağrılabilir (hata vermez)", async () => {
    await seedProduct("p7", "spool-1");
    await db.product.delete({ where: { id: "p7" } });
    await cleanupProductOrphans(["p7"]);
    await expect(cleanupProductOrphans(["p7"])).resolves.toBeTruthy();
  });

  it("özel baskı arşivini korur", async () => {
    await db.productModelFile.create({
      data: {
        id: "mf-custom",
        productId: "__custom__",
        printerConfigId: "printer-1",
        originalName: "ozel.gcode",
        storedPath: "/tmp/ozel.gcode",
        fileType: "gcode",
      },
    });

    await cleanupProductOrphans(["__custom__"]);

    expect(await db.productModelFile.count({ where: { id: "mf-custom" } })).toBe(1);
  });

  it("boş/geçersiz kimliklerde hiçbir ifade üretmez", () => {
    expect(buildOrphanCleanupStatements([])).toHaveLength(0);
    expect(buildOrphanCleanupStatements(["", "   ", "__custom__"])).toHaveLength(0);
  });

  it("her ürün için tüm bağlı tablolara ifade üretir ve kimlikleri parametre geçer", () => {
    const statements = buildOrphanCleanupStatements(["a", "b", "a"]);
    // 5 silme + 1 filament bağı koparma
    expect(statements).toHaveLength(6);
    for (const table of [
      "ProductCost",
      "PriceHistory",
      "Listing",
      "ProductModelFile",
      "PrintFileProduct",
    ]) {
      const stmt = statements.find((s) => s.sql.includes(`"${table}"`));
      expect(stmt, table).toBeDefined();
      expect(stmt!.sql.startsWith("DELETE")).toBe(true);
      expect(stmt!.args).toEqual(["a", "b"]); // yinelenen kimlik elenir
    }
    const usageStmt = statements.find((s) => s.sql.includes('"FilamentUsage"'));
    expect(usageStmt!.sql).toContain('SET "productId" = NULL'); // silinmez, bağı kopar
  });
});
