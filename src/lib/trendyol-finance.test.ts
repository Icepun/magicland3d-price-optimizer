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

describe("Trendyol satıcı indirimi ve gerçek kargo", () => {
  it("satıcı indirimi kupon gibi netlenir — ödeme sipariş tutarıyla tutar", () => {
    const base = { orderNumber: "11800000001", shipmentPackageId: 777 };
    const { aggregates } = aggregateTrendyolSaleSettlements(
      [{ ...base, id: "s", credit: 649.99, commissionAmount: 136.5 }],
      { discounts: [{ ...base, id: "d", debt: 32.5, credit: 0, commissionAmount: 6.83 }] }
    );
    expect(aggregates[0]).toMatchObject({ grossRevenue: 617.49, commission: 129.67 });
  });

  it("indirim iptali indirimi geri alır", () => {
    const base = { orderNumber: "1", shipmentPackageId: 9 };
    const { aggregates } = aggregateTrendyolSaleSettlements(
      [{ ...base, id: "s", credit: 100, commissionAmount: 20 }],
      {
        discounts: [{ ...base, id: "d", debt: 10, commissionAmount: 2 }],
        discountCancels: [{ ...base, id: "x", credit: 10, commissionAmount: 2 }],
      }
    );
    expect(aggregates[0]).toMatchObject({ grossRevenue: 100, commission: 20 });
  });

  it("kargo faturası kalemleri: yalnız gidiş kargosu, sipariş başına toplanır", async () => {
    const { kargoKalemleriniTopla } = await import("./trendyol-finance");
    const toplam = kargoKalemleriniTopla([
      { shipmentPackageType: "Gönderi Kargo Bedeli", orderNumber: "11697516497", amount: 98.34, desi: 1 },
      { shipmentPackageType: "Gönderi Kargo Bedeli", orderNumber: "11699305901", amount: 128.64, desi: 4 },
      { shipmentPackageType: "İade Kargo Bedeli", orderNumber: "11697516497", amount: 98.34 },
      { shipmentPackageType: "Gönderi Kargo Bedeli", orderNumber: "11699305901", amount: 10 },
      { shipmentPackageType: "Gönderi Kargo Bedeli", orderNumber: "", amount: 5 },
    ]);
    expect(Object.fromEntries(toplam)).toEqual({ "11697516497": 98.34, "11699305901": 138.64 });
  });

  it("kargo yalnız tek paketli siparişin kaydına yazılır; değişmeyen değer yeniden yazılmaz", async () => {
    const { kargoYazmaIfadeleri } = await import("./trendyol-finance");
    const satir = (externalOrderId: string, orderNumber: string) => ({
      externalOrderId, orderNumber, grossRevenue: 100, commission: 20, sellerRevenue: 80, transactionCount: 1, sourceUpdatedAt: null,
    });
    const ifadeler = kargoYazmaIfadeleri(
      [satir("ty-1", "A"), satir("ty-2", "B"), satir("ty-3", "B"), satir("ty-4", "C")],
      new Map([["A", 98.34], ["B", 50], ["Z", 1]])
    );
    expect(ifadeler).toHaveLength(1);
    expect(ifadeler[0].args).toEqual([9834, "ty-1", 9834]);
    expect(ifadeler[0].sql).toContain('"cargoKurus" IS NOT ?');
  });
});

describe("gerçek kargonun kayıtlı kâra FARK olarak işlenmesi", () => {
  it("tahmin 88,00 → gerçek 77,49: kâr 10,51 × 5/6 artar, indirilecek KDV 10,51/6 azalır", async () => {
    const { gercekKargoGuncellemeleri } = await import("./trendyol-finance");
    const [g] = gercekKargoGuncellemeleri(
      [{ id: "s1", profitKurus: 3_023, cargoKurus: 8_800, inputVatCreditKurus: 4_000, actualCargoKurus: 7_749 }],
      20
    );
    expect(g.profitKurus).toBe(Math.round(3_023 + 1_051 * (5 / 6)));
    expect(g.inputVatCreditKurus).toBe(Math.round(4_000 - 1_051 / 6));
    expect(g.cargoKurus).toBe(7_749);
  });
  it("gerçek kargo tahminden pahalıysa kâr düşer; eşitse güncelleme üretmez; KDV bilinmiyorsa bilinmiyor kalır", async () => {
    const { gercekKargoGuncellemeleri } = await import("./trendyol-finance");
    const sonuc = gercekKargoGuncellemeleri(
      [
        { id: "a", profitKurus: 20_000, cargoKurus: 9_834, inputVatCreditKurus: null, actualCargoKurus: 12_864 },
        { id: "b", profitKurus: 20_000, cargoKurus: 9_834, inputVatCreditKurus: 1, actualCargoKurus: 9_834 },
      ],
      20
    );
    expect(sonuc).toHaveLength(1);
    expect(sonuc[0].profitKurus).toBe(Math.round(20_000 - 3_030 * (5 / 6)));
    expect(sonuc[0].inputVatCreditKurus).toBeNull();
  });
});

