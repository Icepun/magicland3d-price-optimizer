import { describe, expect, it } from "vitest";
import { karEksikAdaylari } from "./finance-missing-costs";
import type { ProductSalesItem, ProductSalesOrder } from "./finance-product-sales";

const PENCERE = new Date("2026-09-01T00:00:00Z");
const tarih = new Date("2026-09-28T10:00:00Z");

const siparis = (
  id: string,
  over: Partial<ProductSalesOrder> = {}
): ProductSalesOrder => ({
  platform: "shopify",
  externalOrderId: id,
  orderedAt: tarih,
  revenueKurus: 50_000,
  profitKurus: 10_000,
  profitPartial: false,
  statusKind: "delivered",
  currency: "TRY",
  ...over,
});

const kalem = (
  siparisId: string,
  productId: string | null,
  productName: string,
  over: Partial<ProductSalesItem> = {}
): ProductSalesItem => ({
  platform: "shopify",
  externalOrderId: siparisId,
  orderedAt: tarih,
  productId,
  productName,
  quantity: 1,
  lineRevenueKurus: 25_000,
  statusKind: "delivered",
  ...over,
});

describe("karEksikAdaylari", () => {
  it("yalnız kârı EKSİK siparişlerin kalemleri aday olur", () => {
    const { urunler, adlar } = karEksikAdaylari({
      orders: [
        siparis("tam"),
        siparis("yok", { profitKurus: null }),
        siparis("kismi", { profitPartial: true }),
      ],
      items: [
        kalem("tam", "p-tam", "Tam ürün"),
        kalem("yok", "p-kalemlik", "F1 Kalemlik"),
        kalem("kismi", "p-kalemlik", "F1 Kalemlik"),
        kalem("kismi", "p-figur", "Hollow Knight Figür"),
        kalem("kismi", null, "Hediye Paketi"),
      ],
      rangeFrom: PENCERE,
    });
    expect([...urunler.keys()].sort()).toEqual(["p-figur", "p-kalemlik"]);
    expect(urunler.get("p-kalemlik")?.siparisler.size).toBe(2);
    expect([...adlar.entries()].map(([ad, s]) => [ad, s.size])).toEqual([["Hediye Paketi", 1]]);
  });

  it("iptal, TL dışı ve pencere öncesi siparişler sayılmaz (aylık toplamlarla aynı eleme)", () => {
    const { urunler } = karEksikAdaylari({
      orders: [
        siparis("iptal", { profitKurus: null, statusKind: "cancelled" }),
        siparis("usd", { profitKurus: null, currency: "USD" }),
        siparis("eski", { profitKurus: null, orderedAt: new Date("2026-08-01T00:00:00Z") }),
      ],
      items: [kalem("iptal", "p1", "A"), kalem("usd", "p2", "B"), kalem("eski", "p3", "C")],
      rangeFrom: PENCERE,
    });
    expect(urunler.size).toBe(0);
  });

  it("aynı ad farklı platformdaki siparişleri ayrı sayar; adı boş satır okunur ada düşer", () => {
    const { adlar } = karEksikAdaylari({
      orders: [
        siparis("1", { profitKurus: null }),
        siparis("1", { platform: "hepsiburada", profitKurus: null }),
      ],
      items: [
        kalem("1", null, "  "),
        kalem("1", null, "  ", { platform: "hepsiburada" }),
      ],
      rangeFrom: PENCERE,
    });
    expect(adlar.get("Adı okunamayan ürün")?.size).toBe(2);
  });
});
