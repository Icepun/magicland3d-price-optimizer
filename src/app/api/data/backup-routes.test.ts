import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import packageJson from "../../../../package.json";

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-backup-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

let importBackup: typeof import("./import/route").POST;
let exportBackup: typeof import("./export/route").GET;
let consumeSpool: typeof import("../spools/[id]/consume/route").POST;
let db: typeof import("@/lib/prisma").prisma;

async function postBackup(payload: unknown) {
  const request = new Request("http://localhost/api/data/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }) as NextRequest;
  return importBackup(request);
}

beforeAll(async () => {
  ({ POST: importBackup } = await import("./import/route"));
  ({ GET: exportBackup } = await import("./export/route"));
  ({ POST: consumeSpool } = await import("../spools/[id]/consume/route"));
  ({ prisma: db } = await import("@/lib/prisma"));
});

afterAll(async () => {
  await db?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("portable backup routes", () => {
  it("ürün ID eşleşmesini tüm ilişkilere taşır ve genişletilmiş veriyi round-trip eder", async () => {
    const initial = await postBackup({
      version: 2,
      products: [
        {
          id: "target-product",
          barcode: "same-barcode",
          sku: "old",
          name: "Eski ürün",
          categoryName: "Dekor",
          currentSalePrice: 100,
        },
      ],
    });
    expect(initial.status).toBe(200);

    const response = await postBackup({
      version: 2,
      variantGroups: [{ id: "vg-1", name: "Varyantlar", shareModels: true }],
      filamentTypes: [{ id: "filament-1", name: "PLA", costPerGram: 0.5 }],
      costTemplates: [{ id: "template-1", name: "Standart" }],
      products: [
        {
          id: "source-product",
          barcode: "same-barcode",
          sku: "new",
          name: "Yeni ürün",
          alias: "takma ad",
          categoryName: "İç Mekan",
          currentSalePrice: 250,
          imageManual: true,
          madeToOrder: true,
          variantGroupId: "vg-1",
          variantLabel: "Kırmızı",
        },
      ],
      productCosts: [
        {
          id: "cost-1",
          productId: "source-product",
          costMode: "detailed",
          templateId: "template-1",
          filamentTypeId: "filament-1",
          filamentWeight: 42,
        },
      ],
      listings: [
        {
          id: "listing-1",
          productId: "source-product",
          platform: "shopify",
          salePrice: 250,
          barcode: "shop-barcode",
        },
      ],
      priceHistory: [
        {
          id: "history-1",
          productId: "source-product",
          oldPrice: 200,
          newPrice: 250,
          changeSource: "test",
          changedAt: "2026-07-22T10:00:00.000Z",
        },
      ],
      filamentSpools: [{ id: "spool-1", name: "Siyah PLA", remainingGrams: 700 }],
      filamentUsages: [
        {
          id: "usage-1",
          spoolId: "spool-1",
          productId: "source-product",
          grams: 42,
        },
      ],
      printerConfigs: [
        {
          id: "printer-1",
          name: "Yazıcı",
          brand: "elegoo",
          host: "192.0.2.1",
        },
      ],
      printFileProducts: [
        {
          id: "mapping-1",
          printerConfigId: "printer-1",
          filename: "model.gcode",
          productId: "source-product",
        },
      ],
      productModelFiles: [
        {
          id: "model-r2",
          productId: "source-product",
          printerConfigId: "printer-1",
          originalName: "remote.3mf",
          storedPath: "/must/not/be/imported",
          r2Key: "models/remote.3mf",
          fileType: "3mf",
        },
        {
          id: "model-local",
          productId: "source-product",
          printerConfigId: "printer-1",
          originalName: "local.3mf",
          storedPath: "/local/file.3mf",
          r2Key: null,
          fileType: "3mf",
        },
        {
          id: "model-custom-r2",
          productId: "__custom__",
          printerConfigId: "printer-1",
          originalName: "custom-order.3mf",
          storedPath: "",
          r2Key: "models/custom-order.3mf",
          fileType: "3mf",
        },
      ],
      actualExpenses: [
        {
          id: "expense-1",
          name: "Muhasebe ödemesi",
          category: "Ofis",
          amountKurus: 12_345,
          paidAt: "2026-07-10T09:00:00.000Z",
        },
      ],
      orderFinanceSnapshots: [
        {
          id: "finance-1",
          platform: "shopify",
          externalOrderId: "sh-1003",
          orderNumber: "#1003",
          orderedAt: "2026-07-08T10:00:00.000Z",
          revenueKurus: 34_498,
          profitKurus: 7_333,
          profitPartial: true,
          statusKind: "processing",
          currency: "TRY",
          calculationVersion: 1,
        },
      ],
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.complete).toBe(false);
    expect(result.stats.productModelFiles).toBe(2);
    expect(result.stats.productModelFilesSkipped).toBe(1);
    expect(result.stats.actualExpenses).toBe(1);
    expect(result.stats.orderFinanceSnapshots).toBe(1);
    expect(result.warnings).toHaveLength(1);

    const product = await db.product.findUniqueOrThrow({
      where: { barcode: "same-barcode" },
      include: { cost: true, listings: true, priceHistory: true },
    });
    expect(product.id).toBe("target-product");
    expect(product).toMatchObject({
      alias: "takma ad",
      imageManual: true,
      madeToOrder: true,
      variantGroupId: "vg-1",
      variantLabel: "Kırmızı",
    });
    expect(product.cost?.productId).toBe("target-product");
    expect(product.listings[0]).toMatchObject({
      productId: "target-product",
      barcode: "shop-barcode",
    });
    expect(product.priceHistory[0].productId).toBe("target-product");
    expect(await db.filamentUsage.findUniqueOrThrow({ where: { id: "usage-1" } })).toMatchObject({
      productId: "target-product",
    });
    expect(
      await db.printFileProduct.findUniqueOrThrow({ where: { id: "mapping-1" } })
    ).toMatchObject({ productId: "target-product" });
    expect(await db.productModelFile.findUniqueOrThrow({ where: { id: "model-r2" } })).toMatchObject(
      { productId: "target-product", storedPath: "", r2Key: "models/remote.3mf" }
    );
    expect(await db.productModelFile.findUnique({ where: { id: "model-local" } })).toBeNull();
    expect(
      await db.productModelFile.findUniqueOrThrow({ where: { id: "model-custom-r2" } })
    ).toMatchObject({
      productId: "__custom__",
      storedPath: "",
      r2Key: "models/custom-order.3mf",
    });

    const exported = await exportBackup();
    expect(exported.status).toBe(200);
    const backup = await exported.json();
    expect(backup.version).toBe(2);
    expect(backup.appVersion).toBe(packageJson.version);
    expect(backup.priceHistory).toHaveLength(1);
    expect(backup.filamentSpools).toHaveLength(1);
    expect(backup.filamentUsages).toHaveLength(1);
    expect(backup.printerConfigs).toHaveLength(1);
    expect(backup.printFileProducts).toHaveLength(1);
    expect(backup.actualExpenses).toEqual([
      expect.objectContaining({ id: "expense-1", amountKurus: 12_345 }),
    ]);
    expect(backup.orderFinanceSnapshots).toEqual([
      expect.objectContaining({
        externalOrderId: "sh-1003",
        revenueKurus: 34_498,
        profitKurus: 7_333,
      }),
    ]);
    expect(
      backup.productModelFiles.find((file: { id: string }) => file.id === "model-r2")
    ).toMatchObject({
      storedPath: "",
      storageKind: "r2-reference",
      fileBytesIncluded: false,
    });
    expect(
      backup.productModelFiles.find((file: { id: string }) => file.id === "model-custom-r2")
    ).toMatchObject({
      productId: "__custom__",
      storedPath: "",
      storageKind: "r2-reference",
      fileBytesIncluded: false,
    });
    expect(backup.metadata.localModelFileBytesIncluded).toBe(false);
  });

  it("geçersiz bir ilişkiyi sessiz atlamak yerine tüm transaction'ı geri alır", async () => {
    const before = await db.product.count();
    const response = await postBackup({
      version: 2,
      products: [
        {
          id: "will-roll-back",
          barcode: "rollback-barcode",
          currentSalePrice: 100,
        },
      ],
      listings: [
        {
          id: "bad-listing",
          productId: "missing-product",
          platform: "shopify",
          salePrice: 100,
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(await db.product.count()).toBe(before);
    expect(await db.product.findUnique({ where: { barcode: "rollback-barcode" } })).toBeNull();
  });

  it("eşzamanlı makara tüketimlerini lost-update olmadan atomik uygular", async () => {
    await db.filamentSpool.create({
      data: { id: "concurrent-spool", name: "Concurrency", remainingGrams: 100 },
    });
    const consume = () =>
      consumeSpool(
        new Request("http://localhost/api/spools/concurrent-spool/consume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grams: 60 }),
        }) as NextRequest,
        { params: Promise.resolve({ id: "concurrent-spool" }) }
      );

    const responses = await Promise.all([consume(), consume()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(
      await db.filamentSpool.findUniqueOrThrow({ where: { id: "concurrent-spool" } })
    ).toMatchObject({ remainingGrams: 0 });
    expect(await db.filamentUsage.count({ where: { spoolId: "concurrent-spool" } })).toBe(2);
  });
});
