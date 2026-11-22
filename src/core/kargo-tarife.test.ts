import { describe, expect, it } from "vitest";
import {
  desiListesiFiyati,
  iadeKargoTahmini,
  kargoFirmasiKodu,
  kargoTahmini,
  tarifeDonemiBul,
} from "./kargo-tarife";

// Örneklerin tamamı gerçek faturalardan (KDV hariç; 22 Kas 2026 ölçümü).
const EKIM = new Date("2026-10-15T10:00:00Z");

describe("kargo tarifesi — Trendyol", () => {
  const ty = (tutar: number, desi: number, baglam = {}) => kargoTahmini("trendyol", tutar, desi, EKIM, baglam);

  it("200 TL altı standart barem 73,33; 200–349,99 → 78,74", () => {
    expect(ty(149.99, 1)).toMatchObject({ fiyat: 73.33, tur: "barem", firma: "tex" });
    expect(ty(279.99, 1)).toMatchObject({ fiyat: 78.74, tur: "barem" });
    expect(ty(349.99, 1)?.fiyat).toBe(78.74);
  });

  it("hızlı teslimat + zamanında → avantajlı tablo (70,41 / 38,74)", () => {
    expect(ty(279.99, 1, { hizliTeslimat: true })).toMatchObject({ fiyat: 70.41, tur: "barem-avantajli" });
    expect(ty(199.99, 1, { hizliTeslimat: true })?.fiyat).toBe(38.74);
  });

  it("hızlı ama GEÇ kargolanan → standart", () => {
    expect(ty(279.99, 1, { hizliTeslimat: true, gecKargolandi: true })?.fiyat).toBe(78.74);
  });

  it("350 TL ve üstü → desi listesi (81,95 · 107,20 · 150,64 · 182,20)", () => {
    expect(ty(350, 1)).toMatchObject({ fiyat: 81.95, tur: "desi" });
    expect(ty(829.99, 4)?.fiyat).toBe(107.2);
    expect(ty(499.99, 9, { hizliTeslimat: true })?.fiyat).toBe(150.64);
    expect(ty(979.99, 12)?.fiyat).toBe(182.2);
  });

  it("10 desi üstü barem dışı → desi listesi", () => {
    expect(ty(249.99, 10)?.tur).toBe("barem");
    expect(ty(249.99, 11)).toMatchObject({ fiyat: 173.42, tur: "desi" });
  });

  it("firmaya göre barem fiyatı (DHL 94,99 standart)", () => {
    expect(ty(259.99, 2, { firma: "DHL eCommerce Marketplace" })).toMatchObject({ fiyat: 94.99, firma: "dhl" });
  });

  it("firmanın kendi desi listesi (resmi liste: DHL 3 desi 110,99)", () => {
    expect(ty(500, 3, { firma: "DHL eCommerce Marketplace" })).toMatchObject({ fiyat: 110.99, firma: "dhl", tur: "desi" });
  });

  it("tanınmayan firma varsayılanın (TEX) listesiyle", () => {
    expect(ty(500, 3, { firma: "CEVA Lojistik" })).toMatchObject({ fiyat: 100.2, firma: "tex", tur: "desi" });
  });

  it("kesilen tutardan desi bulunur (HB 107,99 → 4 desi; barem tutarı → null)", async () => {
    const { desiFiyatindanDesi } = await import("./kargo-tarife");
    expect(desiFiyatindanDesi("hepsiburada", "hepsiJET", EKIM, 107.99)).toBe(4);
    expect(desiFiyatindanDesi("hepsiburada", null, EKIM, 81.99)).toBe(1);
    expect(desiFiyatindanDesi("hepsiburada", null, EKIM, 75.99)).toBeNull();
    expect(desiFiyatindanDesi("trendyol", "Trendyol Express", EKIM, 150.64)).toBe(9);
  });

  it("iade kargosu baremden değil desi listesinden (81,95; Aras 109,90)", () => {
    expect(iadeKargoTahmini("trendyol", 149.99, 1, EKIM)?.fiyat).toBe(81.95);
    expect(iadeKargoTahmini("trendyol", 799.99, 4, EKIM, { firma: "Aras Kargo Marketplace" })?.fiyat).toBe(109.9);
  });
});

