/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Siparişler ucu — ÜRÜN EŞLEŞTİRME + kalem geçmişi testleri.
 *
 * Amaç: bir sipariş satırı ya DOĞRU ürüne bağlansın ya da hiç bağlanmasın. Eskiden karşılaştırma
 * ham metindi (sondaki boşluk/harf düzeni eşleşmeyi sessizce bozuyordu) ve aynı anahtar iki üründe
 * varsa ilk gelen kazanıyordu → satır yanlış ürünün maliyetiyle hesaplanıyordu.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  state: {
    products: [] as any[],
    manualOrders: [] as any[],
    trendyolOrders: [] as any[],
    trendyolCall: 0,
    persistedOrders: [] as any[],
    persistedItems: null as Map<string, any[]> | null,
  },
}));

vi.mock("@/lib/runtime-schema", () => ({ ensureRuntimeSchema: vi.fn(async () => {}) }));
vi.mock("@/lib/route-cache", () => ({
  swr: (_key: string, _ms: number, fn: () => any) => fn(),
}));
vi.mock("@/lib/orders-cache", () => ({
  getOrdersCache: () => null,
  getOrdersCacheGeneration: () => 0,
  setOrdersCache: () => {},
  isOrdersRefreshing: () => false,
  setOrdersRefreshing: () => {},
}));
vi.mock("@/lib/push-notify", () => ({ pushToAllDevices: vi.fn(async () => {}) }));
vi.mock("@/lib/order-finance-snapshots", () => ({
  persistOrderFinanceSnapshots: vi.fn(async (orders: any[], items?: Map<string, any[]>) => {
    h.state.persistedOrders = orders;
    h.state.persistedItems = items ?? null;
  }),
}));
vi.mock("@/lib/manual-orders", () => ({
  parseManualOrderItems: () => ({
    items: [{ name: "Elde Satış", quantity: 1, imageUrl: null, productId: null }],
  }),
  parseManualOrderBreakdown: () => ({
    breakdown: { commissionCost: 0, missingCostItems: 0 },
  }),
}));
vi.mock("@/lib/prisma", () => {
  const empty = () => ({ findMany: vi.fn(async () => [] as any[]) });
  return {
    prisma: {
      product: { findMany: vi.fn(async () => h.state.products) },
      commissionRule: empty(),
      cargoRule: empty(),
      expenseRule: empty(),
      appSetting: empty(),
      platformOrderFinancial: empty(),
      notification: empty(),
      orderFinanceSnapshot: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      $executeRawUnsafe: vi.fn(async () => 0),
    },
    remotePrisma: { manualOrder: { findMany: vi.fn(async () => h.state.manualOrders) } },
  };
});
vi.mock("@/services/shopify-settings", () => ({ getShopifyCredentials: vi.fn(async () => ({})) }));
vi.mock("@/services/shopify-client", () => ({
  ShopifyAdminTokenMissingError: class ShopifyAdminTokenMissingError extends Error {},
  ShopifyClient: class {
    async listOrders() {
      return [];
    }
  },
}));
vi.mock("@/services/trendyol-settings", () => ({ getTrendyolCredentials: vi.fn(async () => ({})) }));
vi.mock("@/services/trendyol-client", () => ({
  TrendyolClient: class {
    async listOrders() {
      return { content: h.state.trendyolCall++ === 0 ? h.state.trendyolOrders : [] };
    }
  },
}));
vi.mock("@/services/hepsiburada-settings", () => ({
  getHepsiburadaCredentials: vi.fn(async () => ({})),
}));
vi.mock("@/services/hepsiburada-client", () => ({
  HepsiburadaClient: class {
    async listOrders() {
      return { items: [] };
    }
    async listPackages() {
      return { items: [] };
    }
    async getOrderDetail() {
      throw new Error("yok");
    }
  },
}));

const { GET } = await import("./route");

function product(over: Record<string, any>): any {
  return {
    id: "p",
    name: "Ürün",
    barcode: "",
    sku: "",
    imageUrl: null,
    categoryName: "Genel",
    desi: 1,
    commissionRate: null,
    madeToOrder: false,
    stock: 5,
    cost: null,
    listings: [],
    ...over,
  };
}

/** Tek kalemli Trendyol siparişi (eşleştirme anahtarı satırdan gelir). */
function trendyolOrder(line: Record<string, any>): any {
  return {
    id: 1,
    orderNumber: "TY-1",
    status: "Delivered",
    orderDate: Date.now(),
    totalPrice: 200,
    lines: [{ productName: "Sipariş Kalemi", quantity: 2, price: 100, ...line }],
  };
}

async function fetchOrders(): Promise<any> {
  const res = await GET(
    new Request("http://localhost/api/orders?fresh=1") as NextRequest
  );
  return res.json();
}

beforeEach(() => {
  h.state.products = [];
  h.state.manualOrders = [];
  h.state.trendyolOrders = [];
  h.state.trendyolCall = 0;
  h.state.persistedOrders = [];
  h.state.persistedItems = null;
});

