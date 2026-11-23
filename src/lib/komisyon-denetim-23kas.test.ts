/**
 * Komisyonlar denetimi (23 Kas 2026) — düzeltmelerin bekçi testleri.
 * Veritabanı açılmaz: uçlar sahte prisma ile koşar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  commissionRule: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  appSetting: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  $transaction: vi.fn(),
}));
const batchWrite = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/libsql-batch", () => ({ batchWrite }));
vi.mock("@/lib/cache-busting", () => ({ bustProfitInputCaches: vi.fn(), bustInventoryAlertCaches: vi.fn() }));
vi.mock("@/lib/route-cache", () => ({ bustCache: vi.fn(), swr: vi.fn() }));
vi.mock("@/lib/r2", () => ({ invalidateR2Config: vi.fn() }));
vi.mock("@/lib/runtime-schema", () => ({ ensureRuntimeSchema: vi.fn() }));
vi.mock("@/lib/kural-sonrasi-tazele", () => ({ kuralSonrasiSiparisleriTazele: vi.fn(async () => {}) }));

const { komisyonOzeti } = await import("./komisyon-ozeti");
const kurallar = await import("@/app/api/commission-rules/route");
const kural = await import("@/app/api/commission-rules/[id]/route");
const ayarlar = await import("@/app/api/settings/route");

const istek = (govde: unknown) => ({ json: async () => govde }) as never;
const parametre = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  batchWrite.mockResolvedValue(true);
});

describe("son 30 gün komisyon ortalaması", () => {
  it("eşleşmeyen / kısmi siparişin tahmini ortalamaya girmez (oranı düşük göstermez)", () => {
    const [ty] = komisyonOzeti([
      { platform: "trendyol", total: 100, actualCommission: 21 },
      { platform: "trendyol", total: 100, estimatedCommission: 20 },
      // Ürünü eşleşmeyen sipariş: tahmini 0 ama komisyon gerçekte bilinmiyor.
      { platform: "trendyol", total: 100, estimatedCommission: 0, unmatchedCount: 1 },
    ]);
    expect(ty.ciro).toBe(300);
    expect(ty.komisyon).toBe(41);
    expect(ty.oran).toBeCloseTo(0.205, 6); // eskiden 41/300 = %13,7
    expect(ty.bilinmeyenAdet).toBe(1);
  });
});

describe("kural uçları — doğrulama", () => {
  it("oransız ya da ters aralıklı kural reddedilir (Türkçe mesaj)", async () => {
    const r1 = await kurallar.POST(istek({ name: "Genel" }));
    expect(r1.status).toBe(400);
    const r2 = await kurallar.POST(istek({ name: "Ters", commissionRate: 0.2, minPrice: 500, maxPrice: 100 }));
    expect(r2.status).toBe(400);
    expect((await r2.json()).error).toMatch(/Max fiyat/);
    expect(db.commissionRule.create).not.toHaveBeenCalled();
  });

  it("geçerli kural eklenir, boş kategori null yazılır", async () => {
    db.commissionRule.create.mockResolvedValue({ id: "k1" });
    const r = await kurallar.POST(istek({ name: "Genel", categoryName: "  ", commissionRate: 0.215 }));
    expect(r.status).toBe(201);
    expect(db.commissionRule.create.mock.calls[0][0].data).toMatchObject({ categoryName: null, minPrice: 0, maxPrice: 999999, commissionRate: 0.215 });
  });

  it("güncelleme: olmayan kural 404, yalnız min değişse de aralık denetlenir", async () => {
    db.commissionRule.findUnique.mockResolvedValueOnce(null);
    expect((await kural.PATCH(istek({ commissionRate: 0.1 }), parametre("yok"))).status).toBe(404);
    db.commissionRule.findUnique.mockResolvedValueOnce({ minPrice: 0, maxPrice: 200 });
    const r = await kural.PATCH(istek({ minPrice: 300 }), parametre("k1"));
    expect(r.status).toBe(400);
    expect(db.commissionRule.update).not.toHaveBeenCalled();
  });
});

describe("Shopify sabit komisyonu", () => {
  it("boş ya da aralık dışı oran kaydedilmez (boş kayıt %0 sayılıyordu)", async () => {
    for (const deger of ["", "  ", "-2", "150", "abc"]) {
      const r = await ayarlar.POST(istek({ shopifyCommissionRate: deger }));
      expect(r.status).toBe(400);
    }
    expect(batchWrite).not.toHaveBeenCalled();
  });

  it("virgüllü oran noktalı kaydedilir", async () => {
    db.appSetting.findMany.mockResolvedValue([{ key: "shopifyCommissionRate", value: "6.29" }]);
    await ayarlar.POST(istek({ shopifyCommissionRate: "6,5" }));
    expect(batchWrite.mock.calls[0][0][0].args).toEqual(["shopifyCommissionRate", "6.5"]);
  });
});
