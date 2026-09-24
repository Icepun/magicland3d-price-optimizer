/**
 * SİPARİŞ KALEMİ → ÜRÜN EŞLEŞTİRMESİ — masaüstü ve telefon AYNI kural.
 *
 * Korunanlar: güven sırası (ürün barkodu > ilan barkodu > platform kimliği > stok kodu > türsüz),
 * belirsiz anahtarın (birden çok ürüne düşen) hiç kullanılmaması, anahtar biçim birliği (boşluk,
 * büyük-küçük, Türkçe I) ve Shopify'da son çare ad eşleşmesi.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { anahtarListesi, normalizeMatchKey, satiriEsle, urunIndeksiKur, type EslesenUrun } from "./order-match";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const urun = (id: string, o: Partial<EslesenUrun> = {}): EslesenUrun => ({
  id,
  name: o.name ?? id,
  barcode: o.barcode ?? null,
  sku: o.sku ?? null,
  listings: o.listings ?? [],
});
const satir = (o: Partial<{ name: string; barcodes: string[]; externalIds: string[]; skus: string[] }>) => ({
  name: o.name ?? "",
  barcodes: o.barcodes ?? [],
  externalIds: o.externalIds ?? [],
  skus: o.skus ?? [],
});
const kur = (urunler: EslesenUrun[]) => urunIndeksiKur(urunler, (p) => p.id);

describe("anahtar biçimi", () => {
  it("boşluk, büyük-küçük harf ve dört I biçimi tek biçime iner", () => {
    // Yalnız I ailesi katlanır (Ş, Ğ… büyük harfe çevrilir, katlanmaz).
    expect(normalizeMatchKey("  ışık  lamba ")).toBe("IŞIK LAMBA");
    expect(normalizeMatchKey("IŞIK LAMBA")).toBe("IŞIK LAMBA");
    expect(normalizeMatchKey("Işık")).toBe(normalizeMatchKey("ışık"));
    expect(normalizeMatchKey("İstanbul")).toBe(normalizeMatchKey("istanbul"));
    expect(normalizeMatchKey(null)).toBe("");
  });

  it("anahtar listesi yalnız dolu metinleri alır", () => {
    expect(anahtarListesi("a", "", "  ", null, 5, "b")).toEqual(["a", "b"]);
  });
});

describe("güven sırası", () => {
  it("ürün barkodu, başka ürünün stok koduyla aynı olsa bile barkod kazanır", () => {
    const ix = kur([urun("A", { barcode: "X1" }), urun("B", { sku: "X1" })]);
    // Satır X1'i hem barkod hem stok kodu olarak taşıyor: barkod önce denenir.
    expect(satiriEsle(ix, satir({ barcodes: ["X1"], skus: ["X1"] }), "trendyol")).toBe("A");
  });

  it("ilan barkodu, ilan kimliği ve stok kodu sırayla denenir", () => {
    const ix = kur([
      urun("A", { listings: [{ barcode: "TYB", externalId: null, externalSku: null }] }),
      urun("B", { listings: [{ barcode: null, externalId: "HB-1", externalSku: null }] }),
      urun("C", { listings: [{ barcode: null, externalId: null, externalSku: "SK-9" }] }),
    ]);
    expect(satiriEsle(ix, satir({ barcodes: ["TYB"] }), "trendyol")).toBe("A");
    expect(satiriEsle(ix, satir({ externalIds: ["HB-1"] }), "hepsiburada")).toBe("B");
    expect(satiriEsle(ix, satir({ skus: ["SK-9"] }), "hepsiburada")).toBe("C");
  });

  it("tür karışmışsa son çare türsüz indeks (platform barkodu stok kodu alanında gelmiş)", () => {
    const ix = kur([urun("A", { barcode: "869000111" })]);
    expect(satiriEsle(ix, satir({ skus: ["869000111"] }), "hepsiburada")).toBe("A");
  });
});

describe("belirsiz anahtar kullanılmaz", () => {
  it("iki ayrı ürüne düşen barkod hiç eşleştirmez (yanlış maliyet yerine eşleşmesiz)", () => {
    const ix = kur([urun("A", { barcode: "ORTAK" }), urun("B", { barcode: "ORTAK" })]);
    expect(satiriEsle(ix, satir({ barcodes: ["ORTAK"] }), "trendyol")).toBeNull();
  });

  it("aynı ürünün aynı anahtarı iki yerde vermesi belirsizlik SAYILMAZ", () => {
    const ix = kur([urun("A", { barcode: "B1", listings: [{ barcode: "B1", externalId: null, externalSku: null }] })]);
    expect(satiriEsle(ix, satir({ barcodes: ["B1"] }), "trendyol")).toBe("A");
  });

  it("belirsiz ilk aday atlanır, sıradaki kesin aday kullanılır", () => {
    const ix = kur([
      urun("A", { barcode: "ORTAK" }),
      urun("B", { barcode: "ORTAK", sku: "KESIN" }),
    ]);
    expect(satiriEsle(ix, satir({ barcodes: ["ORTAK"], skus: ["KESIN"] }), "trendyol")).toBe("B");
  });
});

describe("Shopify ad eşleşmesi", () => {
  it("yalnız Shopify'da ve yalnız ad tekse", () => {
    const ix = kur([urun("A", { name: "Işıklı Vazo" }), urun("B", { name: "Kupa" }), urun("C", { name: "Kupa" })]);
    expect(satiriEsle(ix, satir({ name: "ışıklı  vazo" }), "shopify")).toBe("A");
    expect(satiriEsle(ix, satir({ name: "Işıklı Vazo" }), "trendyol")).toBeNull();
    expect(satiriEsle(ix, satir({ name: "Kupa" }), "shopify")).toBeNull(); // iki ürün aynı ad
  });

  it("ad, türsüz indekse KARIŞMAZ (başka ürünün stok koduyla çakışmasın)", () => {
    const ix = kur([urun("A", { name: "RED" }), urun("B", { sku: "RED" })]);
    expect(satiriEsle(ix, satir({ skus: ["RED"] }), "hepsiburada")).toBe("B");
  });
});

describe("iki uç aynı fonksiyonu kullanır", () => {
  it("masaüstü Siparişler ucu çekirdeği kullanıyor, kendi kovalarını kurmuyor", () => {
    const rota = fs.readFileSync(path.join(ROOT, "src/app/api/orders/route.ts"), "utf8");
    expect(rota).toContain("urunIndeksiKur(products,");
    expect(rota).toContain("satiriEsle(urunIndeksi, line, platform)");
    expect(rota).not.toContain("makeBucket");
  });

  it("telefon da çekirdeği kullanıyor", () => {
    const tel = fs.readFileSync(path.join(ROOT, "mobile/src/lib/order-profit.ts"), "utf8");
    expect(tel).toContain('from "@core/order-match"');
    expect(tel).toContain("satiriEsle(");
    expect(tel).not.toMatch(/byKey\.set\(/);
  });
});
