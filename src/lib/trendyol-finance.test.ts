import { describe, expect, it } from "vitest";
import { aggregateTrendyolSaleSettlements } from "./trendyol-finance";

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
