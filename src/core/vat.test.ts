import { describe, expect, it } from "vitest";
import { DEFAULT_VAT_RATE, resolveVatRate, vatRateOf } from "./vat";

describe("KDV oranı çözümü", () => {
  it("geçerli oranı olduğu gibi kullanır", () => {
    expect(resolveVatRate({ vatRate: "20" })).toEqual({ rate: 20, invalid: false });
    expect(resolveVatRate({ vatRate: "10.5" })).toEqual({ rate: 10.5, invalid: false });
  });

  /** SIFIR bilinçli bir tercih: "KDV uygulanmasın". Geçersiz sayılmamalı. */
  it("sıfırı geçerli kabul eder", () => {
    expect(resolveVatRate({ vatRate: "0" })).toEqual({ rate: 0, invalid: false });
  });

  /**
   * ASIL HATA: ayar hiç yoksa 0 kabul ediliyordu → KDV hiç uygulanmıyor → TÜM kârlar
   * yaklaşık %20 şişik görünüyordu ve hiçbir uyarı çıkmıyordu.
   */
  it("ayar hiç yoksa varsayılana düşer ve uyarı bayrağı kaldırır", () => {
    expect(resolveVatRate({})).toEqual({ rate: DEFAULT_VAT_RATE, invalid: true });
    expect(resolveVatRate(undefined)).toEqual({ rate: DEFAULT_VAT_RATE, invalid: true });
    expect(resolveVatRate({ vatRate: "" })).toEqual({ rate: DEFAULT_VAT_RATE, invalid: true });
    expect(resolveVatRate({ vatRate: "   " })).toEqual({ rate: DEFAULT_VAT_RATE, invalid: true });
  });

  it("sayı olmayan değerde NaN sızdırmaz", () => {
    expect(resolveVatRate({ vatRate: "yirmi" })).toEqual({ rate: DEFAULT_VAT_RATE, invalid: true });
    expect(resolveVatRate({ vatRate: "20%" })).toEqual({ rate: DEFAULT_VAT_RATE, invalid: true });
    expect(Number.isFinite(vatRateOf({ vatRate: "yirmi" }))).toBe(true);
  });

  it("aralık dışı değeri kabul etmez", () => {
    expect(resolveVatRate({ vatRate: "-5" }).invalid).toBe(true);
    expect(resolveVatRate({ vatRate: "150" }).invalid).toBe(true);
  });

  it("varsayılan Türkiye standart oranıdır", () => {
    expect(DEFAULT_VAT_RATE).toBe(20);
  });
});
