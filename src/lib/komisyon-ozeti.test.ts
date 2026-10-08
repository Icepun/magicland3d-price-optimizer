import { describe, expect, it } from "vitest";

import { komisyonOzeti } from "./komisyon-ozeti";

describe("komisyon özeti", () => {
  it("platform başına ciro, komisyon ve oran; gerçek ve tahmin ayrı sayılır", () => {
    const o = komisyonOzeti([
      { platform: "trendyol", total: 100, actualCommission: 20 },
      { platform: "trendyol", total: 100, estimatedCommission: 18 },
      { platform: "hepsiburada", total: 200, actualCommission: 20 },
      { platform: "trendyol", total: 50 },
    ]);
    expect(o[0]).toMatchObject({ platform: "trendyol", siparis: 3, ciro: 250, komisyon: 38, gercekAdet: 1, tahminAdet: 1, bilinmeyenAdet: 1 });
    expect(o[0].oran).toBeCloseTo(38 / 250, 10);
    expect(o[1]).toMatchObject({ platform: "hepsiburada", oran: 0.1 });
  });

  it("iptal, döviz ve elle sipariş sayılmaz", () => {
    const o = komisyonOzeti([
      { platform: "trendyol", total: 100, actualCommission: 20, statusKind: "cancelled" },
      { platform: "shopify", total: 100, actualCommission: 3, currency: "USD" },
      { platform: "manual", total: 100, estimatedCommission: 0 },
    ]);
    expect(o).toEqual([]);
  });
});
