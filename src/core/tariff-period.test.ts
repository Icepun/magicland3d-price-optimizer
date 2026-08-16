/**
 * YENİ TARİFE BAŞLATMA — dönem sınırı doğru mu, geçmiş korunuyor mu?
 *
 * "Yeni tarife başlat" akışı iki şey yapar: yürürlükteki kuralları yeni tarifenin başlangıcından
 * 1 ms önce kapatır, yeni kuralları o başlangıçla açar. Bu dosya iki şeyi kilitler:
 *   1. Sınırda ne BOŞLUK ne ÇAKIŞMA var — her an tam bir döneme düşer.
 *   2. Geçmiş dokunulmamış: eski tarihli bir sipariş hâlâ o günün fiyatını görür.
 *
 * Sınır hatası pahalı: boşlukta kargo sessizce 0 sayılır (kâr şişer), çakışmada hangi fiyatın
 * kazanacağı veritabanı satır sırasına kalır (aynı sipariş farklı zamanlarda farklı kâr verir).
 */
import { describe, expect, it } from "vitest";
import { findCargoRule } from "./cargo-calculator";
import { tarifeDonemSiniri } from "./tariff-period";
import type { CargoRuleInput } from "./types";

const TABAN = {
  platform: "trendyol",
  cargoProvider: "TEX",
  categoryName: null,
  minPrice: 0,
  maxPrice: 999999,
  minDesi: 0,
  maxDesi: 5,
  vatIncluded: false,
  priority: 10,
  isActive: true,
};

/** Akışın yaptığı dönüşümün AYNISI: eskiyi kapat, yeniyi aç. */
function tarifeBaslat(
  yururlukte: CargoRuleInput[],
  yeniFiyatlar: number[],
  baslangic: Date
): CargoRuleInput[] {
  const { eskiBitis } = tarifeDonemSiniri(baslangic);
  const kapanan = yururlukte.map((r) => ({ ...r, validTo: eskiBitis }));
  const yeni = yururlukte.map((r, i) => ({
    ...r,
    id: `${r.id}-yeni`,
    cargoCost: yeniFiyatlar[i],
    validFrom: baslangic,
    validTo: null,
  }));
  return [...kapanan, ...yeni];
}

const BASLANGIC = new Date("2026-09-01T00:00:00.000+03:00");

const YURURLUKTE: CargoRuleInput[] = [
  { ...TABAN, id: "a", name: "0-5 desi", cargoCost: 100, validFrom: null, validTo: null },
];

describe("yeni tarife başlatma", () => {
  const hepsi = tarifeBaslat(YURURLUKTE, [120], BASLANGIC);

  it("eski dönem, yeninin başlangıcından TAM 1 ms önce kapanır", () => {
    const { eskiBitis } = tarifeDonemSiniri(BASLANGIC);
    expect(BASLANGIC.getTime() - eskiBitis.getTime()).toBe(1);
  });

  it("sınırın hemen ÖNCESİ eski fiyatı görür", () => {
    const an = new Date(BASLANGIC.getTime() - 1);
    expect(findCargoRule(hepsi, 500, "", 2, an)?.cargoCost).toBe(100);
  });

  it("sınırın TAM ÜSTÜ yeni fiyatı görür", () => {
    expect(findCargoRule(hepsi, 500, "", 2, BASLANGIC)?.cargoCost).toBe(120);
  });

  it("sınır çevresinde HİÇBİR an kuralsız kalmaz", () => {
    for (let d = -5; d <= 5; d++) {
      const an = new Date(BASLANGIC.getTime() + d);
      const kural = findCargoRule(hepsi, 500, "", 2, an);
      expect(kural, `${d} ms sapmada kural bulunamadı`).toBeDefined();
      expect(kural?.cargoCost).toBe(d < 0 ? 100 : 120);
    }
  });

  it("GEÇMİŞ korunur — aylar öncesi sipariş hâlâ eski fiyatı görür", () => {
    const temmuz = new Date("2026-07-15T12:00:00+03:00");
    expect(findCargoRule(hepsi, 500, "", 2, temmuz)?.cargoCost).toBe(100);
  });

  it("PASİF barem de yeni döneme taşınır (barem modu bozulmasın)", () => {
    const pasifli: CargoRuleInput[] = [
      ...YURURLUKTE,
      { ...TABAN, id: "b", name: "avantajlı", cargoCost: 80, isActive: false, validFrom: null, validTo: null },
    ];
    const sonuc = tarifeBaslat(pasifli, [120, 96], BASLANGIC);
    const yeniPasif = sonuc.find((r) => r.id === "b-yeni");
    expect(yeniPasif).toBeDefined();
    expect(yeniPasif?.isActive).toBe(false);
    expect(yeniPasif?.cargoCost).toBe(96);
  });
});
