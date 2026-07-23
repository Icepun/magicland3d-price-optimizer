import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-manual-order-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

let db: typeof import("@/lib/prisma").prisma;
let manualOrders: typeof import("./manual-orders");

beforeAll(async () => {
  const runtime = await import("@/lib/runtime-schema");
  ({ prisma: db } = await import("@/lib/prisma"));
  manualOrders = await import("./manual-orders");
  await runtime.ensureRuntimeSchema();
  await db.appSetting.upsert({
    where: { key: "vatRate" },
    create: { key: "vatRate", value: "20" },
    update: { value: "20" },
  });
  await db.product.create({
    data: {
      id: "catalog-product",
      barcode: "catalog-product",
      sku: "catalog-product",
      name: "Katalog ürünü",
      categoryName: "Test",
      currentSalePrice: 1_200,
      cost: {
        create: {
          id: "catalog-cost",
          costMode: "manual",
          manualCost: 100,
          totalCost: 100,
        },
      },
    },
  });
  await db.product.create({
    data: {
      id: "no-cost-product",
      barcode: "no-cost-product",
      sku: "no-cost-product",
      name: "Maliyetsiz ürün",
      categoryName: "Test",
      currentSalePrice: 100,
    },
  });
});

afterAll(async () => {
  await db?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

function catalogInput(
  overrides: Partial<
    import("./manual-orders").ManualOrderInput
  > = {}
) {
  return manualOrders.ManualOrderInputSchema.parse({
    orderedAt: "2026-07-23T10:00:00.000Z",
    orderNumber: null,
    customerName: null,
    statusKind: "processing",
    currency: "TRY",
    saleTotal: 1_200,
    note: null,
    mode: "catalog",
    includeProductCost: true,
    includePackaging: false,
    commission: { amount: 0, hasVatInvoice: false },
    cargo: { amount: 0, hasVatInvoice: false },
    expenseRules: [],
    customExpenses: [],
    items: [{ id: "line-1", productId: "catalog-product", quantity: 1 }],
    ...overrides,
  });
}

describe("manual order persistence", () => {
  it("null sipariş numarasını kabul edip benzersiz numara üretir", async () => {
    const created = await manualOrders.createManualOrder(catalogInput());
    expect(created.orderNumber).toMatch(/^MAN-20260723-[A-Z0-9]{6}$/);
    expect(created.profitKurus).toBe(90_000);
  });

  it("metadata düzenlemesinde captured finansı, finans düzenlemesinde aynı satır maliyetini korur", async () => {
    const created = await manualOrders.createManualOrder(
      catalogInput({
        orderNumber: "M-CAPTURED",
        items: [
          {
            id: "captured-line",
            productId: "catalog-product",
            quantity: 1,
          },
        ],
      })
    );
    expect(created.profitKurus).toBe(90_000);

    await db.productCost.update({
      where: { productId: "catalog-product" },
      data: { manualCost: 200, totalCost: 200 },
    });

    const metadataOnly = await manualOrders.updateManualOrder(
      created.id,
      catalogInput({
        orderNumber: null,
        customerName: "Yeni müşteri",
        note: "Yalnız metadata",
        statusKind: "delivered",
        items: [
          {
            id: "captured-line",
            productId: "catalog-product",
            quantity: 1,
          },
        ],
      })
    );
    expect(metadataOnly).toMatchObject({
      orderNumber: "M-CAPTURED",
      customerName: "Yeni müşteri",
      statusKind: "delivered",
      profitKurus: 90_000,
    });

    const financialEdit = await manualOrders.updateManualOrder(
      created.id,
      catalogInput({
        orderNumber: null,
        commission: { amount: 10, hasVatInvoice: false },
        items: [
          {
            id: "captured-line",
            productId: "catalog-product",
            quantity: 1,
          },
        ],
      })
    );
    // Net revenue 1.000 - captured cost 100 - commission 10.
    // Güncel ürün maliyeti 200'e yükselse de geçmiş satır yeniden fiyatlanmaz.
    expect(financialEdit.profitKurus).toBe(89_000);
    expect(
      manualOrders.parseManualOrderBreakdown(financialEdit.breakdownJson).draft
        .items[0]
    ).toMatchObject({ productId: "catalog-product", productionCost: 100 });
  });

  it("finans düzenlemesinde siparişte yakalanan KDV oranını korur", async () => {
    await db.appSetting.upsert({
      where: { key: "vatRate" },
      create: { key: "vatRate", value: "20" },
      update: { value: "20" },
    });
    await db.productCost.update({
      where: { productId: "catalog-product" },
      data: { manualCost: 100, totalCost: 100 },
    });

    const created = await manualOrders.createManualOrder(
      catalogInput({
        orderNumber: "M-VAT-HISTORY",
        items: [
          {
            id: "vat-history-line",
            productId: "catalog-product",
            quantity: 1,
          },
        ],
      })
    );
    expect(
      manualOrders.parseManualOrderBreakdown(created.breakdownJson).draft.vatRate
    ).toBe(20);

    await db.appSetting.update({
      where: { key: "vatRate" },
      data: { value: "10" },
    });

    const financialEdit = await manualOrders.updateManualOrder(
      created.id,
      catalogInput({
        orderNumber: "M-VAT-HISTORY",
        commission: { amount: 10, hasVatInvoice: false },
        items: [
          {
            id: "vat-history-line",
            productId: "catalog-product",
            quantity: 1,
          },
        ],
      })
    );
    const captured =
      manualOrders.parseManualOrderBreakdown(financialEdit.breakdownJson);

    expect(captured.draft.vatRate).toBe(20);
    expect(manualOrders.manualOrderDetailResponse(financialEdit).vatRate).toBe(20);
    // 1.200 / 1,20 = 1.000 net revenue; 100 product + 10 commission.
    expect(financialEdit.netRevenueKurus).toBe(100_000);
    expect(financialEdit.profitKurus).toBe(89_000);

    await db.appSetting.update({
      where: { key: "vatRate" },
      data: { value: "20" },
    });
  });

  it("ürün kaydı olup maliyet satırı yoksa gerçek sıfır değil eksik maliyet sayar", async () => {
    const created = await manualOrders.createManualOrder(
      catalogInput({
        orderNumber: "M-NO-COST",
        saleTotal: 100,
        items: [
          {
            id: "no-cost-line",
            productId: "no-cost-product",
            quantity: 1,
          },
        ],
      })
    );
    const captured = manualOrders.parseManualOrderItems(created.itemsJson).items[0];
    expect(captured.costKnown).toBe(false);
    expect(created.profitKurus).toBeNull();
    expect(created.profitPartial).toBe(true);
  });

  it("mobil v1 kalemlerinde kind alanı olmadan exact hesap zarfını okur", () => {
    const draft = {
      saleTotal: 120,
      vatRate: 20,
      mode: "freeform" as const,
      items: [
        {
          id: "mobile-line",
          productId: null,
          name: "Mobil serbest kalem",
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
    const breakdown = manualOrders.parseManualOrderBreakdown(
      JSON.stringify({
        version: 1,
        draft,
        breakdown: {
          grossRevenue: 120,
          netRevenue: 100,
          outputVat: 20,
          productCost: 20,
          packagingCost: 0,
          commissionCost: 0,
          cargoCost: 0,
          expenseRulesCost: 0,
          customExpensesCost: 0,
          totalCost: 20,
          inputVatCredit: 0,
          netProfit: 80,
          profitPartial: false,
          missingCostItems: 0,
          profitMargin: 0.8,
        },
      })
    );
    expect(breakdown).toEqual({
      version: 1,
      draft,
      breakdown: expect.objectContaining({ netProfit: 80 }),
    });
    expect(breakdown.draft.items[0]).not.toHaveProperty("kind");
  });
});
