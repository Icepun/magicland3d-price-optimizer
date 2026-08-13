import { describe, expect, it } from "vitest";
import { pickProfitLists } from "./finance-product-profitability";

const urun = (
  id: string,
  netProfit: number | null,
  hasCost = true,
  profitMargin: number | null = 0.2
) => ({
  id,
  name: `Ürün ${id}`,
  imageUrl: null,
  netProfit,
  profitMargin,
  hasCost,
});

describe("pickProfitLists", () => {
  it("en kârlıları çoktan aza sıralar", () => {
    const list = pickProfitLists([urun("a", 12), urun("b", 40), urun("c", 25)]);
    expect(list.leaders.map((row) => row.id)).toEqual(["b", "c", "a"]);
  });

  it("zarar edenleri en çok zarardan başlayarak ayrı listeler", () => {
    const list = pickProfitLists([urun("a", -3), urun("b", 40), urun("c", -18)]);
    expect(list.losers.map((row) => row.id)).toEqual(["c", "a"]);
    // Zarar eden ürün "en kârlı" listesinin de sonunda durur (Ürünler ekranıyla aynı davranış).
    expect(list.leaders.map((row) => row.id)).toEqual(["b", "a", "c"]);
  });

  it("sıfır kâr zarar SAYILMAZ", () => {
    expect(pickProfitLists([urun("a", 0)]).losers).toEqual([]);
  });

  it("BİLİNMEYEN ≠ SIFIR: maliyeti girilmemiş ürün listeye girmez, sayılır", () => {
    const list = pickProfitLists([
      urun("a", 40),
      urun("b", null, false, null),
      urun("c", null, false, null),
    ]);
    expect(list.leaders.map((row) => row.id)).toEqual(["a"]);
    expect(list.losers).toEqual([]);
    expect(list.missingCostProducts).toBe(2);
    expect(list.countedProducts).toBe(1);
  });

  it("maliyeti girilmiş ama kârı hesaplanamamış ürün de listeye girmez", () => {
    const list = pickProfitLists([urun("a", null, true, null), urun("b", 5)]);
    expect(list.leaders.map((row) => row.id)).toEqual(["b"]);
    expect(list.missingCostProducts).toBe(0);
    expect(list.countedProducts).toBe(1);
  });

  it("liste ekrana sığacak kadar kısadır", () => {
    const many = Array.from({ length: 20 }, (_, index) => urun(`p${index}`, index + 1));
    const list = pickProfitLists(many);
    expect(list.leaders).toHaveLength(6);
    expect(list.countedProducts).toBe(20);
  });

  it("boş katalogda çökmez", () => {
    expect(pickProfitLists([])).toEqual({
      leaders: [],
      losers: [],
      missingCostProducts: 0,
      countedProducts: 0,
    });
  });

  it("gövde YALIN döner — ekranın kullanmadığı alan taşınmaz", () => {
    const list = pickProfitLists([urun("a", 40)]);
    expect(Object.keys(list.leaders[0]).sort()).toEqual([
      "id",
      "imageUrl",
      "name",
      "netProfit",
      "profitMargin",
    ]);
  });
});