describe("sipariş satırı ↔ ürün eşleştirmesi", () => {
  it("sondaki boşluk ve harf düzeni farkı eşleşmeyi bozmaz", async () => {
    h.state.products = [product({ id: "p-trim", barcode: "abc-1 " })];
    h.state.trendyolOrders = [trendyolOrder({ barcode: "ABC-1" })];

    const body = await fetchOrders();

    expect(body.orders[0].items[0].productId).toBe("p-trim");
  });

  it("Türkçe I farkı olan barkodu aynı ürün sayar", async () => {
    h.state.products = [product({ id: "p-turkce", barcode: "ışık-01" })];
    h.state.trendyolOrders = [trendyolOrder({ barcode: "IŞIK-01" })];

    const body = await fetchOrders();

    expect(body.orders[0].items[0].productId).toBe("p-turkce");
  });

  it("aynı barkod iki üründeyse satır HİÇBİRİNE bağlanmaz", async () => {
    h.state.products = [
      product({ id: "p-bir", barcode: "DUP-1" }),
      product({ id: "p-iki", barcode: "dup-1" }),
    ];
    h.state.trendyolOrders = [trendyolOrder({ barcode: "DUP-1" })];

    const body = await fetchOrders();

    expect(body.orders[0].items[0].productId).toBeNull();
    expect(body.orders[0].items[0].costMissing).toBe(true);
  });

  it("barkod eşleşmesi stok kodu eşleşmesine göre önceliklidir", async () => {
    h.state.products = [
      product({ id: "p-barkod", barcode: "K1" }),
      product({ id: "p-stokkodu", barcode: "B2", sku: "K1" }),
    ];
    h.state.trendyolOrders = [trendyolOrder({ barcode: "K1" })];

    const body = await fetchOrders();

    expect(body.orders[0].items[0].productId).toBe("p-barkod");
  });

  it("ilan barkodu ürün barkodundan farklı olsa da eşleşir", async () => {
    h.state.products = [
      product({
        id: "p-ilan",
        barcode: "SHOPIFY-BARKOD",
        listings: [{ platform: "trendyol", barcode: "TY-BARKOD", externalId: null, externalSku: null, commissionRate: null, commissionFixed: null, cargoCost: null }],
      }),
    ];
    h.state.trendyolOrders = [trendyolOrder({ barcode: "ty-barkod" })];

    const body = await fetchOrders();

    expect(body.orders[0].items[0].productId).toBe("p-ilan");
  });
});

describe("ürün bazlı satış geçmişi", () => {
  it("kalemleri ürün kimliği ve adet fiyatıyla kalıcı kayda gönderir", async () => {
    h.state.products = [product({ id: "p-kayit", name: "Kedi Figürü", barcode: "KF-1" })];
    h.state.trendyolOrders = [trendyolOrder({ barcode: "KF-1" })];

    await fetchOrders();

    const items = h.state.persistedItems?.get("ty-1");
    expect(items).toHaveLength(1);
    expect(items?.[0]).toMatchObject({
      productId: "p-kayit",
      productName: "Kedi Figürü",
      quantity: 2,
      unitPrice: 100,
    });
  });
});

describe("manuel sipariş durumu", () => {
  it("tanınmayan durumu 'Diğer' gösterir ve ciroda tutar", async () => {
    h.state.manualOrders = [
      {
        id: "m1",
        orderNumber: "M-1",
        orderedAt: new Date(),
        statusKind: "beklemede-degil",
        customerName: "Müşteri",
        currency: "TRY",
        revenueKurus: 15_000,
        profitKurus: 5_000,
        profitPartial: false,
        itemsJson: "{}",
        breakdownJson: "{}",
      },
    ];

    const body = await fetchOrders();

    const manual = body.orders.find((o: any) => o.id === "m1");
    expect(manual.statusLabel).toBe("Diğer");
    expect(manual.statusKind).toBe("other");
    expect(body.summary.manual).toMatchObject({ revenue: 150, orderCount: 1 });
  });

  it("bilinen durumu kendi etiketiyle gösterir", async () => {
    h.state.manualOrders = [
      {
        id: "m2",
        orderNumber: "M-2",
        orderedAt: new Date(),
        statusKind: "shipped",
        customerName: null,
        currency: "TRY",
        revenueKurus: 10_000,
        profitKurus: 2_000,
        profitPartial: false,
        itemsJson: "{}",
        breakdownJson: "{}",
      },
    ];

    const body = await fetchOrders();

    expect(body.orders.find((o: any) => o.id === "m2").statusLabel).toBe("Gönderildi");
  });
});

describe("yanıt damgası", () => {
  it("hesaplama zamanını taşır", async () => {
    const body = await fetchOrders();
    expect(typeof body.computedAt).toBe("string");
    expect(Number.isFinite(new Date(body.computedAt).getTime())).toBe(true);
  });
});
