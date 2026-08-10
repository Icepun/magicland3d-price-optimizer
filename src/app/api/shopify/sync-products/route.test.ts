import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Shopify senkronunun YAZMA BİÇİMİ testleri.
 * Amaç: yazımların tek toplu istekte gitmesi (uzak DB'de her ifade ayrı gidince tüm uygulama
 * kilitleniyordu) ve "yalnız değişeni yaz" ilkesinin korunması.
 */

const listAllProducts = vi.fn();
const batchWrite = vi.fn();
const executeRawUnsafe = vi.fn();
const queryRawUnsafe = vi.fn();
const createMany = vi.fn();
const upsert = vi.fn();

vi.mock("@/lib/runtime-schema", () => ({ ensureRuntimeSchema: vi.fn(async () => {}) }));
vi.mock("@/lib/cache-busting", () => ({ bustProductCaches: vi.fn() }));
vi.mock("@/services/shopify-settings", () => ({
  getShopifyCredentials: vi.fn(async () => ({ shopDomain: "x.myshopify.com", storefrontAccessToken: "t" })),
}));
vi.mock("@/services/shopify-client", () => ({
  ShopifyClient: class {
    listAllProducts = listAllProducts;
  },
}));
vi.mock("@/lib/libsql-batch", () => ({ batchWrite: (s: unknown[]) => batchWrite(s) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRawUnsafe: (sql: string, ...args: unknown[]) => queryRawUnsafe(sql, ...args),
    $executeRawUnsafe: (sql: string, ...args: unknown[]) => executeRawUnsafe(sql, ...args),
    priceHistory: { createMany: (a: unknown) => createMany(a) },
    appSetting: { upsert: (a: unknown) => upsert(a) },
  },
}));

const { POST } = await import("./route");

type Variant = { id: number; price: string; sku?: string; barcode?: string; inventory_quantity?: number; title?: string };

function shopifyProduct(title: string, variants: Variant[]) {
  return { id: 1, title, product_type: "Oyuncak", status: "active", image: { src: "urun.jpg" }, variants };
}

function call(mode: string) {
  return POST({ json: async () => ({ mode }) } as never);
}

/** Toplu istek olarak gönderilen tüm ifadeleri düzleştir. */
function batchedStatements(): Array<{ sql: string; args: unknown[] }> {
  return batchWrite.mock.calls.flatMap((c) => c[0] as Array<{ sql: string; args: unknown[] }>);
}

beforeEach(() => {
  vi.clearAllMocks();
  batchWrite.mockResolvedValue(true);
  executeRawUnsafe.mockResolvedValue(0);
  queryRawUnsafe.mockResolvedValue([]);
  createMany.mockResolvedValue({ count: 0 });
  upsert.mockResolvedValue({});
});

