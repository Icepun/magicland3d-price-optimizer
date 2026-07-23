import { describe, expect, it } from "vitest";
import { resolveProductCost } from "./product-cost";

const BASE = {
  costMode: "manual",
  filamentWeight: null,
  printTimeHours: null,
  wasteRate: null,
  packagingOptionId: null,
  nylonLevel: null,
  tapeUsed: null,
};

describe("manuel ürün maliyeti", () => {
  it("ürün ve ambalaj ayrı kaydedildiyse ambalaj kapsamını korur", () => {
    const result = resolveProductCost(
      {
        ...BASE,
        manualCost: 50,
        packagingCost: 10,
        totalCost: 60,
      },
      {},
      0
    );

    expect(result?.productionCost).toBe(50);
    expect(result?.packagingCost).toBe(10);
    expect(result?.packagingBreakdown?.perShipment).toBe(10);
    expect(result?.totalCost).toBe(60);
  });

  it("eski kayıtta toplam zaten manualCost ise ambalajı ikinci kez eklemez", () => {
    const result = resolveProductCost(
      {
        ...BASE,
        manualCost: 60,
        packagingCost: 10,
        totalCost: 60,
      },
      {},
      0
    );

    expect(result?.productionCost).toBe(60);
    expect(result?.packagingCost).toBe(0);
    expect(result?.totalCost).toBe(60);
  });
});