describe("Trendyol iade kargo faturası kalemleri", () => {
  it("yalnız 'İade Kargo Bedeli' kalemleri sipariş no başına toplanır", async () => {
    const { iadeKargoKalemleriniTopla, kargoKalemleriniTopla } = await import("./trendyol-finance");
    const kalemler = [
      { orderNumber: "11826876568", shipmentPackageType: "Gönderi Kargo Bedeli", amount: 98.34 },
      { orderNumber: "11826876568", shipmentPackageType: "İade Kargo Bedeli", amount: 98.34 },
      { orderNumber: "2", shipmentPackageType: "Gönderi Kargo Bedeli", amount: 94.49 },
    ];
    expect([...iadeKargoKalemleriniTopla(kalemler)]).toEqual([["11826876568", 98.34]]);
    expect(kargoKalemleriniTopla(kalemler).get("11826876568")).toBe(98.34);
  });

  it("iade kargosu sipariş numarasıyla, tek kaydı olan siparişe yazılır", async () => {
    const { iadeKargoYazmaIfadeleri } = await import("./trendyol-finance");
    const [ifade] = iadeKargoYazmaIfadeleri(new Map([["11826876568", 98.34]]));
    expect(ifade.sql).toContain('"returnCargoKurus" = ?');
    expect(ifade.sql).toContain("COUNT(*)");
    expect(ifade.args).toEqual([9834, "11826876568", 9834, "11826876568"]);
  });
});

describe("Trendyol ilan terminleri", () => {
  it("yalnız değişen ilan yazılır; bilinmeyen termin kayıtlıyı silmez", async () => {
    const { tyIlanTerminIfadeleri } = await import("./trendyol-finance");
    const ifadeler = tyIlanTerminIfadeleri(
      [
        { id: "l1", externalId: "V1", barcode: "B1", dispatchDays: 2 },
        { id: "l2", externalId: "V2", barcode: "B2", dispatchDays: 1 },
        { id: "l3", externalId: null, barcode: "B3", dispatchDays: null },
        { id: "l4", externalId: "V4", barcode: "B4", dispatchDays: 2 },
      ],
      { byId: new Map([["V1", 1], ["V2", 1]]), byBarcode: new Map([["B3", 2]]) }
    );
    expect(ifadeler.map((i) => i.args)).toEqual([[1, "l1"], [2, "l3"]]);
  });
});

describe("Trendyol kesilen desi ve gecikme faturaları", () => {
  it("gidiş kalemlerinin en büyük desisi ve paket numarası alınır", async () => {
    const { kargoDesileriniTopla } = await import("./trendyol-finance");
    const m = kargoDesileriniTopla([
      { orderNumber: "1", shipmentPackageType: "Gönderi Kargo Bedeli", desi: 4, parcelUniqueId: "7330001" },
      { orderNumber: "1", shipmentPackageType: "İade Kargo Bedeli", desi: 9, parcelUniqueId: "7330009" },
      { orderNumber: "2", shipmentPackageType: "Gönderi Kargo Bedeli", desi: 1, parcelUniqueId: 7330002 },
    ]);
    expect(m.get("1")).toEqual({ desi: 4, paket: "7330001" });
    expect(m.get("2")).toEqual({ desi: 1, paket: "7330002" });
  });

  it("gecikme faturaları birleştirilir, tekrar edenler bir kez, 200 günden eskiler atılır", async () => {
    const { gecikmeFaturalariniBirlestir } = await import("./trendyol-finance");
    const an = Date.parse("2026-11-23T00:00:00Z");
    const gun = 86_400_000;
    const sonuc = gecikmeFaturalariniBirlestir(
      { bas: an - 90 * gun, faturalar: [{ tarih: an - 300 * gun, tutar: 50 }, { tarih: an - 40 * gun, tutar: 180 }] },
      [{ tarih: an - 40 * gun, tutar: 180 }, { tarih: an - 10 * gun, tutar: 100 }],
      an - 45 * gun,
      an
    );
    expect(sonuc.faturalar.map((f) => f.tutar)).toEqual([180, 100]);
    expect(sonuc.bas).toBe(an - 90 * gun);
  });

  it("kesinti faturaları türüne göre ayrılır: kargo, gecikme, kusurlu ürün (gerçek kayıt biçimi)", async () => {
    const { kesintiFaturalariniAyir } = await import("./trendyol-finance");
    const kayit = (id: string, transactionType: string, transactionDate: number, debt: number) => ({
      id,
      transactionType,
      transactionDate,
      debt,
      credit: 0,
      description: "Tazmin bedelidir.",
    });
    const f = kesintiFaturalariniAyir([
      kayit("KF1", "Kargo Fatura", 1786510800000, 812.4),
      kayit("DDF2026018279239", "Kusurlu Ürün Faturası", 1786510835128, 180),
      kayit("DDF2026018279239", "Kusurlu Ürün Faturası", 1786510835128, 180),
      kayit("TG1", "Termin Gecikme Bedeli", 1786510830000, 100),
      kayit("KM1", "Komisyon Faturası", 1786510800000, 2400),
      kayit("RB1", "Reklam Bedeli", 1786510800000, 500),
    ]);
    expect(f.kargo).toEqual(["KF1"]);
    expect(f.kusurlu).toEqual([{ tarih: 1786510835128, tutar: 180 }]);
    expect(f.gecikme).toEqual([{ tarih: 1786510830000, tutar: 100 }]);
  });
});
