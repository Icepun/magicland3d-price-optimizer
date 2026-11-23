/**
 * Kargo denetimi (23 Kas 2026) — düzeltmelerin bekçi testleri.
 * Veritabanı açılmaz: uçlar sahte prisma ile koşar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  cargoRule: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), updateMany: vi.fn(), createMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/runtime-schema", () => ({ ensureRuntimeSchema: async () => {} }));
vi.mock("@/lib/cache-busting", () => ({ bustProfitInputCaches: vi.fn() }));

const kurallar = await import("@/app/api/cargo-rules/route");
const kural = await import("@/app/api/cargo-rules/[id]/route");

const istek = (govde: unknown) => ({ json: async () => govde }) as never;
const parametre = (id: string) => ({ params: Promise.resolve({ id }) });
const DUN = new Date(Date.now() - 86_400_000);

beforeEach(() => vi.clearAllMocks());

describe("kargo kuralı ekleme — doğrulama", () => {
  it("kargo bedelsiz ya da ters aralıklı kural reddedilir", async () => {
    expect((await kurallar.POST(istek({ name: "Bedelsiz", platform: "shopify" }))).status).toBe(400);
    const ters = await kurallar.POST(istek({ name: "Ters", platform: "shopify", cargoCost: 50, minDesi: 5, maxDesi: 2 }));
    expect(ters.status).toBe(400);
    expect((await ters.json()).error).toMatch(/Max desi/);
    expect(db.cargoRule.create).not.toHaveBeenCalled();
  });
});

describe("geçmiş dönemin kuralı kilitli", () => {
  it("süresi dolmuş kural düzenlenemez ve silinemez", async () => {
    db.cargoRule.findUnique.mockResolvedValue({ validTo: DUN, minPrice: 0, maxPrice: 100, minDesi: 0, maxDesi: 5 });
    const g = await kural.PATCH(istek({ cargoCost: 99 }), parametre("eski"));
    const s = await kural.DELETE(istek({}), parametre("eski"));
    expect(g.status).toBe(400);
    expect(s.status).toBe(400);
    expect(db.cargoRule.update).not.toHaveBeenCalled();
    expect(db.cargoRule.delete).not.toHaveBeenCalled();
  });

  it("yürürlükteki kural düzenlenir; tek alan değişse de aralık denetlenir", async () => {
    db.cargoRule.findUnique.mockResolvedValue({ validTo: null, minPrice: 0, maxPrice: 100, minDesi: 0, maxDesi: 5 });
    expect((await kural.PATCH(istek({ minDesi: 9 }), parametre("k1"))).status).toBe(400);
    db.cargoRule.update.mockResolvedValue({ id: "k1" });
    expect((await kural.PATCH(istek({ cargoCost: 60 }), parametre("k1"))).status).toBe(200);
  });

  it("olmayan kural 404", async () => {
    db.cargoRule.findUnique.mockResolvedValue(null);
    expect((await kural.PATCH(istek({ cargoCost: 1 }), parametre("yok"))).status).toBe(404);
    expect((await kural.DELETE(istek({}), parametre("yok"))).status).toBe(404);
  });
});
