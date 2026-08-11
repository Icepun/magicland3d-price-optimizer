/**
 * Hızlı bildirim taraması — bildirim ADAYLARININ doğru doğduğunu sabitler.
 *
 * Bu tarama kâr hesabından tamamen ayrıdır; burada yalnız "hangi olay bildirilir, hangisi
 * bildirilmez" kuralları doğrulanır (yanlış ürüne bildirim atmamak dahil).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {}, remotePrisma: {} }));
vi.mock("@/lib/runtime-schema", () => ({ ensureRuntimeSchema: vi.fn(async () => {}) }));
vi.mock("@/lib/push-notify", () => ({ pushToAllDevices: vi.fn(async () => {}) }));

import {
  buildInventoryNotifications,
  buildOrderNotifications,
  inventoryNotificationIds,
  type ScanOrder,
  type ScanProduct,
  INVENTORY_TYPES,
} from "./order-watch";

const urun = (over: Partial<ScanProduct> & { id: string; name: string }): ScanProduct => ({
  stock: 5,
  madeToOrder: false,
  barcodes: [],
  externalIds: [],
  skus: [],
  ...over,
});

const siparis = (over: Partial<ScanOrder> & { id: string }): ScanOrder => ({
  platform: "trendyol",
  orderNumber: "1001",
  actionable: true,
  lines: [],
  ...over,
});

describe("buildOrderNotifications", () => {
  it("stoğu biten ürüne gelen aktif sipariş için acil bildirim üretir", () => {
    const rows = buildOrderNotifications(
      [
        siparis({
          id: "ty-1",
          lines: [{ name: "Ejderha", quantity: 2, barcodes: ["BRK-1"], externalIds: [], skus: [] }],
        }),
      ],
      [urun({ id: "p1", name: "Ejderha", stock: 0, barcodes: ["BRK-1"] })]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("order-stock:ty-1:p1");
    expect(rows[0].severity).toBe("critical");
    expect(rows[0].body).toContain("Trendyol #1001");
    expect(rows[0].body).toContain("×2");
  });

  it("sipariş üzerine üretilen ürün için uyarı üretir (stok bakılmaz)", () => {
    const rows = buildOrderNotifications(
      [
        siparis({
          id: "ty-2",
          lines: [{ name: "Lamba", quantity: 1, barcodes: ["BRK-2"], externalIds: [], skus: [] }],
        }),
      ],
      [urun({ id: "p2", name: "Lamba", stock: 0, madeToOrder: true, barcodes: ["BRK-2"] })]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("order-made");
    expect(rows[0].severity).toBe("warning");
  });

  it("aksiyon beklemeyen (kapanmış) sipariş için bildirim üretmez", () => {
    const rows = buildOrderNotifications(
      [
        siparis({
          id: "ty-3",
          actionable: false,
          lines: [{ name: "Ejderha", quantity: 1, barcodes: ["BRK-1"], externalIds: [], skus: [] }],
        }),
      ],
      [urun({ id: "p1", name: "Ejderha", stock: 0, barcodes: ["BRK-1"] })]
    );

    expect(rows).toEqual([]);
  });

  it("stoğu olan ve sipariş üzerine üretilmeyen ürün için bildirim üretmez", () => {
    const rows = buildOrderNotifications(
      [
        siparis({
          id: "ty-4",
          lines: [{ name: "Ejderha", quantity: 1, barcodes: ["BRK-1"], externalIds: [], skus: [] }],
        }),
      ],
      [urun({ id: "p1", name: "Ejderha", stock: 7, barcodes: ["BRK-1"] })]
    );

    expect(rows).toEqual([]);
  });

  it("aynı barkod iki ürüne düşerse hiç eşleştirmez (yanlış ürüne bildirim atmaz)", () => {
    const rows = buildOrderNotifications(
      [
        siparis({
          id: "ty-5",
          lines: [{ name: "Ejderha", quantity: 1, barcodes: ["ORTAK"], externalIds: [], skus: [] }],
        }),
      ],
      [
        urun({ id: "p1", name: "Ejderha", stock: 0, barcodes: ["ORTAK"] }),
        urun({ id: "p2", name: "Kartal", stock: 0, barcodes: ["ORTAK"] }),
      ]
    );

    expect(rows).toEqual([]);
  });

  it("boşluk ve harf düzeni farkına takılmaz", () => {
    const rows = buildOrderNotifications(
      [
        siparis({
          id: "ty-6",
          lines: [{ name: "x", quantity: 1, barcodes: [" brk-9 "], externalIds: [], skus: [] }],
        }),
      ],
      [urun({ id: "p9", name: "Işık", stock: 0, barcodes: ["BRK-9"] })]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("order-stock:ty-6:p9");
  });

  it("Shopify satırını son çare olarak ürün adından eşleştirir", () => {
    const rows = buildOrderNotifications(
      [
        siparis({
          platform: "shopify",
          id: "sh-1",
          orderNumber: "2001",
          lines: [{ name: "Gece Lambası", quantity: 1, barcodes: [], externalIds: [], skus: [] }],
        }),
      ],
      [urun({ id: "p3", name: "Gece Lambası", stock: 0 })]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain("Shopify #2001");
  });

  it("aynı ürün siparişte iki kez geçse de tek bildirim üretir", () => {
    const rows = buildOrderNotifications(
      [
        siparis({
          id: "ty-7",
          lines: [
            { name: "Ejderha", quantity: 1, barcodes: ["BRK-1"], externalIds: [], skus: [] },
            { name: "Ejderha", quantity: 1, barcodes: ["BRK-1"], externalIds: [], skus: [] },
          ],
        }),
      ],
      [urun({ id: "p1", name: "Ejderha", stock: 0, barcodes: ["BRK-1"] })]
    );

    expect(rows).toHaveLength(1);
  });
});

describe("buildInventoryNotifications", () => {
  const envanter = {
    lowStock: [
      { id: "p1", name: "Ejderha", stock: 0 },
      { id: "p2", name: "Kartal", stock: 1 },
    ],
    siteOutOfStock: [{ productId: "p3", name: "Lamba" }],
    spools: [
      { id: "s1", name: "Siyah PLA", remainingGrams: 0 },
      { id: "s2", name: "Beyaz PLA", remainingGrams: 120 },
    ],
    readTypes: INVENTORY_TYPES,
  };

  it("biten stok ve biten filamenti acil, azalanları uyarı olarak işaretler", () => {
    const rows = buildInventoryNotifications(envanter);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(byId["stock-p1"].severity).toBe("critical");
    expect(byId["stock-p2"].severity).toBe("warning");
    expect(byId["site-stock-p3"].severity).toBe("warning");
    expect(byId["spool-s1"].severity).toBe("critical");
    expect(byId["spool-s2"].severity).toBe("warning");
  });

  it("kimlikler zildeki anlık uyarı kimlikleriyle aynı kalıbı kullanır", () => {
    expect(inventoryNotificationIds(envanter)).toEqual([
      "stock-p1",
      "stock-p2",
      "site-stock-p3",
      "spool-s1",
      "spool-s2",
    ]);
  });

  it("eşik altında hiçbir şey yoksa bildirim üretmez", () => {
    expect(
      buildInventoryNotifications({ lowStock: [], siteOutOfStock: [], spools: [], readTypes: INVENTORY_TYPES })
    ).toEqual([]);
  });
});
