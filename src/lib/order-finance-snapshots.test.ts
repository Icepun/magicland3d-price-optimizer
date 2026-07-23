import { describe, expect, it } from "vitest";
import {
  canonicalFinanceOrderId,
  shouldReplaceCapturedProfit,
} from "./order-finance-snapshots";

describe("finance snapshot order ids", () => {
  it("masaüstü ve mobil Shopify kimliklerini aynı kanonik kimliğe çevirir", () => {
    expect(canonicalFinanceOrderId("shopify", "gid://shopify/Order/12345")).toBe(
      "sh-12345"
    );
    expect(canonicalFinanceOrderId("shopify", "sh-12345")).toBe("sh-12345");
  });

  it("diğer platform kimliklerini değiştirmez", () => {
    expect(canonicalFinanceOrderId("trendyol", "ty-42")).toBe("ty-42");
    expect(canonicalFinanceOrderId("hepsiburada", "hb-99")).toBe("hb-99");
  });

  it("tam yakalanmış kârı maliyet değişince korur, gelir/iade değişince yeniler", () => {
    const captured = {
      revenueKurus: 10_000,
      profitKurus: 2_500,
      profitPartial: false,
    };
    expect(
      shouldReplaceCapturedProfit(captured, {
        revenueKurus: 10_000,
        profitKurus: 2_000,
        profitPartial: false,
      })
    ).toBe(false);
    expect(
      shouldReplaceCapturedProfit(captured, {
        revenueKurus: 8_000,
        profitKurus: 500,
        profitPartial: true,
      })
    ).toBe(true);
  });

  it("eksik veya kısmi kâr tam hesaplanınca yakalanan değeri geliştirir", () => {
    expect(
      shouldReplaceCapturedProfit(
        { revenueKurus: 10_000, profitKurus: null, profitPartial: false },
        { revenueKurus: 10_000, profitKurus: 2_000, profitPartial: true }
      )
    ).toBe(true);
    expect(
      shouldReplaceCapturedProfit(
        { revenueKurus: 10_000, profitKurus: 1_500, profitPartial: true },
        { revenueKurus: 10_000, profitKurus: 2_000, profitPartial: false }
      )
    ).toBe(true);
  });
});
