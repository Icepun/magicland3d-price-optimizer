import { describe, expect, it } from "vitest";
import { komisyonBilinmiyor } from "./komisyon-bilinmiyor";

describe("komisyonBilinmiyor", () => {
  it("pazaryerinde oran da kural da yoksa bilinmiyor", () => {
    expect(komisyonBilinmiyor({ platform: "trendyol", commissionRate: null }, {})).toBe(true);
    expect(komisyonBilinmiyor({ platform: "hepsiburada", commissionRate: undefined }, { appliedCommissionRule: null })).toBe(true);
  });
  it("ilanın oranı (0 dahil) ya da eşleşen kural varsa biliniyor", () => {
    expect(komisyonBilinmiyor({ platform: "trendyol", commissionRate: 0 }, {})).toBe(false);
    expect(komisyonBilinmiyor({ platform: "trendyol", commissionRate: 0.225 }, {})).toBe(false);
    expect(komisyonBilinmiyor({ platform: "hepsiburada", commissionRate: null }, { appliedCommissionRule: { id: "k" } })).toBe(false);
  });
  it("Shopify'da pazaryeri komisyonu yok → hiçbir zaman 'bilinmiyor' değil", () => {
    expect(komisyonBilinmiyor({ platform: "shopify", commissionRate: null }, {})).toBe(false);
  });
});
