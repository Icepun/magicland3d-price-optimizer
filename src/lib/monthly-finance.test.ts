import { describe, expect, it } from "vitest";
import {
  aggregateMonthlyFinance,
  monthKey,
  monthlyFinanceWindowStart,
  recentMonthKeys,
  tlToKurus,
} from "./monthly-finance";

describe("monthly finance", () => {
  it("Europe/Istanbul sınırında doğru ayı seçer", () => {
    expect(monthKey(new Date("2026-06-30T21:30:00.000Z"))).toBe("2026-07");
    expect(recentMonthKeys(3, new Date("2026-01-15T12:00:00.000Z"))).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
    ]);
  });

  it("pencere başlangıcı en eski ayın ilk gününe (yerel saatle) denk gelir", () => {
    const now = new Date("2026-01-15T12:00:00.000Z");
    // recentMonthKeys(3) → ilk ay 2025-11 → 1 Kasım 00:00 İstanbul = 31 Ekim 21:00 UTC
    expect(monthlyFinanceWindowStart(3, now).toISOString()).toBe(
      "2025-10-31T21:00:00.000Z"
    );
    expect(monthlyFinanceWindowStart(1, now).toISOString()).toBe(
      "2025-12-31T21:00:00.000Z"
    );
    // 12 ay geriye: 2025-02 → 1 Şubat 00:00 İstanbul
    expect(monthlyFinanceWindowStart(12, now).toISOString()).toBe(
      "2025-01-31T21:00:00.000Z"
    );
  });

  it("pencere dışındaki satırları elemek toplamları değiştirmez", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const inWindow = {
      platform: "shopify",
      orderedAt: new Date("2026-07-10T10:00:00.000Z"),
      revenueKurus: 10_000,
      profitKurus: 3_000,
      profitPartial: false,
      statusKind: "delivered",
      currency: "TRY",
    };
    const tooOld = { ...inWindow, orderedAt: new Date("2023-01-10T10:00:00.000Z") };
    const windowStart = monthlyFinanceWindowStart(1, now);

    const withHistory = aggregateMonthlyFinance({
      monthCount: 1,
      now,
      snapshots: [inWindow, tooOld],
      expenses: [
        { paidAt: new Date("2026-07-11T10:00:00.000Z"), amountKurus: 1_000 },
        { paidAt: new Date("2023-01-11T10:00:00.000Z"), amountKurus: 9_900 },
      ],
    });
    const windowed = aggregateMonthlyFinance({
      monthCount: 1,
      now,
      snapshots: [inWindow, tooOld].filter((row) => row.orderedAt >= windowStart),
      expenses: [
        { paidAt: new Date("2026-07-11T10:00:00.000Z"), amountKurus: 1_000 },
        { paidAt: new Date("2023-01-11T10:00:00.000Z"), amountKurus: 9_900 },
      ].filter((row) => row.paidAt >= windowStart),
    });

    expect(windowed).toEqual(withHistory);
    expect(windowed[0]).toMatchObject({ revenue: 100, orderProfit: 30, expenses: 10 });
  });

  it("parayı kuruşa yuvarlar", () => {
    expect(tlToKurus(10.005)).toBe(1001);
    expect(tlToKurus(1.005)).toBe(101);
    expect(tlToKurus(-1.005)).toBe(-101);
    expect(tlToKurus(10.075)).toBe(1008);
    expect(tlToKurus(100.335)).toBe(10034);
    expect(tlToKurus(344.98)).toBe(34498);
  });

  it("iptalleri hariç tutup eksik ve kısmi kâr kalitesini açıklar", () => {
    const months = aggregateMonthlyFinance({
      monthCount: 1,
      now: new Date("2026-07-20T12:00:00.000Z"),
      snapshots: [
        {
          platform: "shopify",
          orderedAt: new Date("2026-07-01T10:00:00.000Z"),
          revenueKurus: 34_498,
          profitKurus: 7_333,
          profitPartial: true,
          statusKind: "processing",
          currency: "TRY",
        },
        {
          platform: "trendyol",
          orderedAt: new Date("2026-07-02T10:00:00.000Z"),
          revenueKurus: 10_000,
          profitKurus: null,
          profitPartial: false,
          statusKind: "delivered",
          currency: "TRY",
        },
        {
          platform: "shopify",
          orderedAt: new Date("2026-07-03T10:00:00.000Z"),
          revenueKurus: 99_999,
          profitKurus: 50_000,
          profitPartial: false,
          statusKind: "cancelled",
          currency: "TRY",
        },
        {
          platform: "shopify",
          orderedAt: new Date("2026-07-04T10:00:00.000Z"),
          revenueKurus: 1_000,
          profitKurus: 500,
          profitPartial: false,
          statusKind: "processing",
          currency: "USD",
        },
      ],
      expenses: [{ paidAt: new Date("2026-07-10T10:00:00.000Z"), amountKurus: 2_000 }],
    });

    expect(months[0]).toMatchObject({
      month: "2026-07",
      revenue: 444.98,
      orderProfit: 73.33,
      expenses: 20,
      netProfit: 53.33,
      orderCount: 2,
      incompleteOrders: 2,
      partialProfitOrders: 1,
      missingProfitOrders: 1,
      excludedOrders: 2,
      unsupportedCurrencyOrders: 1,
    });
    expect(months[0].byPlatform.shopify).toEqual({
      revenue: 344.98,
      orderProfit: 73.33,
      orderCount: 1,
    });
  });

  it("manuel siparişi kendi kaynağından bir kez sayıp manual snapshot kopyasını dışlar", () => {
    const duplicate = {
      orderedAt: new Date("2026-07-05T10:00:00.000Z"),
      revenueKurus: 20_000,
      profitKurus: 5_000,
      profitPartial: false,
      statusKind: "delivered",
      currency: "TRY",
    };
    const months = aggregateMonthlyFinance({
      monthCount: 1,
      now: new Date("2026-07-20T12:00:00.000Z"),
      snapshots: [{ ...duplicate, platform: "manual" }],
      manualOrders: [duplicate],
      expenses: [],
    });

    expect(months[0]).toMatchObject({
      revenue: 200,
      orderProfit: 50,
      orderCount: 1,
    });
    expect(months[0].byPlatform.manual).toEqual({
      revenue: 200,
      orderProfit: 50,
      orderCount: 1,
    });
  });
});