describe("kargo tarifesi — Hepsiburada", () => {
  const hb = (tutar: number, desi: number, gun: number | null, firma?: string) =>
    kargoTahmini("hepsiburada", tutar, desi, EKIM, { kargoyaVermeGunu: gun, firma });

  it("1 günde kargo: 200 altı 43,99; 200–399,99 → 75,99", () => {
    expect(hb(199.99, 1, 1)).toMatchObject({ fiyat: 43.99, tur: "barem", firma: "hepsijet" });
    expect(hb(399.99, 1, 1)?.fiyat).toBe(75.99);
  });

  it("kargoya verme 2 gün → desi listesi (81,99)", () => {
    expect(hb(339.99, 1, 2)).toMatchObject({ fiyat: 81.99, tur: "desi" });
  });

  it("süre bilinmiyorsa barem varsayılmaz (tedbirli)", () => {
    expect(hb(249.99, 1, null)?.tur).toBe("desi");
  });

  it("400 ve üstü → desi listesi (107,99 4 desi · 159,99 10 desi)", () => {
    expect(hb(400, 4, 1)?.fiyat).toBe(107.99);
    expect(hb(1399.98, 10, 1)?.fiyat).toBe(159.99);
  });

  it("barem tutarı ayrı verilebilir (müşterinin ödediği)", () => {
    expect(kargoTahmini("hepsiburada", 450, 1, EKIM, { kargoyaVermeGunu: 1, baremTutari: 399 })?.fiyat).toBe(75.99);
  });

  it("DHL ve Aras kendi listeleriyle (100,99 · 89,92)", () => {
    expect(hb(500, 1, 1, "DHL eCommerce")?.fiyat).toBe(100.99);
    expect(hb(500, 1, 2, "Aras Kargo")?.fiyat).toBe(89.92);
  });

  it("iade dönüşü gidişle aynı fiyat", () => {
    expect(iadeKargoTahmini("hepsiburada", 199.99, 1, EKIM, { kargoyaVermeGunu: 1 })?.fiyat).toBe(43.99);
    expect(iadeKargoTahmini("hepsiburada", 379.99, 1, EKIM, { kargoyaVermeGunu: 2 })?.fiyat).toBe(81.99);
  });
});

describe("kargo tarifesi — dönem ve yardımcılar", () => {
  it("tarife başlamadan önceki sipariş → null (eski kurallar)", () => {
    expect(kargoTahmini("hepsiburada", 300, 1, new Date("2026-08-20T10:00:00Z"), { kargoyaVermeGunu: 1 })).toBeNull();
    expect(kargoTahmini("trendyol", 300, 1, new Date("2026-07-20T10:00:00Z"))).toBeNull();
    expect(tarifeDonemiBul("trendyol", new Date("2026-07-31T00:30:00+03:00"))?.id).toBe("trendyol-2026-08");
  });

  it("Shopify ve bilinmeyen platform → null", () => {
    expect(kargoTahmini("shopify", 300, 1, EKIM)).toBeNull();
    expect(tarifeDonemiBul("manual", EKIM)).toBeNull();
  });

  it("desi en yakın tam sayıya, en az 1; 30 üstü son adımla uzar", () => {
    const liste = [10, 10, 10, 20, 30];
    expect(desiListesiFiyati(liste, 0.1)).toBe(10);
    expect(desiListesiFiyati(liste, 3.4)).toBe(20);
    expect(desiListesiFiyati(liste, 3.5)).toBe(30);
    expect(desiListesiFiyati(liste, 6)).toBe(50);
  });

  it("firma adları tanınır", () => {
    expect(kargoFirmasiKodu("Trendyol Express Marketplace")).toBe("tex");
    expect(kargoFirmasiKodu("hepsiJET")).toBe("hepsijet");
    expect(kargoFirmasiKodu("hepsiJET XL")).toBeNull();
    expect(kargoFirmasiKodu("Sürat Kargo Marketplace")).toBe("surat");
    expect(kargoFirmasiKodu("Yurtiçi Kargo")).toBe("yurtici");
    expect(kargoFirmasiKodu("")).toBeNull();
  });
});
