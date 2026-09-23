/**
 * STOK YAMASI — "stok düşüp ürünler sayfasına geri gelince o ürün hâlâ güncellenmemiş" (23 Eyl 2026).
 *
 * Liste bilinçli olarak kendiliğinden yeniden çekilmiyor; telefonda değişen stok hafif bir uçtan
 * gelip önbelleklere YAMALANIYOR. Bu test yamanın her kopyaya ulaştığını ve kullanıcının az
 * önce değiştirdiği (henüz yazılmamış) stoğun uzaktan gelen eski değerle ezilmediğini sabitler.
 */
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { markStockWritePending, patchStocksInCache } from "./products-cache";

function istemci() {
  const qc = new QueryClient();
  qc.setQueryData(["products", "active"], [
    { id: "a", stock: 5 },
    { id: "b", stock: 2 },
  ]);
  qc.setQueryData(["product", "a"], { id: "a", stock: 5, variantGroup: null });
  qc.setQueryData(["product", "b"], {
    id: "b",
    stock: 2,
    variantGroup: { products: [{ id: "a", stock: 5 }, { id: "b", stock: 2 }] },
  });
  return qc;
}

describe("patchStocksInCache", () => {
  it("liste, ürün detayı ve varyant kardeşinin kopyası birlikte güncellenir", () => {
    const qc = istemci();
    patchStocksInCache(qc, [{ id: "a", stock: 4 }]);

    expect(qc.getQueryData<Array<{ id: string; stock: number }>>(["products", "active"])).toEqual([
      { id: "a", stock: 4 },
      { id: "b", stock: 2 },
    ]);
    expect(qc.getQueryData<{ stock: number }>(["product", "a"])?.stock).toBe(4);
    const b = qc.getQueryData<{ variantGroup: { products: Array<{ id: string; stock: number }> } }>(["product", "b"]);
    expect(b?.variantGroup.products.find((p) => p.id === "a")?.stock).toBe(4);
  });

  it("değişmeyen satırın nesnesi korunur (gereksiz yeniden çizim yok)", () => {
    const qc = istemci();
    const once = qc.getQueryData<Array<{ id: string }>>(["products", "active"])!;
    patchStocksInCache(qc, [{ id: "a", stock: 4 }]);
    const sonra = qc.getQueryData<Array<{ id: string }>>(["products", "active"])!;
    expect(sonra[1]).toBe(once[1]);
  });

  it("henüz yazılmamış kullanıcı değişikliği uzaktan gelen eski değerle EZİLMEZ", () => {
    const qc = istemci();
    patchStocksInCache(qc, [{ id: "a", stock: 3 }]); // kullanıcı -2'ye bastı (iyimser)
    markStockWritePending("a", true);
    patchStocksInCache(qc, [{ id: "a", stock: 5 }], { bekleyenleriAtla: true }); // sunucu henüz eski
    expect(qc.getQueryData<{ stock: number }>(["product", "a"])?.stock).toBe(3);
    markStockWritePending("a", false);
    patchStocksInCache(qc, [{ id: "a", stock: 3 }], { bekleyenleriAtla: true });
    expect(qc.getQueryData<{ stock: number }>(["product", "a"])?.stock).toBe(3);
  });
});
