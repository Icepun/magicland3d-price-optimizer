import { describe, expect, it } from "vitest";
import { applyActualCommissionToProfit } from "./platform-financials";

describe("platform gerçek komisyonu", () => {
  it("tahmini komisyonu gerçek komisyonla KDV etkisini koruyarak değiştirir", () => {
    const result = applyActualCommissionToProfit({
      profit: 100,
      profitPartial: false,
      orderRevenue: 200,
      settlementRevenue: 200,
      estimatedCommission: 42,
      actualCommission: 36,
      vatRate: 20,
    });

    expect(result.applied).toBe(true);
    expect(result.profit).toBeCloseTo(105, 6);
  });

  it("settlement cirosu siparişle uyuşmuyorsa hesabı değiştirmez", () => {
    const result = applyActualCommissionToProfit({
      profit: 100,
      profitPartial: false,
      orderRevenue: 200,
      settlementRevenue: 150,
      estimatedCommission: 42,
      actualCommission: 20,
      vatRate: 20,
    });

    expect(result.applied).toBe(false);
    expect(result.profit).toBe(100);
  });

  it("maliyeti eksik kısmi siparişe gerçek komisyon uygulamaz", () => {
    const result = applyActualCommissionToProfit({
      profit: 50,
      profitPartial: true,
      orderRevenue: 200,
      settlementRevenue: 200,
      estimatedCommission: 42,
      actualCommission: 36,
      vatRate: 20,
    });

    expect(result.applied).toBe(false);
    expect(result.profit).toBe(50);
  });
});
