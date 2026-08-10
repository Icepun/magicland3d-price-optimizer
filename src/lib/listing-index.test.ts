import { describe, expect, it } from "vitest";
import { matchByPriority, uniqueIndex } from "./listing-index";

interface Fetched {
  barcode: string;
  sku: string;
  trendyolId: string;
  price: number;
}

const item = (over: Partial<Fetched>): Fetched => ({
  barcode: "TY-001",
  sku: "STOK-1",
  trendyolId: "111",
  price: 100,
  ...over,
});

describe("uniqueIndex", () => {
  it("anahtara göre indeksler, baştaki/sondaki boşluğu yok sayar", () => {
    const index = uniqueIndex([item({ barcode: " TY-001 " })], (f) => f.barcode);
    expect(index.get("TY-001")?.price).toBe(100);
  });

  it("boş/null anahtarları atlar", () => {
    const index = uniqueIndex(
      [item({ trendyolId: "" }), item({ barcode: "TY-002", trendyolId: "222" })],
      (f) => f.trendyolId
    );
    expect(index.size).toBe(1);
    expect(index.get("222")?.barcode).toBe("TY-002");
  });

  /**
   * Trendyol'da stok kodu boşsa mapProduct `productMainId`'ye düşüyor ve o değer bir ürünün TÜM
   * varyantlarında AYNI. Kör eşleştirme yanlış varyantın fiyatını yazardı — belirsiz anahtar
   * kullanılmamalı.
   */
  it("aynı anahtara birden çok kayıt düşerse o anahtarı hiç kullanmaz", () => {
    const index = uniqueIndex(
      [
        item({ barcode: "TY-KIRMIZI", sku: "GRUP-9", price: 100 }),
        item({ barcode: "TY-MAVI", sku: "GRUP-9", price: 250 }),
        item({ barcode: "TY-TEK", sku: "GRUP-1", price: 400 }),
      ],
      (f) => f.sku
    );
    expect(index.has("GRUP-9")).toBe(false); // belirsiz → yok
    expect(index.get("GRUP-1")?.price).toBe(400); // tekil → var
  });
});

describe("matchByPriority", () => {
  const kirmizi = item({ barcode: "TY-KIRMIZI", trendyolId: "111", price: 100 });
  const mavi = item({ barcode: "TY-MAVI", trendyolId: "222", price: 250 });
  const byBarcode = uniqueIndex([kirmizi, mavi], (f) => f.barcode);
  const byExternalId = uniqueIndex([kirmizi, mavi], (f) => f.trendyolId);

  it("sırayla dener ve ilk tutanı döndürür", () => {
    const hit = matchByPriority<Fetched>([
      ["222", byExternalId],
      ["TY-KIRMIZI", byBarcode],
    ]);
    expect(hit?.barcode).toBe("TY-MAVI"); // platform kimliği önce gelir
  });

  it("boş anahtarlı adayları atlayıp sonrakine geçer", () => {
    const hit = matchByPriority<Fetched>([
      [null, byExternalId],
      ["", byExternalId],
      ["   ", byExternalId],
      ["TY-KIRMIZI", byBarcode],
    ]);
    expect(hit?.price).toBe(100);
  });

  it("hiçbiri tutmazsa null döner", () => {
    expect(matchByPriority<Fetched>([["YOK", byBarcode]])).toBeNull();
  });

  /**
   * REGRESYON — asıl hata: elle eşleştirilmiş ilanda ürünün barkodu Shopify'ınki, ilanınki
   * Trendyol'unki. Yalnız ürün barkoduna bakan eski sorgu bu ilanı hiç bulamıyordu.
   */
  it("elle eşleştirilmiş ilanı ürün barkodu tutmasa da ilan barkoduyla bulur", () => {
    const row = {
      externalId: null,
      listingBarcode: "TY-MAVI",
      externalSku: null,
      productBarcode: "shopify-variant-88", // ürünün barkodu Trendyol'unkiyle AYNI DEĞİL
    };
    const hit = matchByPriority<Fetched>([
      [row.externalId, byExternalId],
      [row.listingBarcode, byBarcode],
      [row.productBarcode, byBarcode],
    ]);
    expect(hit?.price).toBe(250);
  });
});
