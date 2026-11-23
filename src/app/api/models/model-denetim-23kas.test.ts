/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Modeller denetimi (23 Kas 2026) — silme yolları.
 * - Parça silme: ikiz kopyalar (?ek=) ve tüm varyantlar (?allVariants=1) TEK güvenli yoldan gider.
 * - Sahipsiz silme: yalnız KAPALI/SİLİNMİŞ yazıcıların dosyaları; açık yazıcınınki asla.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  satirlar: [] as Array<{ id: string; productId: string; printerConfigId: string; r2Key: string | null; meshR2Key: string | null; storedPath: string }>,
  acikYazicilar: [] as string[],
  silinen: null as string[] | null,
}));

vi.mock("@/lib/runtime-schema", () => ({ ensureRuntimeSchema: vi.fn(async () => {}) }));
vi.mock("@/lib/cache-busting", () => ({ bustModelCaches: vi.fn() }));
vi.mock("@/lib/model-gorseli", () => ({ gorselOku: vi.fn(async () => null) }));
vi.mock("@/lib/model-file-cleanup", () => ({
  modelSatirlariniSil: vi.fn(async (rows: Array<{ id: string }>) => {
    h.silinen = rows.map((r) => r.id).sort();
    return { satir: rows.length, dosya: 0 };
  }),
}));
vi.mock("@/lib/prisma", () => {
  // Basit sahte where: id.in, r2Key.in, storedPath.in, NOT productId / printerConfigId.in
  const uyar = (r: any, where: any): boolean => {
    if (!where) return true;
    if (where.id?.in && !where.id.in.includes(r.id)) return false;
    if (where.OR && !where.OR.some((w: any) => uyar(r, w))) return false;
    if (where.r2Key?.in && !where.r2Key.in.includes(r.r2Key)) return false;
    if (where.storedPath?.in && !where.storedPath.in.includes(r.storedPath)) return false;
    const not = Array.isArray(where.NOT) ? where.NOT : where.NOT ? [where.NOT] : [];
    for (const n of not) {
      if (n.productId && r.productId === n.productId) return false;
      if (n.printerConfigId?.in && n.printerConfigId.in.includes(r.printerConfigId)) return false;
    }
    return true;
  };
  return {
    prisma: {
      productModelFile: {
        findMany: vi.fn(async ({ where }: any) => h.satirlar.filter((r) => uyar(r, where))),
        findUnique: vi.fn(async ({ where }: any) => h.satirlar.find((r) => r.id === where.id) ?? null),
      },
      printerConfig: {
        findMany: vi.fn(async () => h.acikYazicilar.map((id) => ({ id }))),
      },
    },
  };
});

const { DELETE } = await import("./[id]/route");
const { POST: sahipsizSil } = await import("./sahipsiz-sil/route");

const satir = (id: string, ek: Partial<(typeof h.satirlar)[number]> = {}) => ({
  id, productId: "p1", printerConfigId: "u1", r2Key: `models/${id}`, meshR2Key: null, storedPath: "", ...ek,
});
const sil = (id: string, qs = "") =>
  DELETE(new Request(`http://x/api/models/${id}${qs}`, { method: "DELETE" }) as unknown as NextRequest, {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  h.satirlar = [];
  h.acikYazicilar = ["u1", "u2"];
  h.silinen = null;
});

describe("parça silme", () => {
  it("ikiz kopya (?ek=) da silinir — pencere ikisini tek parça gösteriyordu", async () => {
    h.satirlar = [satir("a"), satir("ikiz", { printerConfigId: "u2", r2Key: "models/ikiz" }), satir("baska")];
    const res = await sil("a", "?ek=ikiz");
    expect(res.status).toBe(200);
    expect(h.silinen).toEqual(["a", "ikiz"]);
  });

  it("tüm varyantlar: aynı bulut nesnesini paylaşan kardeş satırlar da gider", async () => {
    h.satirlar = [
      satir("a", { r2Key: "models/ortak" }),
      satir("k1", { productId: "p2", r2Key: "models/ortak" }),
      satir("k2", { productId: "p3", r2Key: "models/ortak" }),
      satir("ilgisiz", { productId: "p4", r2Key: "models/baska" }),
    ];
    await sil("a", "?allVariants=1");
    expect(h.silinen).toEqual(["a", "k1", "k2"]);
  });

  it("boş storedPath (bulut satırlarının ortak değeri) ile eşleştirme YAPILMAZ", async () => {
    h.satirlar = [satir("a", { r2Key: null, storedPath: "" }), satir("b", { r2Key: null, storedPath: "" })];
    await sil("a", "?allVariants=1");
    expect(h.silinen).toEqual(["a"]);
  });

  it("silinmiş parça → 404 ve kısa Türkçe ileti (eskiden 'silindi' deyip hiçbir şey yapmıyordu)", async () => {
    const res = await sil("yok");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/bulunamadı/);
    expect(h.silinen).toBeNull();
  });

  it("özel baskı satırına ek yoluyla dokunulmaz", async () => {
    h.satirlar = [satir("a"), satir("ozel", { productId: "__custom__" })];
    await sil("a", "?ek=ozel");
    expect(h.silinen).toEqual(["a"]);
  });
});

describe("sahipsiz dosya silme", () => {
  const istek = (ids: string[]) =>
    sahipsizSil(new Request("http://x/api/models/sahipsiz-sil", { method: "POST", body: JSON.stringify({ ids }) }) as unknown as NextRequest);

  it("yalnız kapalı/silinmiş yazıcıların dosyaları silinir; açık yazıcınınki ASLA", async () => {
    h.satirlar = [
      satir("kapali", { printerConfigId: "eski" }),
      satir("acik", { printerConfigId: "u1" }),
      satir("ozel", { printerConfigId: "eski", productId: "__custom__" }),
    ];
    const res = await istek(["kapali", "acik", "ozel"]);
    expect((await res.json()).silinen).toBe(1);
    expect(h.silinen).toEqual(["kapali"]);
  });
});