describe("Shopify senkronu — yeni ürün ekleme", () => {
  it("üç yeni ürünü tek toplu istekte yazar, satır satır yazmaz", async () => {
    listAllProducts.mockResolvedValue([
      shopifyProduct("Kupa", [{ id: 11, price: "100", barcode: "B1", inventory_quantity: 5 }]),
      shopifyProduct("Vazo", [{ id: 22, price: "200", barcode: "B2", inventory_quantity: 0 }]),
      shopifyProduct("Saksı", [{ id: 33, price: "300", sku: "S3" }]),
    ]);

    const res = await call("add-new");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ added: 3 });

    // 3 ürün × (Product + Listing) = 6 ifade, hepsi TEK toplu istekte
    expect(batchWrite).toHaveBeenCalledTimes(1);
    expect(batchedStatements()).toHaveLength(6);
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("ürün ve ilan ifadeleri ardışık çift hâlinde toplanır", async () => {
    listAllProducts.mockResolvedValue([
      shopifyProduct("Kupa", [{ id: 11, price: "100", barcode: "B1" }]),
      shopifyProduct("Vazo", [{ id: 22, price: "200", barcode: "B2" }]),
    ]);

    await call("add-new");
    const stmts = batchedStatements();
    for (let i = 0; i < stmts.length; i += 2) {
      expect(stmts[i].sql).toContain("INSERT INTO Product");
      expect(stmts[i + 1].sql).toContain("INSERT INTO Listing");
      // İlan, hemen öncesindeki ürünün kimliğine bağlanır
      expect(stmts[i + 1].args[1]).toBe(stmts[i].args[0]);
    }
  });

  it("veritabanı toplu yazımı desteklemiyorsa sıralı yola düşer (veri kaybı olmaz)", async () => {
    batchWrite.mockResolvedValue(false);
    listAllProducts.mockResolvedValue([
      shopifyProduct("Kupa", [{ id: 11, price: "100", barcode: "B1" }]),
    ]);

    await call("add-new");
    expect(executeRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it("zaten var olan barkod için yazma üretmez", async () => {
    queryRawUnsafe.mockResolvedValue([{ barcode: "B1" }]);
    listAllProducts.mockResolvedValue([
      shopifyProduct("Kupa", [{ id: 11, price: "100", barcode: "B1" }]),
    ]);

    const res = await call("add-new");
    await expect(res.json()).resolves.toMatchObject({ added: 0 });
    expect(batchedStatements()).toHaveLength(0);
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe("Shopify senkronu — fiyat tazeleme", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    listingId: "l1",
    listingPrice: 100,
    productId: "p1",
    barcode: "B1",
    variantId: "11",
    sku: "S1",
    listingSku: "S1",
    listingBarcode: null,
    productPrice: 100,
    imageUrl: "urun.jpg",
    imageManual: 0,
    ...over,
  });

  it("fiyat değişmediyse hiç yazma üretmez (fiyat geçmişi de kirlenmez)", async () => {
    queryRawUnsafe.mockResolvedValue([row()]);
    listAllProducts.mockResolvedValue([
      shopifyProduct("Kupa", [{ id: 11, price: "100", barcode: "B1", sku: "S1" }]),
    ]);

    const res = await call("refresh-prices");
    await expect(res.json()).resolves.toMatchObject({ checked: 1, changed: 0, imagesFixed: 0 });
    expect(batchedStatements()).toHaveLength(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("yalnızca değişen satır için yazma ve fiyat geçmişi üretir", async () => {
    queryRawUnsafe.mockResolvedValue([
      row(),
      row({ listingId: "l2", productId: "p2", barcode: "B2", variantId: "22", sku: "S2", listingSku: "S2" }),
    ]);
    listAllProducts.mockResolvedValue([
      shopifyProduct("Kupa", [{ id: 11, price: "100", barcode: "B1", sku: "S1" }]),
      shopifyProduct("Vazo", [{ id: 22, price: "250", barcode: "B2", sku: "S2" }]),
    ]);

    const res = await call("refresh-prices");
    await expect(res.json()).resolves.toMatchObject({ checked: 2, changed: 1 });

    const stmts = batchedStatements();
    expect(stmts).toHaveLength(2); // ilan fiyatı + ürün fiyatı, yalnız p2 için
    expect(stmts.every((s) => s.args.includes("l2") || s.args.includes("p2"))).toBe(true);
    expect(createMany).toHaveBeenCalledWith({
      data: [{ productId: "p2", oldPrice: 100, newPrice: 250, changeSource: "shopify_sync" }],
    });
  });

  it("barkodu elle değiştirilmiş ürün varyant kimliğiyle eşleşir", async () => {
    queryRawUnsafe.mockResolvedValue([row({ barcode: "ELLE-DEGISTI", sku: "ELLE", listingSku: null })]);
    listAllProducts.mockResolvedValue([
      shopifyProduct("Kupa", [{ id: 11, price: "180", barcode: "B1", sku: "S1" }]),
    ]);

    const res = await call("refresh-prices");
    await expect(res.json()).resolves.toMatchObject({ changed: 1 });
  });

  it("aynı stok kodunu paylaşan varyantlarda kör eşleşme yapmaz", async () => {
    // Varyant kimliği tutmuyor; tek kalan aday SKU ve o SKU iki varyantta ortak → yazma YOK.
    queryRawUnsafe.mockResolvedValue([
      row({ variantId: null, barcode: "YOK", listingSku: "ORTAK", sku: "ORTAK" }),
    ]);
    listAllProducts.mockResolvedValue([
      shopifyProduct("Kupa", [
        { id: 11, price: "180", sku: "ORTAK", barcode: "B1" },
        { id: 12, price: "220", sku: "ORTAK", barcode: "B2" },
      ]),
    ]);

    const res = await call("refresh-prices");
    await expect(res.json()).resolves.toMatchObject({ changed: 0 });
    expect(batchedStatements()).toHaveLength(0);
  });

  it("elle seçilmiş görseli ezmez, otomatik görseli yalnız değişmişse yazar", async () => {
    queryRawUnsafe.mockResolvedValue([
      row({ imageManual: 1, imageUrl: "elle.jpg" }),
      row({ listingId: "l2", productId: "p2", barcode: "B2", variantId: "22", sku: "S2", listingSku: "S2", imageUrl: "eski.jpg" }),
    ]);
    listAllProducts.mockResolvedValue([
      shopifyProduct("Kupa", [{ id: 11, price: "100", barcode: "B1", sku: "S1" }]),
      shopifyProduct("Vazo", [{ id: 22, price: "100", barcode: "B2", sku: "S2" }]),
    ]);

    const res = await call("refresh-prices");
    await expect(res.json()).resolves.toMatchObject({ imagesFixed: 1, changed: 0 });
    const stmts = batchedStatements();
    expect(stmts).toHaveLength(1);
    expect(stmts[0].args).toEqual(["urun.jpg", "p2"]);
  });
});
