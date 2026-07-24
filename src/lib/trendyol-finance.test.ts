import { describe, expect, it } from "vitest";
import {
  aggregateTrendyolSaleSettlements,
  isTrendyolCargoInvoice,
  normalizeTrendyolCargoInvoiceItems,
} from "./trendyol-finance";

describe("Trendyol satış finans hareketleri", () => {
  it("aynı paket içindeki ürün satırlarını sipariş komisyonunda toplar", () => {
    const { aggregates, skippedTransactions } =
      aggregateTrendyolSaleSettlements([
        {
          id: "1",
          orderNumber: "1003",
          shipmentPackageId: 77,
          credit: 200,
          commissionAmount: 30,
          sellerRevenue: 170,
          transactionDate: 1_700_000_000_000,
        },
        {
          id: "2",
          orderNumber: "1003",
          shipmentPackageId: 77,
          credit: 100,
          commissionAmount: 20,
          sellerRevenue: 80,
          transactionDate: 1_700_000_100_000,
        },
      ]);

    expect(skippedTransactions).toBe(0);
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]).toMatchObject({
      externalOrderId: "ty-77",
      orderNumber: "1003",
      grossRevenue: 300,
      commission: 50,
      sellerRevenue: 250,
      transactionCount: 2,
    });
  });

  it("credit yoksa satıcı geliri + komisyonla brüt tutarı kurar", () => {
    const { aggregates } = aggregateTrendyolSaleSettlements([
      {
        orderNumber: "1004",
        commissionAmount: 15,
        sellerRevenue: 85,
      },
    ]);

    expect(aggregates[0]?.externalOrderId).toBe("ty-order-1004");
    expect(aggregates[0]?.grossRevenue).toBe(100);
  });

  it("eşleştirme için gerekli para alanları eksik kaydı güvenle atlar", () => {
    const result = aggregateTrendyolSaleSettlements([
      { orderNumber: "1005", commissionAmount: 10 },
    ]);

    expect(result.aggregates).toHaveLength(0);
    expect(result.skippedTransactions).toBe(1);
  });
});

describe("Trendyol kargo faturaları", () => {
  it("cari ekstreden Türkçe ve İngilizce kargo faturalarını ayırır", () => {
    expect(
      isTrendyolCargoInvoice({
        transactionType: "Kargo Faturası",
        description: "Trendyol lojistik",
      })
    ).toBe(true);
    expect(
      isTrendyolCargoInvoice({
        transactionType: "DeductionInvoices",
        description: "Cargo Invoice",
      })
    ).toBe(true);
    expect(
      isTrendyolCargoInvoice({
        transactionType: "Hizmet Faturası",
        description: "Platform hizmet bedeli",
      })
    ).toBe(false);
  });

  it("gönderi ve iade kalemlerini aynı sipariş için ayrı saklar", () => {
    const result = normalizeTrendyolCargoInvoiceItems(
      "INV-1",
      [
        {
          shipmentPackageType: "Gönderi Kargo Bedeli",
          parcelUniqueId: 101,
          orderNumber: "1003",
          amount: 34.24,
          desi: 1,
        },
        {
          shipmentPackageType: "İade Kargo Bedeli",
          parcelUniqueId: 102,
          orderNumber: "1003",
          amount: 40,
          desi: 2,
        },
      ],
      new Date("2026-07-01T10:00:00.000Z")
    );

    expect(result.skippedItems).toBe(0);
    expect(result.records).toEqual([
      expect.objectContaining({
        orderNumber: "1003",
        shipmentType: "dispatch",
        amount: 34.24,
      }),
      expect.objectContaining({
        orderNumber: "1003",
        shipmentType: "return",
        amount: 40,
      }),
    ]);
  });

  it("sipariş, parsel veya tutarı eksik kalemi atlar", () => {
    const result = normalizeTrendyolCargoInvoiceItems(
      "INV-2",
      [{ orderNumber: "1004", amount: 30 }],
      null
    );

    expect(result.records).toHaveLength(0);
    expect(result.skippedItems).toBe(1);
  });
});
