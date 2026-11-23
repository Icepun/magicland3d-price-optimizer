import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

/**
 * ÜRÜN DETAYI DENETİMİ (23 Kas 2026) — gerçek SQLite üzerinde:
 * - +/- stok ATOMİK farkla yazılır (telefonda aynı anda yapılan değişiklik ezilmez).
 * - "Tüm varyantlara uygula" tek işlemde, hepsine yazar (eskiden üye başına sıralı, hata yutuluyordu).
 * - Satış geçmişi manuel siparişleri de sayar.
 */

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-detay-duzeltme-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

let db: typeof import("@/lib/prisma").prisma;
let patchProduct: typeof import("./[id]/route").PATCH;
let applyToVariants: typeof import("./[id]/apply-cost-to-variants/route").POST;
let salesGet: typeof import("./[id]/sales/route").GET;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const istek = (url: string, body?: unknown) =>
  new NextRequest(url, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
  ({ prisma: db } = await import("@/lib/prisma"));
  ({ PATCH: patchProduct } = await import("./[id]/route"));
  ({ POST: applyToVariants } = await import("./[id]/apply-cost-to-variants/route"));
  ({ GET: salesGet } = await import("./[id]/sales/route"));
  const { ensureRuntimeSchema } = await import("@/lib/runtime-schema");
  await ensureRuntimeSchema();

  await db.product.create({
    data: { id: "stoklu", barcode: "bc-stoklu", sku: "s1", name: "Stoklu", categoryName: "Dekor", currentSalePrice: 100, stock: 5 },
  });
  const grup = await db.variantGroup.create({ data: { name: "Vazo" } });
  for (const [i, renk] of ["Mavi", "Mor", "Sarı"].entries()) {
    await db.product.create({
      data: {
        id: `v${i}`,
        barcode: `bc-v${i}`,
        sku: `v${i}`,
        name: `Vazo ${renk}`,
        categoryName: "Dekor",
        currentSalePrice: 200,
        variantGroupId: grup.id,
        variantLabel: renk,
        // Biri zaten maliyetli: güncellenmeli; diğer ikisi yeni oluşturulmalı.
        ...(i === 0 ? { cost: { create: { costMode: "manual", manualCost: 10, totalCost: 10 } } } : {}),
      },
    });
  }
});

afterAll(async () => {
  await db?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

const fark = async (id: string, stockDelta: number) => {
  const r = await patchProduct(
    new NextRequest(`http://localhost/api/products/${id}`, { method: "PATCH", body: JSON.stringify({ stockDelta }) }),
    ctx(id)
  );
  return { status: r.status, govde: (await r.json()) as { stock?: number; error?: string } };
};

describe("atomik stok farkı", () => {
  it("farkı mevcut stoğun üstüne yazar ve güncel stoğu döner", async () => {
    const r = await fark("stoklu", -1);
    expect(r.status).toBe(200);
    expect(r.govde.stock).toBe(4);
  });

  it("arada başka cihaz stoğu değiştirdiyse onun değişikliği KORUNUR", async () => {
    await db.product.update({ where: { id: "stoklu" }, data: { stock: 2 } }); // telefon: 4 → 2
    const r = await fark("stoklu", 1); // masaüstü +1 (ekranda eski 4 görünse bile)
    expect(r.govde.stock).toBe(3); // mutlak yazılsaydı 5 olurdu, telefonun −2'si kaybolurdu
  });

  it("stok eksiye düşmez; geçersiz fark reddedilir", async () => {
    expect((await fark("stoklu", -50)).govde.stock).toBe(0);
    expect((await fark("stoklu", 1.5)).status).toBe(400);
  });
});

describe("maliyeti tüm varyantlara uygula", () => {
  it("tek işlemde hepsine yazar: var olan güncellenir, olmayan oluşturulur, desi de", async () => {
    const r = await applyToVariants(
      istek("http://localhost/api/products/v1/apply-cost-to-variants", {
        cost: { costMode: "manual", manualCost: 55, totalCost: 55 },
        desi: 3,
      }),
      ctx("v1")
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as { count: number }).count).toBe(3);
    const maliyetler = await db.productCost.findMany({ where: { productId: { in: ["v0", "v1", "v2"] } } });
    expect(maliyetler).toHaveLength(3);
    expect(maliyetler.every((m) => m.manualCost === 55)).toBe(true);
    const desiler = await db.product.findMany({ where: { id: { in: ["v0", "v1", "v2"] } }, select: { desi: true } });
    expect(desiler.every((p) => p.desi === 3)).toBe(true);
  });
});

describe("satış geçmişi", () => {
  it("manuel siparişteki bu ürünün adetlerini sayar, başka ürünü saymaz, iptali saymaz", async () => {
    const ortak = {
      mode: "catalog",
      revenueKurus: 1000,
      netRevenueKurus: 1000,
      totalCostKurus: 500,
      inputVatCreditKurus: 0,
      breakdownJson: "{}",
    };
    const kalemler = (productId: string, quantity: number) =>
      JSON.stringify({ version: 1, items: [{ id: "k1", productId, name: "x", imageUrl: null, quantity, costKnown: true, productionCost: 1, packagingCost: 0, filamentCost: 0 }] });
    await db.manualOrder.create({ data: { ...ortak, orderNumber: "M-1", orderedAt: new Date(), itemsJson: kalemler("stoklu", 2) } });
    await db.manualOrder.create({ data: { ...ortak, orderNumber: "M-2", orderedAt: new Date(), itemsJson: kalemler("v0", 7) } });
    await db.manualOrder.create({
      data: { ...ortak, orderNumber: "M-3", orderedAt: new Date(), statusKind: "cancelled", itemsJson: kalemler("stoklu", 9) },
    });

    const r = await salesGet(new NextRequest("http://localhost/api/products/stoklu/sales"), ctx("stoklu"));
    expect(r.status).toBe(200);
    const ozet = (await r.json()) as { aylar: Array<{ adet: Record<string, number> }> };
    const manuelToplam = ozet.aylar.reduce((t, a) => t + (a.adet.manual ?? 0), 0);
    expect(manuelToplam).toBe(2);
  });
});
