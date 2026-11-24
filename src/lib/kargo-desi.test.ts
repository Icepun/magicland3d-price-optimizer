/**
 * ELLE GİRİLEN SHOPIFY KARGO DESİSİ (Berke, 24 Kas 2026): "8 desi hesaplanan bir kargoyu 4 desiyle
 * çıkarsam bunu kargoyu çıktıktan sonra editleyebilmeliyim; telefondan da görünmeli."
 *
 * Çekirdek (kargo bedeli girilen desiyle), masaüstü ucu (kaydet/kaldır + kayıtlı kârı tazele) ve
 * telefonun yazma fonksiyonu (aynı tablo, aynı işaret). Telefon testi kökte: `mobile/` altına test konmaz.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeOrderProfit, computeReturnLoss, kargoSatiriEtiketi, type OrderProfitInput, type OrderProfitLine } from "@/core/order-profit";
import { kargoDesiAnahtari, kargoDesiBul, kargoDesiOku } from "@/core/kargo-desi";
import type { CargoRuleInput } from "@/core/types";

const urun = (desi: number): OrderProfitLine["product"] => ({
  id: "p", name: "Ürün", categoryName: "Dekor", desi, commissionRate: null,
  productionCost: 40, packagingCost: 8, packagingComponents: null, filamentCost: 0, productionCostKnown: true,
  listing: null,
});
const barem = (min: number, max: number, cost: number): CargoRuleInput => ({
  id: `k${min}`, name: `${min}-${max} Desi`, platform: "shopify", categoryName: null,
  minPrice: 0, maxPrice: 999999, minDesi: min, maxDesi: max, cargoCost: cost, priority: 10, isActive: true,
});
function siparis(kargoDesi?: number | null): OrderProfitInput {
  // #1227'deki gibi: toplam 8,4 desi → 8 → 5–10 baremi (145 ₺).
  const lines: OrderProfitLine[] = [
    { unitPrice: 400, quantity: 1, product: urun(4) },
    { unitPrice: 300, quantity: 1, product: urun(2) },
    { unitPrice: 200, quantity: 2, product: urun(1.2) },
  ];
  return {
    platform: "shopify", orderTotal: 1300, lines, commissionRules: [], expenseRules: [],
    cargoRules: [barem(0, 4, 115), barem(5, 10, 145)],
    settings: { vatRate: "20", shopifyCommissionRate: "6.29" },
    orderedAt: new Date("2026-11-24T12:00:00+03:00"),
    kargoDesi,
  };
}

describe("çekirdek: elle girilen kargo desisi", () => {
  it("girilmediyse ürün desilerinin toplamı (eşitlik)", () => {
    const r = computeOrderProfit(siparis());
    expect(r.cargoDesi).toBe(8);
    expect(r.cargoDesiManual).toBe(false);
    expect(computeOrderProfit(siparis(null)).profit).toBeCloseTo(r.profit!, 9);
  });

  it("girildiyse kargo o desiyle: 8 yerine 4 desi → 0–4 baremi, kâr kargo farkı kadar artar", () => {
    const once = computeOrderProfit(siparis());
    const sonra = computeOrderProfit(siparis(4));
    expect(sonra.cargoDesi).toBe(4);
    expect(sonra.cargoDesiManual).toBe(true);
    expect(sonra.cargoBand).toEqual({ minDesi: 0, maxDesi: 4 });
    expect(sonra.cargoCost).toBe(115);
    // Kargo 30 ₺ ucuzladı; içindeki KDV indirildiği için kâr 30 × 5/6 = 25 ₺ artar.
    expect(sonra.profit! - once.profit!).toBeCloseTo(30 * (5 / 6), 6);
    expect(kargoSatiriEtiketi(sonra)).toBe("4 desi · 0–4 desi baremi · elle girildi");
  });

  it("iade zararı da aynı desiyle", () => {
    expect(computeReturnLoss(siparis(4)).outboundCargo).toBe(115);
    expect(computeReturnLoss(siparis()).outboundCargo).toBe(145);
  });

  it("geçerli desi okunur; yalnız Shopify'da uygulanır; bozuk harita çökertmez", () => {
    expect(kargoDesiOku("4,5")).toBe(4.5);
    expect(kargoDesiOku("0")).toBeNull();
    expect(kargoDesiOku("abc")).toBeNull();
    expect(kargoDesiOku(5000)).toBeNull();
    const harita = new Map([[kargoDesiAnahtari("shopify", "sh-1227"), 4]]);
    expect(kargoDesiBul(harita, "shopify", "gid://shopify/Order/1227")).toBe(4);
    expect(kargoDesiBul(harita, "trendyol", "sh-1227")).toBeNull();
    expect(kargoDesiBul({} as never, "shopify", "sh-1227")).toBeNull();
  });
});

// ── Masaüstü ucu (sahte prisma) ──
const db = vi.hoisted(() => ({
  orderCargoDesi: { upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
  $executeRawUnsafe: vi.fn(async () => 1),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/runtime-schema", () => ({ ensureRuntimeSchema: vi.fn() }));
vi.mock("@/lib/orders-cache", () => ({ invalidateOrdersCache: vi.fn() }));
vi.mock("@/lib/route-cache", () => ({ bustCaches: vi.fn(), bustCache: vi.fn() }));

const istek = (govde: unknown) => ({ json: async () => govde }) as never;

describe("masaüstü /api/orders/kargo-desi", () => {
  beforeEach(() => vi.clearAllMocks());

  it("kaydeder ve o siparişin kayıtlı kârını yeniden hesaplanacak diye işaretler", async () => {
    const uc = await import("@/app/api/orders/kargo-desi/route");
    const r = await uc.PUT(istek({ siparisId: "gid://shopify/Order/1227", desi: "4" }));
    expect(r.status).toBe(200);
    const arg = db.orderCargoDesi.upsert.mock.calls[0][0] as { where: unknown; update: unknown };
    expect(arg.where).toEqual({ platform_externalOrderId: { platform: "shopify", externalOrderId: "sh-1227" } });
    expect(arg.update).toEqual({ desi: 4 });
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('"calculationVersion" = 0'), "shopify", "sh-1227");
  });

  it("geçersiz desi ve Shopify dışı sipariş reddedilir", async () => {
    const uc = await import("@/app/api/orders/kargo-desi/route");
    expect((await uc.PUT(istek({ siparisId: "sh-1", desi: "0" }))).status).toBe(400);
    expect((await uc.PUT(istek({ platform: "trendyol", siparisId: "ty-1", desi: 4 }))).status).toBeGreaterThanOrEqual(400);
    expect(db.orderCargoDesi.upsert).not.toHaveBeenCalled();
  });

  it("kaldırınca kayıt silinir ve kâr yine işaretlenir", async () => {
    const uc = await import("@/app/api/orders/kargo-desi/route");
    await uc.DELETE(istek({ siparisId: "sh-1227" }));
    expect(db.orderCargoDesi.deleteMany).toHaveBeenCalledWith({ where: { platform: "shopify", externalOrderId: "sh-1227" } });
    expect(db.$executeRawUnsafe).toHaveBeenCalled();
  });
});

// ── Telefonun yazma fonksiyonu (gerçek modül; veritabanı uçları sahte) ──
const tel = vi.hoisted(() => ({ batch: [] as { sql: string; args: unknown[] }[][], execute: [] as string[] }));
vi.mock("@/lib/turso", () => ({
  execute: vi.fn(async (sql: string) => {
    tel.execute.push(sql);
    return { rows: [], rowsAffected: 0 };
  }),
  writeBatch: vi.fn(async (stmts: { sql: string; args: unknown[] }[]) => {
    tel.batch.push(stmts);
    return [];
  }),
}));
const yol = vi.hoisted(() => ({ kargoDesi: "../../mobile/src/lib/db/kargo-desi" }));

describe("telefon kargoDesisiKaydet", () => {
  it("aynı tabloya yazar ve kayıtlı kârı işaretler (tek parça)", async () => {
    const m = (await import(/* @vite-ignore */ yol.kargoDesi)) as { kargoDesisiKaydet: (id: string, d: number | null) => Promise<void> };
    await m.kargoDesisiKaydet("sh-1227", 4);
    const son = tel.batch.at(-1)!;
    expect(son[0].sql).toContain('INSERT INTO "OrderCargoDesi"');
    expect(son[0].args.slice(1, 4)).toEqual(["shopify", "sh-1227", 4]);
    expect(son[1].sql).toContain('"calculationVersion" = 0');
    await m.kargoDesisiKaydet("sh-1227", null);
    expect(tel.batch.at(-1)![0].sql).toContain('DELETE FROM "OrderCargoDesi"');
    await expect(m.kargoDesisiKaydet("sh-1227", 0)).rejects.toThrow();
  });
});
