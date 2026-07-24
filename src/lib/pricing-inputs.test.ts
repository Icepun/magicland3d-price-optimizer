import { describe, it, expect } from "vitest";
import {
  settingsBodyAffectsProfit,
  productPatchAffectsProfit,
  FINANCIAL_SETTING_KEYS,
} from "./pricing-inputs";

describe("settingsBodyAffectsProfit", () => {
  it("kâr girdileri → true", () => {
    expect(settingsBodyAffectsProfit({ vatRate: "20" })).toBe(true);
    expect(settingsBodyAffectsProfit({ shopifyCommissionRate: "10" })).toBe(true);
    expect(settingsBodyAffectsProfit({ costLaborPerHour: "50" })).toBe(true);
    expect(settingsBodyAffectsProfit({ packagingOptions: "[]" })).toBe(true);
    expect(settingsBodyAffectsProfit({ packagingScopes: "{}" })).toBe(true);
    expect(settingsBodyAffectsProfit({ nylonRollPrice: "5", tapePrice: "2" })).toBe(true);
  });

  it("finans-dışı anahtarlar → false", () => {
    expect(settingsBodyAffectsProfit({ plannerTargetStock: "10" })).toBe(false);
    expect(settingsBodyAffectsProfit({ r2AccountId: "abc", r2Bucket: "b" })).toBe(false);
    expect(settingsBodyAffectsProfit({ r2AccessKeyId: "x", r2SecretAccessKey: "y" })).toBe(false);
    expect(settingsBodyAffectsProfit({})).toBe(false);
  });

  it("karışık gövde: bir finansal anahtar varsa → true", () => {
    expect(settingsBodyAffectsProfit({ plannerTargetStock: "10", vatRate: "20" })).toBe(true);
  });
});

describe("productPatchAffectsProfit", () => {
  it("kâr/eşleşme alanları → true", () => {
    expect(productPatchAffectsProfit({ cost: { costMode: "manual" } })).toBe(true);
    expect(productPatchAffectsProfit({ barcode: "123" })).toBe(true);
    expect(productPatchAffectsProfit({ categoryName: "Oyuncak" })).toBe(true);
    expect(productPatchAffectsProfit({ desi: 2 })).toBe(true);
    expect(productPatchAffectsProfit({ name: "Yeni Ad" })).toBe(true);
  });

  it("kâra girmeyen alanlar → false", () => {
    expect(productPatchAffectsProfit({ imageUrl: "http://x" })).toBe(false);
    expect(productPatchAffectsProfit({ imageManual: true })).toBe(false);
    expect(productPatchAffectsProfit({ alias: "kısa" })).toBe(false);
    expect(productPatchAffectsProfit({ hidden: true })).toBe(false);
    expect(productPatchAffectsProfit({ isActive: false })).toBe(false);
    expect(productPatchAffectsProfit({ variantGroupId: "vg_1" })).toBe(false);
    expect(productPatchAffectsProfit({ variantLabel: "Kırmızı" })).toBe(false);
    expect(productPatchAffectsProfit({ currentSalePrice: 99.9 })).toBe(false);
    expect(productPatchAffectsProfit({ listPrice: 120 })).toBe(false);
    expect(productPatchAffectsProfit({ weight: 200 })).toBe(false);
    expect(productPatchAffectsProfit({ stock: 5 })).toBe(false);
    expect(productPatchAffectsProfit({ madeToOrder: true })).toBe(false);
  });

  it("undefined alan değişmemiş sayılır → false", () => {
    expect(productPatchAffectsProfit({ cost: undefined, name: undefined })).toBe(false);
  });

  it("karışık: görsel + maliyet → true (maliyet var)", () => {
    expect(productPatchAffectsProfit({ imageUrl: "http://x", cost: { costMode: "manual" } })).toBe(true);
  });
});

describe("FINANCIAL_SETTING_KEYS kapsamı", () => {
  it("bilinen finansal anahtarları içerir, finans-dışını içermez", () => {
    for (const k of ["vatRate", "costElectricityPerHour", "sakizPrice", "cardQty"]) {
      expect(FINANCIAL_SETTING_KEYS.has(k)).toBe(true);
    }
    for (const k of ["plannerTargetStock", "r2Bucket", "theme"]) {
      expect(FINANCIAL_SETTING_KEYS.has(k)).toBe(false);
    }
  });
});