/**
 * KDV özeti: rakamlar yalnız KAYITLI alanlardan gelir. Ayrıştırılmamış siparişin KDV'si
 * SIFIR sayılmaz — "bilinmiyor" olarak ayrı sayılır ki arayüz kapsamı dürüstçe söyleyebilsin.
 */
describe("aylık KDV özeti", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");
  const manual = {
    orderedAt: new Date("2026-07-05T10:00:00.000Z"),
    revenueKurus: 120_000,
    netRevenueKurus: 100_000,
    inputVatCreditKurus: 6_000,
    profitKurus: 25_000,
    profitPartial: false,
    statusKind: "delivered",
    currency: "TRY",
  };

  it("hesaplanan KDV'yi kayıtlı brüt ve net cironun farkından çıkarır", () => {
    const months = aggregateMonthlyFinance({
      monthCount: 1,
      now,
      snapshots: [],
      manualOrders: [manual],
      expenses: [],
    });

    expect(months[0].vat).toEqual({
      outputVat: 200,
      inputVatCredit: 60,
      payable: 140,
      knownOrders: 1,
      partialOrders: 0,
      unknownOrders: 0,
      unknownRevenue: 0,
    });
  });

  /**
   * GERİLEME KİLİDİ: KDV özeti bir dönem YALNIZ manuel siparişleri kapsıyordu — pazaryeri
   * siparişlerinin KDV'si hiç kaydedilmediği için hepsi "bilinmiyor" sayılıyor ve muhasebeye
   * götürülen "Ödenecek KDV" rakamı ayın küçük bir parçasını gösteriyordu.
   */
  it("pazaryeri siparişlerinin kayıtlı KDV'sini de özete katar", () => {
    const months = aggregateMonthlyFinance({
      monthCount: 1,
      now,
      snapshots: [
        {
          platform: "trendyol",
          orderedAt: new Date("2026-07-06T10:00:00.000Z"),
          revenueKurus: 45_000,
          profitKurus: 9_000,
          profitPartial: false,
          statusKind: "delivered",
          currency: "TRY",
          outputVatKurus: 7_500,
          inputVatCreditKurus: 2_500,
        },
        {
          platform: "shopify",
          orderedAt: new Date("2026-07-08T10:00:00.000Z"),
          revenueKurus: 30_000,
          profitKurus: 6_000,
          profitPartial: false,
          statusKind: "delivered",
          currency: "TRY",
          outputVatKurus: 5_000,
          inputVatCreditKurus: 1_500,
        },
      ],
      manualOrders: [manual],
      expenses: [],
    });

    // Manuel 200 + Trendyol 75 + Shopify 50; indirilecek 60 + 25 + 15.
    expect(months[0].vat).toEqual({
      outputVat: 325,
      inputVatCredit: 100,
      payable: 225,
      knownOrders: 3,
      partialOrders: 0,
      unknownOrders: 0,
      unknownRevenue: 0,
    });
  });

  it("pazaryeri siparişinin indirilecek KDV'si yoksa hesaplananı yine sayar", () => {
    const months = aggregateMonthlyFinance({
      monthCount: 1,
      now,
      snapshots: [
        {
          platform: "hepsiburada",
          orderedAt: new Date("2026-07-09T10:00:00.000Z"),
          revenueKurus: 24_000,
          profitKurus: null,
          profitPartial: true,
          statusKind: "delivered",
          currency: "TRY",
          outputVatKurus: 4_000,
          inputVatCreditKurus: null,
        },
      ],
      expenses: [],
    });

    expect(months[0].vat).toMatchObject({
      outputVat: 40,
      inputVatCredit: 0,
      knownOrders: 1,
      // Maliyeti eksik → indirilecek KDV de eksik olabilir; kullanıcı uyarılmalı.
      partialOrders: 1,
      unknownOrders: 0,
    });
  });

  it("KDV'si ayrıştırılmamış siparişi sıfır saymaz, kapsam dışı olarak sayar", () => {
    const months = aggregateMonthlyFinance({
      monthCount: 1,
      now,
      snapshots: [
        {
          platform: "trendyol",
          orderedAt: new Date("2026-07-06T10:00:00.000Z"),
          revenueKurus: 45_000,
          profitKurus: 9_000,
          profitPartial: false,
          statusKind: "delivered",
          currency: "TRY",
        },
      ],
      manualOrders: [manual],
      expenses: [],
    });

    expect(months[0].vat).toMatchObject({
      outputVat: 200,
      inputVatCredit: 60,
      knownOrders: 1,
      unknownOrders: 1,
      unknownRevenue: 450,
    });
  });

  it("iptal ve yabancı para siparişleri KDV'ye hiç girmez", () => {
    const months = aggregateMonthlyFinance({
      monthCount: 1,
      now,
      snapshots: [],
      manualOrders: [
        { ...manual, statusKind: "cancelled" },
        { ...manual, currency: "USD" },
      ],
      expenses: [],
    });

    expect(months[0].vat).toMatchObject({
      outputVat: 0,
      inputVatCredit: 0,
      knownOrders: 0,
      unknownOrders: 0,
      unknownRevenue: 0,
    });
  });

  it("maliyeti eksik siparişte indirilecek KDV'nin eksik olabileceğini işaretler", () => {
    const months = aggregateMonthlyFinance({
      monthCount: 1,
      now,
      snapshots: [],
      manualOrders: [{ ...manual, profitKurus: null, profitPartial: true }],
      expenses: [],
    });

    expect(months[0].vat).toMatchObject({ knownOrders: 1, partialOrders: 1 });
  });

  it("indirilecek KDV daha yüksekse fark eksi (devreden) çıkar", () => {
    const months = aggregateMonthlyFinance({
      monthCount: 1,
      now,
      snapshots: [],
      manualOrders: [{ ...manual, inputVatCreditKurus: 35_000 }],
      expenses: [],
    });

    expect(months[0].vat.payable).toBe(-150);
  });

  it("KDV eklemek mevcut ciro ve kâr rakamlarını değiştirmez", () => {
    const months = aggregateMonthlyFinance({
      monthCount: 1,
      now,
      snapshots: [],
      manualOrders: [manual],
      expenses: [{ paidAt: new Date("2026-07-10T10:00:00.000Z"), amountKurus: 5_000 }],
    });

    expect(months[0]).toMatchObject({
      revenue: 1_200,
      orderProfit: 250,
      expenses: 50,
      netProfit: 200,
      orderCount: 1,
    });
  });
});
