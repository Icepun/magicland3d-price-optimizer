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

/**
 * CUSTOM SİPARİŞ — serbest kalem katalog maliyet motoruna bağlandı ve kargo desiden çıkıyor.
 * Bu test uçtan uca çalışır: gerçek şema, gerçek ayarlar, gerçek kargo baremi.
 */
describe("custom sipariş — üretim girdileri ve desiden kargo", () => {
  beforeAll(async () => {
    // Saatlik oranlar: elektrik dahil 10₺, aşınma 5₺, işçilik 35₺ → saatlik toplam 50₺.
    for (const [key, value] of [
      ["costElectricityIncluded", "true"],
      ["costElectricityPerHour", "10"],
      ["costMachineWearPerHour", "5"],
      ["costLaborPerHour", "35"],
    ] as const) {
      await db.appSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    }
    await db.filamentType.create({
      data: { id: "pla-siyah", name: "PLA Siyah", costPerGram: 1.2, isActive: true },
    });
    // Shopify kargo baremi: 0-5 desi arası 118₺ (KDV dahil).
    await db.cargoRule.create({
      data: {
        id: "shopify-0-5",
        name: "Shopify 0-5 desi",
        platform: "shopify",
        minPrice: 0,
        maxPrice: 999999,
        minDesi: 0,
        maxDesi: 5,
        cargoCost: 118,
        vatIncluded: true,
        priority: 10,
        isActive: true,
      },
    });
  });

  function freeformInput(over: Record<string, unknown> = {}) {
    return manualOrders.ManualOrderInputSchema.parse({
      orderedAt: "2026-08-11T10:00:00.000Z",
      orderNumber: null,
      customerName: null,
      statusKind: "processing",
      currency: "TRY",
      saleTotal: 600,
      note: null,
      mode: "freeform",
      includeProductCost: true,
      includePackaging: false,
      commission: { amount: 0, hasVatInvoice: false },
      // Serbest modda bu alan YOK SAYILIR — kargo desiden çıkar.
      cargo: { amount: 999, hasVatInvoice: false },
      expenseRules: [],
      customExpenses: [],
      items: [
        {
          id: "ozel-1",
          name: "Özel figür",
          quantity: 1,
          unitCost: null,
          desi: 2,
          production: {
            filamentTypeId: "pla-siyah",
            filamentWeight: 50, // 50 × 1,2 = 60₺ filament
            printTimeHours: 2, // 2 × 50 = 100₺ makine+işçilik
            wasteRate: 0,
          },
        },
      ],
      ...over,
    });
  }

  it("üretim maliyetini katalog motoruyla hesaplar ve elle kargoyu yok sayar", async () => {
    const created = await manualOrders.createManualOrder(
      freeformInput({ orderNumber: "M-CUSTOM-1" })
    );
    const breakdown = manualOrders.parseManualOrderBreakdown(created.breakdownJson);

    // Filament 60 + (elektrik 10 + aşınma 5 + işçilik 35) × 2 saat = 160₺
    expect(breakdown.breakdown.productCost).toBeCloseTo(160, 6);
    // Kargo: elle girilen 999 DEĞİL, 2 desi → 118₺
    expect(breakdown.breakdown.cargoCost).toBeCloseTo(118, 6);
    expect(breakdown.breakdown.cargoAuto).toBe(true);
    expect(breakdown.breakdown.cargoDesi).toBeCloseTo(2, 6);
    expect(breakdown.breakdown.cargoRuleMissing).toBe(false);
    // İndirilecek KDV: filament payı 60 + kargo 118 = 178 → /6
    expect(breakdown.breakdown.inputVatCredit).toBeCloseTo(178 / 6, 6);
  });

  it("desi barem dışına taşarsa kargoyu 0 bırakır ama SESSİZ kalmaz", async () => {
    const created = await manualOrders.createManualOrder(
      freeformInput({
        orderNumber: "M-CUSTOM-2",
        items: [
          {
            id: "ozel-2",
            name: "Kocaman figür",
            quantity: 1,
            unitCost: null,
            desi: 40, // hiçbir barem kapsamıyor
            production: { filamentTypeId: "pla-siyah", filamentWeight: 10, printTimeHours: 1 },
          },
        ],
      })
    );
    const breakdown = manualOrders.parseManualOrderBreakdown(created.breakdownJson);
    expect(breakdown.breakdown.cargoCost).toBe(0);
    expect(breakdown.breakdown.cargoRuleMissing).toBe(true);
  });

  it("adet arttıkça desi toplanır ve üst barem seçilir", async () => {
    const created = await manualOrders.createManualOrder(
      freeformInput({
        orderNumber: "M-CUSTOM-3",
        items: [
          {
            id: "ozel-3",
            name: "Üçlü set",
            quantity: 3,
            unitCost: null,
            desi: 2, // 3 × 2 = 6 desi → 0-5 baremi DIŞINDA
            production: { filamentTypeId: "pla-siyah", filamentWeight: 10, printTimeHours: 1 },
          },
        ],
      })
    );
    const breakdown = manualOrders.parseManualOrderBreakdown(created.breakdownJson);
    expect(breakdown.breakdown.cargoDesi).toBeCloseTo(6, 6);
    expect(breakdown.breakdown.cargoRuleMissing).toBe(true);
  });

  it("üretim girdisi yoksa elle birim maliyet yolu korunur", async () => {
    const created = await manualOrders.createManualOrder(
      freeformInput({
        orderNumber: "M-CUSTOM-4",
        items: [
          {
            id: "ozel-4",
            name: "Elle maliyetli",
            quantity: 1,
            unitCost: 75,
            manualCostHasVatInvoice: false,
            desi: 1,
            production: null,
          },
        ],
      })
    );
    const breakdown = manualOrders.parseManualOrderBreakdown(created.breakdownJson);
    expect(breakdown.breakdown.productCost).toBeCloseTo(75, 6);
    expect(breakdown.breakdown.cargoCost).toBeCloseTo(118, 6);
  });
  /**
   * REGRESYON: düzenleme yanıtı serbest kalemde desi/production/costSource alanlarını
   * DÜŞÜRÜYORDU. Kullanıcı siparişi açıp kaydettiğinde gramaj/süre/desi boş gider,
   * maliyet "elle giriş"e düşer ve kargo yeniden hesaplanamazdı — sessiz veri kaybı.
   */
  it("düzenleme yanıtı üretim girdilerini ve desiyi geri verir", async () => {
    const created = await manualOrders.createManualOrder(
      freeformInput({ orderNumber: "M-CUSTOM-5" })
    );
    const detail = manualOrders.manualOrderDetailResponse(created);
    const item = detail.draft.items[0] as Record<string, unknown>;

    expect(item.desi).toBe(2);
    expect(item.costSource).toBe("detailed");
    expect(item.production).toMatchObject({
      filamentTypeId: "pla-siyah",
      filamentWeight: 50,
      printTimeHours: 2,
    });
  });
});
