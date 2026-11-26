import { describe, expect, it } from "vitest";
import { n11IlaniOku, n11IlanEslestir, type N11Ilan } from "./n11-ilanlar";

const HAM = {
  n11ProductId: 817076614,
  stockCode: "M3D00XDD147BYZ",
  title: "Xbox Uyumlu Joystick Standı",
  status: "Active",
  saleStatus: "On_Sale",
  barcode: null,
  salePrice: 349.99,
  listPrice: 349.99,
  quantity: 1,
  vatRate: 20,
  commissionRate: 0,
  imageUrls: ["https://n11scdn.akamaized.net/a1/org/1.jpg"],
};

describe("n11 ilanı okuma", () => {
  it("gerçek satır: önekli kimlik, barkod yoksa stok kodu, %0 komisyon geçerli", () => {
    expect(n11IlaniOku(HAM)).toEqual({
      stockCode: "M3D00XDD147BYZ",
      externalId: "n11-817076614",
      barcode: "M3D00XDD147BYZ",
      name: "Xbox Uyumlu Joystick Standı",
      price: 349.99,
      listPrice: 349.99,
      stock: 1,
      commissionRate: 0,
      vatRate: 20,
      imageUrl: "https://n11scdn.akamaized.net/a1/org/1.jpg",
    });
  });

  it("satışta olmayan ya da stok kodu olmayan satır alınmaz", () => {
    expect(n11IlaniOku({ ...HAM, status: "CatalogRejected" })).toBeNull();
    expect(n11IlaniOku({ ...HAM, stockCode: " " })).toBeNull();
  });

  it("geçersiz fiyat 0 (yazılmaz), komisyon yüzdesi kesre çevrilir", () => {
    const i = n11IlaniOku({ ...HAM, salePrice: null, commissionRate: 12.5, vatRate: "abc" })!;
    expect(i.price).toBe(0);
    expect(i.commissionRate).toBe(0.125);
    expect(i.vatRate).toBeNull();
  });
});

describe("n11 ilan eşleştirme", () => {
  const ilan = (stockCode: string): N11Ilan => n11IlaniOku({ ...HAM, n11ProductId: stockCode, stockCode })!;

  it("ürün barkodu, SKU ve başka platform ilanının barkodu/stok kodu ile eşleşir (büyük-küçük harf/boşluk farkı yok sayılır)", () => {
    const r = n11IlanEslestir(
      [ilan("M3DCVLMLT"), ilan("m3dabc"), ilan("TYBARKOD1"), ilan("HB-SKU")],
      [{ id: "u1", barcode: "M3DCVLMLT", sku: null }, { id: "u2", barcode: null, sku: "M3DABC" }],
      [
        { productId: "u3", barcode: "TYBARKOD1", externalSku: null },
        { productId: "u4", barcode: null, externalSku: "HB-SKU" },
      ]
    );
    expect(r.map((x) => x.productId)).toEqual(["u1", "u2", "u3", "u4"]);
  });

  it("aynı anahtar iki ürüne düşerse belirsiz → havuza (null)", () => {
    const r = n11IlanEslestir(
      [ilan("ORTAK")],
      [{ id: "u1", barcode: "ORTAK", sku: null }],
      [{ productId: "u2", barcode: "ORTAK", externalSku: null }]
    );
    expect(r[0].productId).toBeNull();
  });

  it("aynı ürünün birden çok anahtarı belirsizlik sayılmaz", () => {
    const r = n11IlanEslestir(
      [ilan("K1")],
      [{ id: "u1", barcode: "K1", sku: "K1" }],
      [{ productId: "u1", barcode: "K1", externalSku: "K1" }]
    );
    expect(r[0].productId).toBe("u1");
  });
});
