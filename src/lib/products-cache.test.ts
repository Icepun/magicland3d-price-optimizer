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

/**
 * BAYATLIK KORUNUR (Ürünler denetimi, 23 Kas 2026): `setQueryData` sorguyu taze işaretliyordu;
 * liste `staleTime: Infinity` olduğu için tek tazelik işareti silinince geçersiz kılınmış sekme
 * bir daha çekilmiyordu. Değişmeyen önbelleğe de hiç dokunulmamalı (stok tazeleme döngüsü).
 */
describe("yamalaBayatligiKoru / urunListesiniYamala", () => {
  it("bayat işaretli liste yamadan sonra da bayat kalır", async () => {
    const { urunListesiniYamala } = await import("./products-cache");
    const qc = istemci();
    qc.setQueryData(["products", "inactive"], [{ id: "a", stock: 5 }]);
    await qc.invalidateQueries({ queryKey: ["products", "inactive"], refetchType: "none" });
    expect(qc.getQueryState(["products", "inactive"])?.isInvalidated).toBe(true);

    urunListesiniYamala<{ id: string; stock: number }>(qc, (eski) => eski.map((p) => (p.id === "a" ? { ...p, stock: 9 } : p)));

    expect(qc.getQueryData<Array<{ stock: number }>>(["products", "inactive"])?.[0]?.stock).toBe(9);
    expect(qc.getQueryState(["products", "inactive"])?.isInvalidated).toBe(true);
    // Bayat olmayan liste taze kalır.
    expect(qc.getQueryState(["products", "active"])?.isInvalidated).toBe(false);
  });

  it("değişmeyen önbelleğe dokunulmaz (veri zamanı ve bayat işareti yerinde)", async () => {
    const { urunListesiniYamala, patchStocksInCache: yamala } = await import("./products-cache");
    const qc = istemci();
    await qc.invalidateQueries({ queryKey: ["products", "active"], refetchType: "none" });
    const once = qc.getQueryState(["products", "active"])!.dataUpdatedAt;
    const onceVeri = qc.getQueryData(["products", "active"]);

    urunListesiniYamala<{ id: string; stock: number }>(qc, (eski) => eski.map((p) => p));
    yamala(qc, [{ id: "a", stock: 5 }]); // aynı stok

    expect(qc.getQueryData(["products", "active"])).toBe(onceVeri);
    expect(qc.getQueryState(["products", "active"])!.dataUpdatedAt).toBe(once);
    expect(qc.getQueryState(["products", "active"])!.isInvalidated).toBe(true);
  });
});

describe("urunListesiGetir", () => {
  it("gövdenin hesaplandığı anı kaydeder; bayat gövdede bir kez yeniden çeker", async () => {
    const { urunListesiGetir, listeZamani } = await import("./products-cache");
    const qc = new QueryClient();
    const gercekFetch = globalThis.fetch;
    let sayac = 0;
    globalThis.fetch = (async () => {
      sayac += 1;
      return new Response(JSON.stringify([{ id: "a", stock: 1 }]), {
        status: 200,
        headers: { "x-liste-zamani": "1700000000000", "x-liste-bayat": "1" },
      });
    }) as typeof fetch;
    const zamanlayicilar: Array<() => void> = [];
    const gercekSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => {
      zamanlayicilar.push(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    try {
      const anahtar = ["products", "active", "test"];
      const veri = await urunListesiGetir<Array<{ id: string }>>(qc, anahtar, "/api/products?filter=active");
      expect(veri).toEqual([{ id: "a", stock: 1 }]);
      expect(listeZamani(anahtar)).toBe(1_700_000_000_000);
      expect(zamanlayicilar).toHaveLength(1); // ~20 sn sonra tek yeniden çekim
      // İkinci bayat yanıt 5 dk içinde yeni bir zamanlayıcı kurmaz (döngü yok).
      await urunListesiGetir(qc, anahtar, "/api/products?filter=active");
      expect(zamanlayicilar).toHaveLength(1);
      expect(sayac).toBe(2);
    } finally {
      globalThis.fetch = gercekFetch;
      globalThis.setTimeout = gercekSetTimeout;
    }
  });

  it("hata gövdesini okunur bir hataya çevirir", async () => {
    const { urunListesiGetir } = await import("./products-cache");
    const gercekFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Veritabanı meşgul" }), { status: 500 })) as typeof fetch;
    try {
      await expect(urunListesiGetir(new QueryClient(), ["products", "x"], "/api/products")).rejects.toThrow("Veritabanı meşgul");
    } finally {
      globalThis.fetch = gercekFetch;
    }
  });
});
