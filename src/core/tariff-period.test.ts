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
import { tarifeDonemSiniri, yururluktekiDonemBaslangiciMs } from "./tariff-period";
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

/**
 * YENİ KURAL HANGİ DÖNEME KATILIR?
 *
 * `validFrom` verilmeden eklenen kural SINIRSIZ olur ve tüm GEÇMİŞE uygulanır: tarife
 * dönemlendikten sonra eski dönemin kurallarıyla çakışır, aynı desi bandına iki kural uyar ve
 * geçmiş siparişlerin kârı sessizce değişir. Bugüne barem eklemek geçmişi bozmamalı.
 */
describe("yeni kural hangi döneme katılır", () => {
  const BUGUN = new Date("2026-08-16T12:00:00+03:00").getTime();
  const AGU = new Date("2026-08-01T00:00:00+03:00").getTime();
  const EYL = new Date("2026-09-01T00:00:00+03:00").getTime();
  const TEM_SON = new Date("2026-07-31T23:59:59.999+03:00").getTime();

  it("yürürlükteki dönemin başlangıcını verir", () => {
    const kurallar = [
      { validFrom: null, validTo: TEM_SON }, // kapanmış
      { validFrom: AGU, validTo: null }, // yürürlükte
    ];
    expect(yururluktekiDonemBaslangiciMs(kurallar, BUGUN)).toBe(AGU);
  });

  it("YAKLAŞAN döneme katılmaz — bugün geçerli olana katılır", () => {
    const kurallar = [
      { validFrom: AGU, validTo: null }, // yürürlükte
      { validFrom: EYL, validTo: null }, // henüz başlamadı
    ];
    expect(yururluktekiDonemBaslangiciMs(kurallar, BUGUN)).toBe(AGU);
  });

  it("bitişi GELECEKTE olan dönem hâlâ yürürlükte — kapanmış sayılmaz", () => {
    // İleri tarihli tarife başlatılınca bugünkü dönem de validTo alır ama hâlâ geçerlidir.
    // Kapanmış sayılsaydı yeni kural sessizce "sınırsız" doğar ve TÜM GEÇMİŞE uygulanırdı.
    const EYL_SON = new Date("2026-09-30T23:59:59.999+03:00").getTime();
    const kurallar = [
      { validFrom: AGU, validTo: EYL_SON }, // bugün yürürlükte, bitişi gelecekte
      { validFrom: new Date("2026-10-01T00:00:00+03:00").getTime(), validTo: null }, // yaklaşan
    ];
    expect(yururluktekiDonemBaslangiciMs(kurallar, BUGUN)).toBe(AGU);
  });

  it("kapanmış dönemler hiç sayılmaz", () => {
    const kurallar = [{ validFrom: AGU, validTo: TEM_SON }];
    expect(yururluktekiDonemBaslangiciMs(kurallar, BUGUN)).toBeNull();
  });

  it("henüz dönemlenmemiş platformda null döner (bugünkü Shopify) — davranış değişmez", () => {
    const kurallar = [{ validFrom: null, validTo: null }];
    expect(yururluktekiDonemBaslangiciMs(kurallar, BUGUN)).toBeNull();
  });

  it("epoch-ms ve ISO metin biçimlerinin ikisini de çözer (mobil ham SQL / masaüstü Prisma)", () => {
    const iso = new Date(AGU).toISOString();
    expect(yururluktekiDonemBaslangiciMs([{ validFrom: iso, validTo: null }], BUGUN)).toBe(AGU);
    expect(yururluktekiDonemBaslangiciMs([{ validFrom: AGU, validTo: null }], BUGUN)).toBe(AGU);
    expect(yururluktekiDonemBaslangiciMs([{ validFrom: new Date(AGU), validTo: null }], BUGUN)).toBe(AGU);
  });

  it("hiç kural yoksa null", () => {
    expect(yururluktekiDonemBaslangiciMs([], BUGUN)).toBeNull();
  });
});
