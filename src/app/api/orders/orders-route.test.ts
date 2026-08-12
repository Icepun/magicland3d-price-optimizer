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
    /** İptal/iade listeleri. null = uç yok (istemci null döner) → akış etkilenmemeli. */
    hbClaims: {} as Record<string, any[] | null>,
    hbDetails: {} as Record<string, any>,
    persisted: [] as any[],
    /** Son arka plan yazımının durumu (null = henüz tur bitmedi). */
    lastWrite: null as any,
    /** Kimlik bilgisi okunamayan platformlar — "kurulu değil" yolu. */
    missingCredentials: new Set<string>(),
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
  // Uyarı ancak SON TAMAMLANAN turun sonucundan doğabilir (yazım artık arka planda).
  lastOrderFinanceSnapshotWrite: () => h.state.lastWrite,
  orderFinanceSnapshotWriteInFlight: () => false,
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
vi.mock("@/services/shopify-settings", () => ({
  getShopifyCredentials: vi.fn(async () => {
    if (h.state.missingCredentials.has("shopify")) throw new Error("Shopify bilgileri eksik");
    return {};
  }),
}));
vi.mock("@/services/shopify-client", () => ({
  ShopifyAdminTokenMissingError: class ShopifyAdminTokenMissingError extends Error {},
  ShopifyClient: class {
    async listOrders() {
      return h.state.shopifyOrders;
    }
  },
}));
vi.mock("@/services/trendyol-settings", () => ({
  getTrendyolCredentials: vi.fn(async () => {
    if (h.state.missingCredentials.has("trendyol")) throw new Error("Trendyol API bilgileri eksik");
    return {};
  }),
}));
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
  getHepsiburadaCredentials: vi.fn(async () => {
    if (h.state.missingCredentials.has("hepsiburada")) {
      throw new Error("Hepsiburada API bilgileri eksik");
    }
    return {};
  }),
}));
vi.mock("@/services/hepsiburada-client", () => ({
  HepsiburadaClient: class {
    async listOrders(params: { offset?: number } = {}) {
      return { items: h.state.hbOpenPages[(params.offset ?? 0) / 100] ?? [] };
    }
    async listPackages(status: string, params: { offset?: number } = {}) {
      return { items: (params.offset ?? 0) === 0 ? h.state.hbPackages[status] ?? [] : [] };
    }
    // Uç yolu doğrulanmadığı için istemci "yok" durumunu null ile bildirir (asla fırlatmaz).
    async listClaimPackages(kind: string, params: { offset?: number } = {}) {
      const rows = h.state.hbClaims[kind];
      if (rows == null) return null;
      return { items: (params.offset ?? 0) === 0 ? rows : [] };
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
  h.state.hbClaims = { cancelled: null, returned: null };
  h.state.hbDetails = {};
  h.state.persisted = [];
  h.state.lastWrite = null;
  h.state.missingCredentials = new Set<string>();
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

describe("bir kaynak alınamazsa toplam EKSİK olduğunu söyler", () => {
  it("çekim patlarsa 'kurulu değil' sanılmaz — mesajda 'bulunamadı' geçse bile", async () => {
    // 🔴 Eskiden notConfigured hata METNİNDEN türetiliyordu: "Adres bulunamadı" diyen GERÇEK
    // bir hata "kurulu değil" sayılıyor ve ekranda tek bir uyarı bile kalmıyordu.
    h.state.trendyolPages = [new Error("Trendyol adresi bulunamadı")];

    const body = await fetchOrders();

    expect(body.trendyol).toMatchObject({ ok: false });
    expect(body.trendyol.notConfigured).toBeFalsy();
    expect(body.summary.quality.missingSources).toContain("Trendyol");
    expect(body.dataComplete).toBe(false);
  });

  it("kimlik bilgisi yoksa platform 'kurulu değil' olur ve eksik veri sayılmaz", async () => {
    h.state.missingCredentials = new Set(["trendyol"]);

    const body = await fetchOrders();

    expect(body.trendyol).toMatchObject({ ok: false, notConfigured: true });
    expect(body.trendyol.error).toBeUndefined();
    expect(body.summary.quality.missingSources).not.toContain("Trendyol");
    expect(body.dataComplete).toBe(true);
  });

  it("manuel siparişler okunamazsa da toplam eksik işaretlenir", async () => {
    h.state.manualError = "manuel kayıtlar okunamadı";

    const body = await fetchOrders();

    expect(body.summary.quality.missingSources).toContain("Manuel siparişler");
    expect(body.dataComplete).toBe(false);
  });
});

describe("iade ve iptaller ciroda kalmaz", () => {
  /**
   * Gerileme koruması: "Paket Bölündü" (UnPacked) ve "Yeniden Paketleniyor" (Repack) İPTAL
   * DEĞİLDİR — satış devam ediyor. Bir tur bunları iptal/bilinmeyen sayıp ciroyu düşürmüştü.
   */
  it("paket bölünmesi ve yeniden paketleme ciroda KALIR", async () => {
    h.state.trendyolPages = [
      [
        { ...trendyolOrder(), id: 8, orderNumber: "TY-8", status: "UnPacked" },
        { ...trendyolOrder(), id: 9, orderNumber: "TY-9", status: "Repack" },
      ],
    ];

    const body = await fetchOrders();

    expect(body.summary.trendyol).toMatchObject({ orderCount: 2 });
    expect(body.summary.quality.unknownStatusOrders).toBe(0);
  });

  it("tanınmayan Trendyol durumu ciroya girmez, sayısı ve adı görünür", async () => {
    // GERÇEKTEN tanınmayan bir durum adı. Örnek olarak "Repack" KULLANILMAZ: o Trendyol'un
    // gerçek ve AKTİF bir paket durumu ("yeniden paketleniyor") ve tabloda tanımlı —
    // bilinmeyen sayılsaydı geçerli bir satış ciro dışında kalırdı.
    h.state.trendyolPages = [
      [
        { ...trendyolOrder(), id: 7, orderNumber: "TY-7", status: "SomeFutureStatus" },
        trendyolOrder(),
      ],
    ];

    const body = await fetchOrders();

    // Yalnız durumu bilinen sipariş ciroda.
    expect(body.summary.trendyol).toMatchObject({ revenue: 250, orderCount: 1 });
    expect(body.summary.quality.unknownStatusOrders).toBe(1);
    expect(body.summary.quality.unknownStatuses).toEqual([
      { status: "SomeFutureStatus", orderCount: 1 },
    ]);
    // Listede kalır ama işaretli; kalıcı geçmişe YAZILMAZ (satış mı iade mi bilmiyoruz).
    expect(body.orders.find((o: any) => o.id === "ty-7")).toMatchObject({
      statusUnknown: true,
    });
    expect(h.state.persisted.map((o: any) => o.id)).not.toContain("ty-7");
  });

  it("bilinen iade durumu ciroya girmez (UnDeliveredAndReturned)", async () => {
    h.state.trendyolPages = [
      [{ ...trendyolOrder(), id: 8, orderNumber: "TY-8", status: "UnDeliveredAndReturned" }],
    ];

    const body = await fetchOrders();

    expect(body.summary.trendyol).toMatchObject({ revenue: 0, orderCount: 0 });
    const order = body.orders.find((o: any) => o.id === "ty-8");
    expect(order.statusKind).toBe("cancelled");
    // Bilinen bir iade adı: "tanınmayan durum" kovasına düşmez.
    expect(order.statusUnknown).toBeFalsy();
    expect(body.summary.quality.unknownStatusOrders).toBe(0);
  });

  it("çok kalemli siparişte tek kalemin iadesi görünür (tutar değişmez)", async () => {
    h.state.trendyolPages = [
      [
        {
          ...trendyolOrder(),
          id: 9,
          orderNumber: "TY-9",
          totalPrice: 300,
          lines: [
            { barcode: "B1", productName: "A", quantity: 1, price: 200 },
            {
              barcode: "B2",
              productName: "B",
              quantity: 1,
              price: 100,
              orderLineItemStatusName: "Returned",
            },
          ],
        },
      ],
    ];

    const body = await fetchOrders();

    expect(body.orders.find((o: any) => o.id === "ty-9")).toMatchObject({
      returnedLineCount: 1,
    });
    expect(body.summary.quality.partialReturnOrders).toBe(1);
    // Tutar platformdan geldiği gibi kalır — tahminle ciro düşülmez.
    expect(body.summary.trendyol.revenue).toBe(300);
  });

  it("iade listesinde çıkan teslim sipariş ciroya girmez ve geçmişe iptal olarak yazılır", async () => {
    h.state.hbPackages = { delivered: [{ OrderNumber: "R1", DeliveredDate: now() }] };
    h.state.hbDetails = {
      R1: { orderDate: now(), items: [{ quantity: 1, unitPrice: 120, productName: "Ürün" }] },
    };
    // Aynı sipariş iade listesinde de var ve KAYDIN KENDİ durumu iade diyor.
    h.state.hbClaims = { cancelled: null, returned: [{ OrderNumber: "R1", status: "Returned" }] };

    const body = await fetchOrders();

    expect(body.orders.find((o: any) => o.id === "hb-R1")).toMatchObject({
      statusKind: "cancelled",
    });
    expect(body.summary.hepsiburada).toMatchObject({ revenue: 0, orderCount: 0 });
    // Kalıcı kayıt "satıldı"da kalmasın diye iptal bilgisi yine de yazılır.
    expect(
      h.state.persisted.find((o: any) => o.id === "hb-R1")
    ).toMatchObject({ statusKind: "cancelled" });
  });

  it("iade listesi siparişin kendi durumunu doğrulamıyorsa ciroya DOKUNULMAZ", async () => {
    // Güvenlik freni: uç yolu doğrulanmadı; "her siparişi döndüren" bir yanıt ciroyu silemez.
    h.state.hbPackages = { delivered: [{ OrderNumber: "K1", DeliveredDate: now() }] };
    h.state.hbDetails = {
      K1: { orderDate: now(), items: [{ quantity: 1, unitPrice: 90, productName: "Ürün" }] },
    };
    h.state.hbClaims = { cancelled: [{ OrderNumber: "K1" }], returned: null };

    const body = await fetchOrders();

    expect(body.orders.find((o: any) => o.id === "hb-K1")).toMatchObject({
      statusKind: "delivered",
    });
    expect(body.summary.hepsiburada).toMatchObject({ revenue: 90, orderCount: 1 });
  });

  it("iade/iptal ucu yoksa sipariş akışı etkilenmez", async () => {
    h.state.hbPackages = { delivered: [{ OrderNumber: "N1", DeliveredDate: now() }] };
    h.state.hbDetails = {
      N1: { orderDate: now(), items: [{ quantity: 1, unitPrice: 60, productName: "Ürün" }] },
    };
    h.state.hbClaims = { cancelled: null, returned: null };

    const body = await fetchOrders();

    expect(body.hepsiburada).toMatchObject({ ok: true, count: 1 });
    expect(body.summary.hepsiburada).toMatchObject({ revenue: 60, orderCount: 1 });
  });
});

describe("finans geçmişi hatası kullanıcıya ulaşır", () => {
  it("arka plan yazımı düştüyse yanıt bunu bildirir", async () => {
    // 🔴 Yazım arka plana alınınca bu uyarı hiçbir koşulda çıkamıyordu.
    h.state.lastWrite = { ok: false, error: "veritabanı kilitli" };
    h.state.trendyolPages = [[trendyolOrder()]];

    const body = await fetchOrders();

    expect(body.financeHistory).toMatchObject({ ok: false });
    expect(body.financeHistory.error).toContain("veritabanı kilitli");
  });

  it("son tur başarılıysa uyarı çıkmaz", async () => {
    h.state.lastWrite = { ok: true, eligibleOrders: 1, writtenOrders: 1, writtenItems: 0 };
    h.state.trendyolPages = [[trendyolOrder()]];

    const body = await fetchOrders();

    expect(body.financeHistory.ok).toBe(true);
    expect(body.financeHistory.error).toBeUndefined();
  });
});
