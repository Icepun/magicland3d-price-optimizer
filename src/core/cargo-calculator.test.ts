import { describe, expect, it } from "vitest";
import { findCargoRule } from "./cargo-calculator";
import type { CargoRuleInput } from "./types";

function rule(overrides: Partial<CargoRuleInput>): CargoRuleInput {
  return {
    id: "general",
    name: "Genel kargo",
    minPrice: 0,
    maxPrice: 999_999,
    minDesi: 0,
    maxDesi: 999,
    cargoCost: 25,
    priority: 1,
    isActive: true,
    ...overrides,
  };
}

describe("findCargoRule", () => {
  it("eşleşmeyen yüksek öncelikli kategori kuralını uygulamaz", () => {
    const rules = [
      rule({
        id: "wrong-category",
        categoryName: "Elektronik",
        cargoCost: 99,
        priority: 100,
      }),
      rule({ id: "fallback" }),
    ];

    expect(findCargoRule(rules, 200, "Ev Dekorasyon", 1)?.id).toBe("fallback");
  });

  it("Türkçe harf, büyük/küçük harf ve fazla boşlukları normalize eder", () => {
    const rules = [
      rule({ id: "fallback" }),
      rule({
        id: "category",
        categoryName: "  İÇ   MEKAN  ",
        cargoCost: 15,
        priority: 0,
      }),
    ];

    expect(findCargoRule(rules, 200, "İç Mekan Dekorasyonu", 1)?.id).toBe("category");
  });
});
