/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Siparişler ucu — ÇEKİM BÜTÜNLÜĞÜ testleri.
 * Amaç: yarım kalan bir pazaryeri çekimi ya da tutarı alınamayan bir sipariş
 * ASLA "tam veri" gibi ciro/kâr özetine girmesin. Kâr hesabının kendisi
 * çekirdekte test ediliyor; burada yalnız veri bütünlüğü doğrulanır.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  state: {
    shopifyOrders: [] as any[],
    trendyolPages: [] as Array<any[] | Error>,
    trendyolCall: 0,
    hbOpenPages: [] as any[][],
    hbPackages: {} as Record<string, any[]>,
    hbDetails: {} as Record<string, any>,
    persisted: [] as any[],
    /** Manuel sipariş okuması bu mesajla patlar (null = sorunsuz). */
    manualError: null as string | null,
    sharedCalls: 0,
    /** Doluysa paylaşılan hesap gerçek hesabı çalıştırmadan bu gövdeyi döndürür. */
    sharedResult: null as any,
    /** Doluysa paylaşılan hesap bu mesajla patlar. */
    sharedError: null as string | null,
  },
}));

vi.mock("@/lib/runtime-schema", () => ({ ensureRuntimeSchema: vi.fn(async () => {}) }));
vi.mock("@/lib/route-cache", () => ({
  swr: (_key: string, _ms: number, fn: () => any) => fn(),
}));
vi.mock("@/lib/orders-cache", () => ({
  getOrdersCache: () => null,
  isOrdersRefreshing: () => false,
  setOrdersRefreshing: () => {},
  // Rota artık paylaşılan hesabı KENDİ kopyasıyla değil bu uçla çağırıyor (nesil koruması orada).
  computeOrdersShared: async (compute: () => Promise<any>) => {
    h.state.sharedCalls += 1;
    if (h.state.sharedError) throw new Error(h.state.sharedError);
    return h.state.sharedResult ?? compute();
  },
}));
vi.mock("@/lib/push-notify", () => ({ pushToAllDevices: vi.fn(async () => {}) }));
vi.mock("@/lib/order-finance-snapshots", () => ({
  // Yazım artık "ateşle ve unut" (yanıt yolunda değil) → senkron çağrı, Promise döndürmez.
  scheduleOrderFinanceSnapshots: vi.fn((orders: any[]) => {
    h.state.persisted = orders;
  }),
}));
vi.mock("@/lib/prisma", () => {
  const table = () => ({ findMany: vi.fn(async () => [] as any[]) });
  return {
    prisma: {
      product: table(),
      commissionRule: table(),
      cargoRule: table(),
      expenseRule: table(),
      appSetting: table(),
      platformOrderFinancial: table(),
      notification: table(),
      orderFinanceSnapshot: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      $executeRawUnsafe: vi.fn(async () => 0),
    },
    remotePrisma: {
      manualOrder: {
        findMany: vi.fn(async () => {
          if (h.state.manualError) throw new Error(h.state.manualError);
          return [] as any[];
        }),
      },
    },
  };
});
vi.mock("@/services/shopify-settings", () => ({ getShopifyCredentials: vi.fn(async () => ({})) }));
vi.mock("@/services/shopify-client", () => ({
  ShopifyAdminTokenMissingError: class ShopifyAdminTokenMissingError extends Error {},
  ShopifyClient: class {
    async listOrders() {
      return h.state.shopifyOrders;
    }
  },
}));
vi.mock("@/services/trendyol-settings", () => ({ getTrendyolCredentials: vi.fn(async () => ({})) }));
vi.mock("@/services/trendyol-client", () => ({
  // jsonError bu sınıfı tanımak için import ediyor (rota artık onunla sarmalı).
  TrendyolApiError: class TrendyolApiError extends Error {},
  TrendyolClient: class {
    async listOrders() {
      const next = h.state.trendyolPages[h.state.trendyolCall++];
      if (next instanceof Error) throw next;
      return { content: next ?? [] };
    }
  },
}));
vi.mock("@/services/hepsiburada-settings", () => ({
  getHepsiburadaCredentials: vi.fn(async () => ({})),
}));
vi.mock("@/services/hepsiburada-client", () => ({
  HepsiburadaClient: class {
    async listOrders(params: { offset?: number } = {}) {
      return { items: h.state.hbOpenPages[(params.offset ?? 0) / 100] ?? [] };
    }
    async listPackages(status: string, params: { offset?: number } = {}) {
      return { items: (params.offset ?? 0) === 0 ? h.state.hbPackages[status] ?? [] : [] };
    }
    async getOrderDetail(orderNumber: string) {
      const detail = h.state.hbDetails[orderNumber];
      if (!detail) throw new Error("detay alınamadı");
      return detail;
    }
  },
}));

const { GET } = await import("./route");

const now = () => new Date().toISOString();

async function fetchOrders(): Promise<any> {
  const res = await GET(
    new Request("http://localhost/api/orders?fresh=1") as NextRequest
  );
  return res.json();
}

beforeEach(() => {
  h.state.shopifyOrders = [];
  h.state.trendyolPages = [];
  h.state.trendyolCall = 0;
  h.state.hbOpenPages = [];
  h.state.hbPackages = {};
  h.state.hbDetails = {};
  h.state.persisted = [];
  h.state.manualError = null;
  h.state.sharedCalls = 0;
  h.state.sharedResult = null;
  h.state.sharedError = null;
});

const trendyolOrder = () => ({
  id: 1,
  orderNumber: "TY-1",
  status: "Delivered",
  orderDate: Date.now(),
  totalPrice: 250,
  lines: [{ barcode: "BAR-1", productName: "Ürün", quantity: 1, price: 250 }],
});

