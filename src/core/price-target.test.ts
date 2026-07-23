import { describe, expect, it } from "vitest";
import { findMinimumPriceForMargin } from "./price-target";

describe("hedef fiyat araması", () => {
  it("kargo eşiğinde marj aşağı sıçrasa da eşikten önceki en düşük fiyatı bulur", () => {
    const marginAt = (price: number) => {
      const cargo = price < 200 ? 50.4 : 86.4;
      return (price - 108.4 - cargo) / price;
    };
    const price = findMinimumPriceForMargin({
      marginAt,
      targetMargin: 0.2,
      breakpoints: [200],
    });

    expect(price).toBe(198.5);
    expect(marginAt(price!)).toBeCloseTo(0.2, 10);
    expect(marginAt(price! - 0.01)).toBeLessThan(0.2);
  });
});
