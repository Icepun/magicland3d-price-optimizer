import { describe, expect, it } from "vitest";
import {
  costValuesEqual,
  costValuesOf,
  parseDesiInput,
  validateCostFields,
  type CostValues,
  type SavedCostSnapshot,
} from "./CostEditor";

/**
 * Ürün detayındaki maliyet formu. Buradaki iki karar doğrudan VERİ KAYBI üretiyordu:
 *
 * 1) Desi 0 "boş" sayılıyordu → detay açılır açılmaz desi siliniyor, kargo 1 desi üzerinden
 *    hesaplanıp kâr şişiyordu.
 * 2) Form, kayıtlı değerle "aynı" olduğu halde farklı görünüyordu (yüzde ↔ oran çevriminin
 *    ondalık artığı) → kullanıcı hiçbir şeye dokunmadan kayıt tetikleniyordu.
 */

const KAYITLI: SavedCostSnapshot = {
  desi: 2,
  cost: {
    filamentTypeId: "fil-1",
    filamentWeight: 20,
    printTimeHours: 1.5,
    wasteRate: 0.07,
    packagingOptionId: "poset-1",
    nylonLevel: "low",
    tapeUsed: true,
  },
};

describe("desi girişi", () => {
  it("0 GEÇERLİ bir desidir — boş sayılmaz", () => {
    expect(parseDesiInput("0")).toBe(0);
    expect(parseDesiInput("0,0")).toBe(0);
  });

  it("boş metin 'girilmedi' demektir", () => {
    expect(parseDesiInput("")).toBeNull();
    expect(parseDesiInput("   ")).toBeNull();
  });

  it("ondalık ve virgüllü giriş okunur", () => {
    expect(parseDesiInput("1.5")).toBe(1.5);
    expect(parseDesiInput("1,5")).toBe(1.5);
  });

  it("geçersiz ve eksi değer 'girilmedi' sayılır (kargo baremini bozmaz)", () => {
    expect(parseDesiInput("abc")).toBeNull();
    expect(parseDesiInput("-2")).toBeNull();
  });
});

describe("desi 0 olan ürün açıldığında kayıt tetiklenmez", () => {
  it("desi 0 ile seed edilen form kayıtlı değerle AYNI sayılır", () => {
    const kayitli: SavedCostSnapshot = { ...KAYITLI, desi: 0 };
    const seed = costValuesOf(kayitli);

    expect(seed.desi).toBe(0);
    expect(costValuesEqual(costValuesOf(kayitli), seed)).toBe(true);
  });

  it("0 ile 'girilmedi' aynı şey DEĞİLDİR — 0'ı silen kayıt değişiklik sayılır", () => {
    const sifir = costValuesOf({ ...KAYITLI, desi: 0 });
    const bos = costValuesOf({ ...KAYITLI, desi: null });

    expect(costValuesEqual(sifir, bos)).toBe(false);
  });

  it("fire oranının yüzde çevriminden dönen ondalık artığı 'değişti' sayılmaz", () => {
    const seed = costValuesOf(KAYITLI);
    // Form yüzdeye çevirip geri okur: 0,07 → 7.000000000000001 → 0,07000000000000001
    const formdan: CostValues = { ...seed, wasteRate: (0.07 * 100) / 100 + 1e-15 };

    expect(formdan.wasteRate).not.toBe(seed.wasteRate);
    expect(costValuesEqual(seed, formdan)).toBe(true);
  });

  it("gerçek bir değişiklik yakalanır", () => {
    const seed = costValuesOf(KAYITLI);
    expect(costValuesEqual(seed, { ...seed, filamentWeight: 21 })).toBe(false);
    expect(costValuesEqual(seed, { ...seed, filamentTypeId: "" })).toBe(false);
    expect(costValuesEqual(seed, { ...seed, tapeUsed: false })).toBe(false);
    expect(costValuesEqual(seed, { ...seed, desi: 3 })).toBe(false);
  });

  it("maliyet kaydı hiç yokken seed boş formdur", () => {
    const seed = costValuesOf({ desi: null, cost: null });
    expect(seed).toEqual({
      filamentTypeId: "",
      filamentWeight: 0,
      printTimeHours: 0,
      wasteRate: 0,
      packagingOptionId: "",
      nylonLevel: "none",
      tapeUsed: false,
      desi: null,
    });
    expect(costValuesEqual(seed, costValuesOf({ desi: null, cost: null }))).toBe(true);
  });
});

describe("sınır aşımı kaynakta yakalanır", () => {
  const bos = { filamentWeight: "", printTimeHours: "", wasteRate: "", desiInput: "" };

  it("geçerli formda uyarı yok", () => {
    expect(validateCostFields({ ...bos, filamentWeight: "20", wasteRate: "5", desiInput: "0" })).toEqual({});
  });

  it("%100 üstü fire uyarı verir (istek gitmeden)", () => {
    expect(validateCostFields({ ...bos, wasteRate: "150" }).wasteRate).toBe(
      "Fire en fazla %100 olabilir"
    );
    // Tam sınır geçerlidir.
    expect(validateCostFields({ ...bos, wasteRate: "100" })).toEqual({});
  });

  it("eksi değerler alan bazında uyarı verir", () => {
    const hatalar = validateCostFields({
      filamentWeight: "-1",
      printTimeHours: "-2",
      wasteRate: "-3",
      desiInput: "-4",
    });
    expect(hatalar).toEqual({
      filamentWeight: "Ağırlık eksi olamaz",
      printTimeHours: "Süre eksi olamaz",
      wasteRate: "Fire eksi olamaz",
      desi: "Desi eksi olamaz",
    });
  });

  it("uyarı metinleri kısa ve jargonsuz", () => {
    const hatalar = validateCostFields({
      filamentWeight: "-1",
      printTimeHours: "-1",
      wasteRate: "150",
      desiInput: "-1",
    });
    for (const mesaj of Object.values(hatalar)) {
      expect(mesaj.length).toBeLessThanOrEqual(40);
      expect(mesaj).not.toMatch(/HTTP|zod|schema|null|undefined/i);
    }
  });
});
