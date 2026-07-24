import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import packageJson from "../../../../package.json";
import {
  calculateManualOrder,
  type ManualOrderCalculationInput,
} from "@/core/manual-order";
import { tlToKurus } from "@/lib/monthly-finance";

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

    // Mobil v1 satırları `kind` yazmaz. Backend parser'ı mode/productId üzerinden
    // okuyabilmeli ve versioned hesap zarfını aynen round-trip etmelidir.
    const manualDraft: ManualOrderCalculationInput = {
      saleTotal: 600,
      vatRate: 20,
      mode: "freeform",
      items: [
        {
          id: "manual-line-1",
          productId: null,
          name: "Özel baskı",
          imageUrl: null,
          quantity: 1,
          costKnown: true,
          productionCost: 0,
          packagingCost: 0,
          filamentCost: 0,
          packagingComponents: null,
          manualUnitCost: 120,
          manualCostHasVatInvoice: true,
        },
      ],
      includeProductCost: true,
      includePackaging: false,
      commission: { amount: 0, hasVatInvoice: false },
      cargo: { amount: 30, hasVatInvoice: false },
      expenseRules: [],
      customExpenses: [],
    };
    const manualBreakdown = calculateManualOrder(manualDraft);
    const manualItemsJson = JSON.stringify({
      version: 1,
      items: manualDraft.items,
    });
    const manualBreakdownJson = JSON.stringify({
      version: 1,
      draft: manualDraft,
      breakdown: manualBreakdown,
    });

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
          calculationVersion: 2,
          profitSource: "platform",
          estimatedCommissionKurus: 7_000,
          actualCommissionKurus: 6_500,
        },
      ],
      platformOrderFinancials: [
        {
          id: "pof-1",
          platform: "trendyol",
          externalOrderId: "ty-77",
          orderNumber: "1003",
          grossRevenueKurus: 34_498,
          commissionKurus: 6_500,
          sellerRevenueKurus: 27_998,
          transactionCount: 2,
          sourceUpdatedAt: "2026-07-10T10:00:00.000Z",
          syncedAt: "2026-07-10T11:00:00.000Z",
        },
      ],
      manualOrders: [
        {
          id: "manual-order-1",
          orderNumber: "M-TEST-1",
          mode: "freeform",
          orderedAt: "2026-07-09T10:00:00.000Z",
          statusKind: "processing",
          customerName: "Manuel müşteri",
          currency: "TRY",
          revenueKurus: tlToKurus(manualBreakdown.grossRevenue),
          netRevenueKurus: tlToKurus(manualBreakdown.netRevenue),
          totalCostKurus: tlToKurus(manualBreakdown.totalCost),
          inputVatCreditKurus: tlToKurus(manualBreakdown.inputVatCredit),
          profitKurus:
            manualBreakdown.netProfit == null
              ? null
              : tlToKurus(manualBreakdown.netProfit),
          profitPartial: manualBreakdown.profitPartial,
          itemsJson: manualItemsJson,
          breakdownJson: manualBreakdownJson,
          calculationVersion: 1,
          note: "Mobil uyum testi",
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
    expect(result.stats.platformOrderFinancials).toBe(1);
    expect(result.stats.manualOrders).toBe(1);
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
    expect(
      await db.manualOrder.findUniqueOrThrow({ where: { id: "manual-order-1" } })
    ).toMatchObject({
      orderNumber: "M-TEST-1",
      revenueKurus: 60_000,
      profitPartial: false,
      itemsJson: manualItemsJson,
      breakdownJson: manualBreakdownJson,
    });
    expect(
      await db.platformOrderFinancial.findUniqueOrThrow({
        where: { id: "pof-1" },
      })
    ).toMatchObject({
      externalOrderId: "ty-77",
      commissionKurus: 6_500,
      transactionCount: 2,
    });
    await db.orderFinanceSnapshot.create({
      data: {
        id: "legacy-manual-snapshot",
        platform: "manual",
        externalOrderId: "manual-order-1",
        orderNumber: "M-TEST-1",
        orderedAt: new Date("2026-07-09T10:00:00.000Z"),
        revenueKurus: 60_000,
        profitKurus:
          manualBreakdown.netProfit == null
            ? null
            : tlToKurus(manualBreakdown.netProfit),
        profitPartial: false,
        statusKind: "processing",
        currency: "TRY",
      },
    });

    const exported = await exportBackup();
    expect(exported.status).toBe(200);
    const backup = await exported.json();
    expect(backup.version).toBe(3);
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
        profitSource: "platform",
        estimatedCommissionKurus: 7_000,
        actualCommissionKurus: 6_500,
      }),
    ]);
    expect(backup.platformOrderFinancials).toEqual([
      expect.objectContaining({
        id: "pof-1",
        externalOrderId: "ty-77",
        commissionKurus: 6_500,
      }),
    ]);
    expect(
      backup.orderFinanceSnapshots.find(
        (snapshot: { platform: string }) => snapshot.platform === "manual"
      )
    ).toBeUndefined();
    expect(backup.manualOrders).toEqual([
      expect.objectContaining({
        id: "manual-order-1",
        orderNumber: "M-TEST-1",
        revenueKurus: 60_000,
        itemsJson: manualItemsJson,
        breakdownJson: manualBreakdownJson,
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

  it("tahrif edilmiş manuel sipariş hesabını içeri almadan önce reddeder", async () => {
    const before = await db.product.count();
    const draft: ManualOrderCalculationInput = {
      saleTotal: 120,
      vatRate: 20,
      mode: "freeform",
      items: [
        {
          id: "tampered-line",
          productId: null,
          name: "Serbest kalem",
          imageUrl: null,
          quantity: 1,
          costKnown: true,
          productionCost: 0,
          packagingCost: 0,
          filamentCost: 0,
          manualUnitCost: 20,
        },
      ],
      includeProductCost: true,
      includePackaging: false,
      commission: { amount: 0, hasVatInvoice: false },
      cargo: { amount: 0, hasVatInvoice: false },
      expenseRules: [],
      customExpenses: [],
    };
    const breakdown = calculateManualOrder(draft);
    const response = await postBackup({
      version: 2,
      products: [
        {
          id: "must-not-import",
          barcode: "manual-rollback",
          currentSalePrice: 100,
        },
      ],
      manualOrders: [
        {
          id: "tampered-order",
          orderNumber: "M-TAMPERED",
          mode: "freeform",
          orderedAt: "2026-07-09T10:00:00.000Z",
          statusKind: "processing",
          currency: "TRY",
          revenueKurus: 12_001,
          netRevenueKurus: tlToKurus(breakdown.netRevenue),
          totalCostKurus: tlToKurus(breakdown.totalCost),
          inputVatCreditKurus: tlToKurus(breakdown.inputVatCredit),
          profitKurus:
            breakdown.netProfit == null ? null : tlToKurus(breakdown.netProfit),
          profitPartial: breakdown.profitPartial,
          itemsJson: JSON.stringify({ version: 1, items: draft.items }),
          breakdownJson: JSON.stringify({ version: 1, draft, breakdown }),
          calculationVersion: 1,
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(await db.product.count()).toBe(before);
    expect(
      await db.product.findUnique({ where: { barcode: "manual-rollback" } })
    ).toBeNull();
    expect(
      await db.manualOrder.findUnique({ where: { id: "tampered-order" } })
    ).toBeNull();
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
