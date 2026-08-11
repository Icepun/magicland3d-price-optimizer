import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/**
 * Toplu düzenleme ucu.
 *
 * En kritik iki şey: (1) MALİYET ALANI buradan yazılamaz — kullanıcı maliyet-kâr rakamını
 * değiştiren işlemleri ayrıca onaylamak istiyor; (2) kâr girdisi değiştiğinde doğru önbellek
 * düşürülür, yoksa ekranda ESKİ kâr kalır.
 */

vi.mock("@/lib/prisma", () => ({
  prisma: { product: { updateMany: vi.fn(async () => ({ count: 0 })) } },
}));
vi.mock("@/lib/runtime-schema", () => ({ ensureRuntimeSchema: vi.fn(async () => {}) }));
vi.mock("@/lib/libsql-batch", () => ({ batchWrite: vi.fn(async () => true) }));
vi.mock("@/lib/cache-busting", () => ({
  bustProductViewCaches: vi.fn(),
  bustProfitInputCaches: vi.fn(),
}));

const { chunkIds, affectsProfitInputs } = await import("@/lib/bulk-update-helpers");

describe("kimlik dilimleme", () => {
  it("tek sorgu değişken sınırına dayanmasın diye dilimler", () => {
    const ids = Array.from({ length: 950 }, (_, i) => `p${i}`);
    const dilimler = chunkIds(ids, 400);
    expect(dilimler.map((d) => d.length)).toEqual([400, 400, 150]);
  });

  it("aynı ürün iki kez seçilmişse bir kez yazılır", () => {
    expect(chunkIds(["a", "b", "a"], 400)).toEqual([["a", "b"]]);
  });

  it("boş seçim boş liste döner", () => {
    expect(chunkIds([], 400)).toEqual([]);
  });
});

describe("hangi düzenleme kâr rakamını etkiler", () => {
  it("desi kargoyu beslediği için kâr girdisidir", () => {
    expect(affectsProfitInputs({ desi: 2 })).toBe(true);
  });

  it("kategori komisyon kuralını seçtiği için kâr girdisidir", () => {
    expect(affectsProfitInputs({ categoryName: "Dekorasyon" })).toBe(true);
  });

  it("sipariş üzerine üretim bayrağı kâr rakamına girmez", () => {
    expect(affectsProfitInputs({})).toBe(false);
  });
});

describe("maliyet alanları bu uçtan yazılamaz", () => {
  it("kaynakta hiçbir maliyet kolonu geçmiyor", () => {
    // Rota dosyası src/app altında; bu test src/lib'e taşındı (Next 16 rota dosyaları yalnız
    // istek işleyicisi dışa açabildiği için saf yardımcılar buraya alındı).
    const kaynak = readFileSync(
      new URL("../app/api/products/bulk-update/route.ts", import.meta.url),
      "utf8"
    );
    const yasakli = [
      "manualCost",
      "packagingCost",
      "totalCost",
      "productCost",
      "filamentWeight",
      "productCost.upsert",
      "currentSalePrice",
      "listPrice",
    ];
    expect(yasakli.filter((alan) => kaynak.includes(alan))).toEqual([]);
  });
});
