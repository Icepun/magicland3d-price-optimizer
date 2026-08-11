import { describe, expect, it } from "vitest";
import { categoryMatchScore, categoryMatches, normalizeCategory } from "./category";
import { calculateExpenses } from "./pricing-engine";
import { findCargoRule } from "./cargo-calculator";
import type { ExpenseRuleInput, CargoRuleInput } from "./types";

describe("kategori normalizasyonu", () => {
  /**
   * ASIL HATA: gider motoru düz toLowerCase() kullanıyordu. Türkçe'de büyük "I" düz
   * kurallarla "i"ye, Türkçe kurallarla "ı"ya dönüşür. Kullanıcı kuralı küçük harfle
   * yazdığında komisyon/kargo kuralı uyuyor, GİDER kuralı sessizce uymuyordu.
   */
  it("Türkçe büyük I'yı noktasız ı'ya çevirir", () => {
    expect(normalizeCategory("Işıklı Dekor")).toBe("ışıklı dekor");
    expect(normalizeCategory("ışıklı dekor")).toBe("ışıklı dekor");
    expect(normalizeCategory("Işıklı Dekor")).toBe(normalizeCategory("ışıklı dekor"));
  });

  it("noktalı İ'yi de doğru küçültür", () => {
    expect(normalizeCategory("İkonlar")).toBe("ikonlar");
  });

  it("tekrarlı ve baştaki/sondaki boşlukları sadeleştirir", () => {
    expect(normalizeCategory("  Dekor   &  Figür ")).toBe("dekor & figür");
  });

  it("boş/null kategoriyi boş metne indirir", () => {
    expect(normalizeCategory(null)).toBe("");
    expect(normalizeCategory(undefined)).toBe("");
  });
});

describe("categoryMatches", () => {
  it("kuralda kategori yoksa tüm kategorilere uyar", () => {
    expect(categoryMatches(null, "Herhangi")).toBe(true);
    expect(categoryMatches("   ", "Herhangi")).toBe(true);
  });

  it("Türkçe büyük/küçük harf farkına takılmaz", () => {
    expect(categoryMatches("ışıklı", "Işıklı Dekor")).toBe(true);
  });

  it("ilgisiz kategoriye uymaz", () => {
    expect(categoryMatches("Takı", "Işıklı Dekor")).toBe(false);
  });
});

describe("categoryMatchScore", () => {
  it("tam eşleşmeye kapsayan eşleşmeden yüksek puan verir", () => {
    const tam = categoryMatchScore("Işıklı Dekor", "Işıklı Dekor");
    const kapsayan = categoryMatchScore("Dekor", "Işıklı Dekor");
    expect(tam).toBeGreaterThan(kapsayan);
    expect(kapsayan).toBeGreaterThan(0);
  });
});

describe("üç motor AYNI kategori kuralını kullanır", () => {
  const KATEGORI = "Işıklı Dekor";
  // Kullanıcı kuralı küçük harfle yazmış — gerçek hayatta olan durum.
  const KURAL_KATEGORISI = "ışıklı dekor";

  it("gider kuralı artık uygulanıyor (regresyon)", () => {
    const rules: ExpenseRuleInput[] = [
      {
        id: "e1",
        name: "Hizmet bedeli",
        platform: null,
        type: "fixed",
        value: 12,
        categoryName: KURAL_KATEGORISI,
        minPrice: 0,
        maxPrice: 999999,
        priority: 10,
        isActive: true,
      },
    ];
    const sonuc = calculateExpenses(rules, 200, KATEGORI);
    expect(sonuc.fixed).toBe(12); // eskiden 0'dı — kural sessizce atlanıyordu
  });

  it("kargo kuralıyla aynı sonucu verir (iki motor ayrışmaz)", () => {
    const rules: CargoRuleInput[] = [
      {
        id: "c1",
        name: "Standart",
        platform: null,
        cargoProvider: null,
        categoryName: KURAL_KATEGORISI,
        minPrice: 0,
        maxPrice: 999999,
        minDesi: 0,
        maxDesi: 30,
        cargoCost: 100,
        vatIncluded: true,
        validFrom: null,
        validTo: null,
        priority: 10,
        isActive: true,
      },
    ];
    expect(findCargoRule(rules, 200, KATEGORI, 1)?.cargoCost).toBe(100);
  });
});
