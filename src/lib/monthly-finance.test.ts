import { describe, expect, it } from "vitest";
import {
  aggregateMonthlyFinance,
  monthKey,
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
