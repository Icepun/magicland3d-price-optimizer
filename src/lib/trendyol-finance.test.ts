import { describe, expect, it } from "vitest";
import { aggregateTrendyolSaleSettlements, gercekKomisyonGuncellemeleri } from "./trendyol-finance";

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

  /**
   * Canlı ölçüm (4 Eki 2026, sipariş 11627343537): müşteri 429,99 ödedi; satış hareketi kuponsuz
   * 449,99'u taşıyor, 20 TL'lik "Takip Et Kazan" kuponu ayrı harekette düşülüyor.
   */
  it("satıcı kuponunu satıştan neteler — ödeme sipariş tutarıyla tutar", () => {
    const sale = {
      id: "s1",
      orderNumber: "11627343537",
      shipmentPackageId: 4177489765,
      credit: 449.99,
      commissionAmount: 94.5,
      sellerRevenue: 355.49,
    };
    const coupon = {
      id: "c1",
      orderNumber: "11627343537",
      shipmentPackageId: 4177489765,
      debt: 20,
      credit: 0,
      commissionAmount: 4.2,
      sellerRevenue: 15.8,
    };
    const { aggregates, skippedTransactions } = aggregateTrendyolSaleSettlements([sale], {
      coupons: [coupon],
    });
    expect(skippedTransactions).toBe(0);
    expect(aggregates[0]).toMatchObject({
      externalOrderId: "ty-4177489765",
      grossRevenue: 429.99,
      commission: 90.3,
      sellerRevenue: 339.69,
      transactionCount: 2,
    });
  });

  it("kupon iptali kuponu geri alır", () => {
    const base = { orderNumber: "1", shipmentPackageId: 5 };
    const { aggregates } = aggregateTrendyolSaleSettlements(
      [{ ...base, id: "s", credit: 100, commissionAmount: 20, sellerRevenue: 80 }],
      {
        coupons: [{ ...base, id: "c", debt: 10, commissionAmount: 2, sellerRevenue: 8 }],
        couponCancels: [{ ...base, id: "x", credit: 10, commissionAmount: 2, sellerRevenue: 8 }],
      }
    );
    expect(aggregates[0]).toMatchObject({ grossRevenue: 100, commission: 20, sellerRevenue: 80 });
  });

  it("satışı pencerede olmayan kupon hiçbir siparişe yazılmaz", () => {
    const { aggregates, skippedTransactions } = aggregateTrendyolSaleSettlements([], {
      coupons: [{ id: "c", orderNumber: "9", shipmentPackageId: 9, debt: 20, commissionAmount: 4 }],
    });
    expect(aggregates).toHaveLength(0);
    expect(skippedTransactions).toBe(1);
  });

  it("netlenince eksiye düşen paket kâra işlenmez", () => {
    const base = { orderNumber: "2", shipmentPackageId: 6 };
    const { aggregates, skippedTransactions } = aggregateTrendyolSaleSettlements(
      [{ ...base, id: "s", credit: 10, commissionAmount: 2, sellerRevenue: 8 }],
      { coupons: [{ ...base, id: "c", debt: 20, commissionAmount: 4, sellerRevenue: 16 }] }
    );
    expect(aggregates).toHaveLength(0);
    expect(skippedTransactions).toBe(2);
  });

  it("eşleştirme için gerekli para alanları eksik kaydı güvenle atlar", () => {
    const result = aggregateTrendyolSaleSettlements([
      { orderNumber: "1005", commissionAmount: 10 },
    ]);

    expect(result.aggregates).toHaveLength(0);
    expect(result.skippedTransactions).toBe(1);
  });
});

describe("gerçek komisyonun KAYITLI kâra işlenmesi", () => {
  const kayit = (over: Partial<Parameters<typeof gercekKomisyonGuncellemeleri>[0][number]> = {}) => ({
    id: "ofs:trendyol:ty-1",
    revenueKurus: 25_999,
    profitKurus: 10_000,
    estimatedCommissionKurus: 3_380,
    inputVatCreditKurus: 1_000,
    grossRevenueKurus: 25_999,
    commissionKurus: 3_640,
    ...over,
  });

  it("yalnız komisyon FARKI işlenir (KDV payı düşülerek); indirilecek KDV de aynı yönde düzelir", () => {
    const [g] = gercekKomisyonGuncellemeleri([kayit()], 20);
    // (33,80 − 36,40) × (1 − 20/120) = −2,1667 → 100,00 − 2,17
    expect(g).toEqual({
      id: "ofs:trendyol:ty-1",
      profitKurus: 9_783,
      inputVatCreditKurus: 1_043,
      actualCommissionKurus: 3_640,
    });
  });

  it("tahminle aynı gerçek komisyon kârı değiştirmez ama 'işlendi' olarak yazılır", () => {
    const [g] = gercekKomisyonGuncellemeleri(
      [kayit({ revenueKurus: 42_999, grossRevenueKurus: 42_999, estimatedCommissionKurus: 9_030, commissionKurus: 9_030 })],
      20
    );
    expect(g.profitKurus).toBe(10_000);
    expect(g.actualCommissionKurus).toBe(9_030);
  });

  it("ödeme sipariş tutarından %1'den fazla saparsa İŞLENMEZ (kuponu netlenmemiş eski kayıt)", () => {
    expect(
      gercekKomisyonGuncellemeleri([kayit({ revenueKurus: 42_999, grossRevenueKurus: 44_999 })], 20)
    ).toEqual([]);
  });

  it("indirilecek KDV bilinmiyorsa bilinmiyor kalır", () => {
    const [g] = gercekKomisyonGuncellemeleri([kayit({ inputVatCreditKurus: null })], 20);
    expect(g.inputVatCreditKurus).toBeNull();
  });
});