describe("siparişler ucu — hesap ve hata yolu", () => {
  it("yanıt paylaşılan hesaptan gelir (rota kendi kopyasını çalıştırmaz)", async () => {
    // Paylaşılan hesap kendi gövdesini döndürürse yanıtta O görünmeli: aksi halde rota
    // kural değişimini gözeten nesil korumasını atlıyor demektir.
    h.state.sharedResult = { orders: [], paylasilan: true };

    const body = await fetchOrders();

    expect(h.state.sharedCalls).toBe(1);
    expect(body.paylasilan).toBe(true);
  });

  it("manuel siparişler okunamazsa pazaryerinden çekilen veri çöpe gitmez", async () => {
    h.state.manualError = "manuel kayıtlar okunamadı";
    h.state.trendyolPages = [[trendyolOrder()]];

    const body = await fetchOrders();

    // Trendyol verisi duruyor...
    expect(body.trendyol).toMatchObject({ ok: true, count: 1 });
    expect(body.summary.trendyol).toMatchObject({ revenue: 250, orderCount: 1 });
    // ...manuel kaynak ise uyarısıyla birlikte atlanmış.
    expect(body.manual).toMatchObject({ ok: false });
    expect(body.manual.error).toContain("manuel kayıtlar okunamadı");
  });

  it("hesap tamamen patlarsa istek düşmez, hata gövdesi döner", async () => {
    h.state.sharedError = "veritabanına ulaşılamadı";

    const res = await GET(
      new Request("http://localhost/api/orders?fresh=1") as NextRequest
    );
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toContain("veritabanına ulaşılamadı");
  });
});

describe("siparişler ucu — çekim bütünlüğü", () => {
  it("Trendyol çekimi ortada koparsa o platformdan HİÇBİR sipariş özete girmez", async () => {
    // İlk sayfa dolu gelir (100 = devam sinyali), ikinci sayfa patlar.
    h.state.trendyolPages = [
      Array.from({ length: 100 }, (_, i) => ({
        id: 9000 + i,
        orderNumber: `TY-${i}`,
        status: "Delivered",
        orderDate: Date.now(),
        totalPrice: 100,
        lines: [{ barcode: `BAR-${i}`, productName: "Ürün", quantity: 1, price: 100 }],
      })),
      new Error("bağlantı koptu"),
    ];

    const body = await fetchOrders();

    expect(body.trendyol.ok).toBe(false);
    expect(body.trendyol.count).toBe(0);
    expect(body.orders.filter((o: any) => o.platform === "trendyol")).toHaveLength(0);
    expect(body.summary.trendyol).toMatchObject({ revenue: 0, orderCount: 0 });
  });

  it("Trendyol çekimi sorunsuz biterse siparişler özete girer", async () => {
    h.state.trendyolPages = [
      [
        {
          id: 1,
          orderNumber: "TY-1",
          status: "Delivered",
          orderDate: Date.now(),
          totalPrice: 250,
          lines: [{ barcode: "BAR-1", productName: "Ürün", quantity: 1, price: 250 }],
        },
      ],
    ];

    const body = await fetchOrders();

    expect(body.trendyol).toMatchObject({ ok: true, count: 1 });
    expect(body.summary.trendyol).toMatchObject({ revenue: 250, orderCount: 1 });
  });

  it("Hepsiburada açık siparişleri tek sayfayla sınırlı kalmaz, sayfalanarak çekilir", async () => {
    const item = (i: number) => ({
      orderNumber: `HB-${i}`,
      status: "Open",
      orderDate: now(),
      quantity: 1,
      unitPrice: 10,
      productName: "Ürün",
      merchantSku: `SKU-${i}`,
    });
    h.state.hbOpenPages = [
      Array.from({ length: 100 }, (_, i) => item(i)),
      Array.from({ length: 30 }, (_, i) => item(100 + i)),
    ];

    const body = await fetchOrders();

    expect(body.hepsiburada).toMatchObject({ ok: true, count: 130, incompleteCount: 0 });
    expect(body.summary.hepsiburada).toMatchObject({ revenue: 1300, orderCount: 130 });
  });

  it("detayı alınamayan Hepsiburada siparişi ₺0 ciroyla özete ve finans geçmişine girmez", async () => {
    h.state.hbPackages = {
      delivered: [
        { OrderNumber: "D1", DeliveredDate: now() },
        { OrderNumber: "D2", DeliveredDate: now() },
      ],
    };
    // Yalnız D1'in detayı gelir; D2 patlar → tutarı bilinmiyor.
    h.state.hbDetails = {
      D1: {
        orderDate: now(),
        items: [{ quantity: 2, unitPrice: 50, productName: "Ürün", merchantSku: "SKU-D1" }],
      },
    };

    const body = await fetchOrders();

    // Platform durumu eksikliği taşır (Panel/Raporlar bunu okuyacak).
    expect(body.hepsiburada).toMatchObject({ ok: true, count: 2, incompleteCount: 1 });
    // Özet yalnız tutarı BİLİNEN siparişi sayar.
    expect(body.summary.hepsiburada).toMatchObject({ revenue: 100, orderCount: 1 });
    expect(body.summary.quality.incompleteDataOrders).toBe(1);
    // Eksik sipariş listede kalır ama işaretlidir.
    const incomplete = body.orders.find((o: any) => o.id === "hb-D2");
    expect(incomplete).toMatchObject({ dataIncomplete: true, total: 0 });
    // Finans geçmişine ₺0 satır yazılmaz.
    expect(h.state.persisted.map((o: any) => o.id)).not.toContain("hb-D2");
    expect(h.state.persisted.map((o: any) => o.id)).toContain("hb-D1");
  });
});
