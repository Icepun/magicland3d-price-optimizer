/**
 * Üretim Planı denetimi (23 Kas 2026) — düzeltmelerin bekçi testleri.
 * Veritabanı açılmaz: okuma katmanı sahte prisma ile koşar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  $queryRawUnsafe: vi.fn(),
  product: { findMany: vi.fn() },
  productModelFile: { findMany: vi.fn() },
  printerConfig: { findMany: vi.fn() },
  printerSnapshot: { findMany: vi.fn() },
  filamentSpool: { findMany: vi.fn() },
  appSetting: { findUnique: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/runtime-schema", () => ({ ensureRuntimeSchema: async () => {} }));
// Önbellek her çağrıda hesaplasın (testler birbirini etkilemesin).
vi.mock("@/lib/route-cache", () => ({ swr: (_k: string, _t: number, f: () => Promise<unknown>) => f() }));

const { satisSayimBasi, manuelKalemAdetleri } = await import("@/core/satis-hizi");
const { deriveSalesInsights } = await import("./planner-insights");
const { satisHiziSatirlari } = await import("./satis-hizi-veri");
const { urunSatisOzeti } = await import("./urun-satis");
const { computeQueue } = await import("./print-queue");

const GUN = 86_400_000;
const SIMDI = Date.parse("2026-11-23T12:00:00.000Z");
const gunOnce = (n: number) => SIMDI - n * GUN;

beforeEach(() => vi.clearAllMocks());

describe("pay ile payda aynı dönem", () => {
  it("sayım başı = pencere başı ile kapsam başının GEÇ olanı", () => {
    expect(satisSayimBasi(SIMDI, gunOnce(30))).toBe(gunOnce(30));
    expect(satisSayimBasi(SIMDI, gunOnce(200))).toBe(gunOnce(90));
    expect(satisSayimBasi(SIMDI, null)).toBe(gunOnce(90));
  });

  it("kanal 30 gün önce başladıysa 90 günlük satış 30 güne bölünüp hız şişmez", () => {
    const satirlar = [
      { productId: "a", orderedAt: gunOnce(80), quantity: 6, statusKind: "delivered" },
      { productId: "a", orderedAt: gunOnce(10), quantity: 3, statusKind: "delivered" },
    ];
    const o = deriveSalesInsights(satirlar, gunOnce(30), SIMDI);
    expect(o.measuredDays).toBe(30);
    expect(o.items[0].soldInWindow).toBe(3); // eskiden 9 → 3 kat hız
  });

  it("ürün detayı da aynı dönemi sayar", () => {
    const oz = urunSatisOzeti(
      [
        { platform: "trendyol", orderedAt: gunOnce(80), quantity: 6 },
        { platform: "trendyol", orderedAt: gunOnce(10), quantity: 3 },
      ],
      gunOnce(30),
      SIMDI,
      null
    );
    expect(oz.son90Adet).toBe(3);
    expect(oz.kacGundeBir).toBe(10);
  });
});

describe("manuel siparişler satış hızına girer", () => {
  it("kalem JSON'u: zarf ya da dizi; bozuk ve katalog dışı kalem sayılmaz", () => {
    expect(manuelKalemAdetleri(JSON.stringify({ items: [{ productId: "p1", quantity: 2 }, { name: "serbest", quantity: 5 }] }))).toEqual([
      { productId: "p1", quantity: 2 },
    ]);
    expect(manuelKalemAdetleri(JSON.stringify([{ productId: "p2", quantity: 1 }]))).toEqual([{ productId: "p2", quantity: 1 }]);
    expect(manuelKalemAdetleri("{bozuk")).toEqual([]);
    expect(manuelKalemAdetleri(null)).toEqual([]);
  });

  it("okuma katmanı sipariş kalemleri + manuel kalemleri birlikte döner", async () => {
    db.$queryRawUnsafe
      .mockResolvedValueOnce([{ orderedAt: gunOnce(60) }]) // kapsam
      .mockResolvedValueOnce([{ productId: "p1", orderedAt: gunOnce(5), quantity: 1, statusKind: "delivered" }])
      .mockResolvedValueOnce([{ orderedAt: gunOnce(3), itemsJson: JSON.stringify({ items: [{ productId: "p9", quantity: 4 }] }) }]);
    const { satirlar, kapsamBaslangicMs } = await satisHiziSatirlari(SIMDI);
    expect(kapsamBaslangicMs).toBe(gunOnce(60));
    expect(satirlar.map((r) => [r.productId, r.quantity])).toEqual([
      ["p1", 1],
      ["p9", 4],
    ]);
    // Manuel siparişler de iptal hariç ve aynı sayım başından okunur.
    const manuelSql = String(db.$queryRawUnsafe.mock.calls[2][0]);
    expect(manuelSql).toMatch(/FROM "ManualOrder"/);
    expect(db.$queryRawUnsafe.mock.calls[2][2]).toBe(gunOnce(60));
  });
});

describe("yazıcı kuyruğu", () => {
  const kur = (kapsamGun: number) => {
    db.$queryRawUnsafe
      .mockResolvedValueOnce([{ orderedAt: gunOnce(kapsamGun) }])
      .mockResolvedValueOnce([{ productId: "u1", orderedAt: gunOnce(2), quantity: 30, statusKind: "delivered" }])
      .mockResolvedValueOnce([]);
    db.product.findMany.mockResolvedValue([
      { id: "u1", name: "Kupa", imageUrl: null, stock: 0, cost: { printTimeHours: 1, filamentWeight: 50, ekFilamentlerJson: null } },
    ]);
    db.productModelFile.findMany.mockResolvedValue([{ productId: "u1", printerConfigId: "alt" }]);
    db.printerConfig.findMany.mockResolvedValue([
      { id: "alt", name: "U1 Alt", brand: "Snapmaker", accent: null, type: "moonraker", model: "U1", enabled: true },
      { id: "ust", name: "U1 Üst", brand: "Snapmaker", accent: null, type: "moonraker", model: "U1", enabled: true },
      { id: "a1", name: "A1", brand: "Bambu", accent: null, type: "bambu", model: "A1", enabled: true },
    ]);
    db.printerSnapshot.findMany.mockResolvedValue([]);
    db.filamentSpool.findMany.mockResolvedValue([]);
  };

  it("aynı model yazıcılar dosyayı paylaşır (2× U1), başka model paylaşmaz", async () => {
    kur(60);
    const q = await computeQueue(5, { mod: "sabit", kapsamGun: 30 });
    const is = [...q.printers.flatMap((p) => p.jobs), ...q.unassigned].find((j) => j.productId === "u1");
    expect(is?.printerIds.sort()).toEqual(["alt", "ust"]);
  });

  it("satış geçmişi yetersizse 'satışa göre' yerine sabit hedef (rakam uydurulmaz)", async () => {
    kur(5); // 5 günlük geçmiş < 21
    const q = await computeQueue(5, { mod: "talep", kapsamGun: 30 });
    const is = [...q.printers.flatMap((p) => p.jobs), ...q.unassigned].find((j) => j.productId === "u1");
    // Talep modunda 30 adet / 5 gün × 30 gün = tavana (5) dayanırdı; sabit hedef de 5 → iş 5 adet.
    expect(is?.quantity).toBe(5);
  });
});
