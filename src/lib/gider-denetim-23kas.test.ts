/**
 * Gider Ödemeleri denetimi (23 Kas 2026) — Türkçe tutar okuyucu bekçi testleri.
 * Reklam bütçesi girişinde "1.500" günde 1,5 ₺ okunuyor, "abc" 0 sayılıp reklam sessizce duruyordu.
 */
import { describe, expect, it } from "vitest";

import { trTutarOku } from "@/core/tr-sayi";

describe("Türkçe tutar okuma", () => {
  it("binlik ayırıcı nokta, ondalık virgül", () => {
    expect(trTutarOku("1.500")).toBe(1500);
    expect(trTutarOku("12.500.000")).toBe(12_500_000);
    expect(trTutarOku("1.500,75")).toBe(1500.75);
    expect(trTutarOku("1,5")).toBe(1.5);
    expect(trTutarOku("800")).toBe(800);
    expect(trTutarOku(" 800 ₺ ")).toBe(800);
  });

  it("binlik kalıbına uymayan nokta ondalıktır", () => {
    expect(trTutarOku("0.65")).toBe(0.65);
    expect(trTutarOku("12.5")).toBe(12.5);
    expect(trTutarOku("0.650")).toBe(0.65);
  });

  it("boş ya da geçersiz → null (sıfır DEĞİL)", () => {
    expect(trTutarOku("")).toBeNull();
    expect(trTutarOku("   ")).toBeNull();
    expect(trTutarOku("abc")).toBeNull();
    expect(trTutarOku(null)).toBeNull();
  });
});
