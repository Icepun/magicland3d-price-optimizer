/**
 * SİPARİŞTE KESİLEN KOMİSYON ORANI — kalıcı kalem geçmişi ve "yeniden hesapla".
 *
 * Sipariş kârı artık siparişin KENDİ oranıyla hesaplanıyor (core/order-commission.ts). Pazaryeri
 * penceresi kapandıktan sonra o oran bir daha alınamaz; bu yüzden kalemle birlikte saklanır ve
 * yeniden hesap onu geri okur. Gerçek SQLite üzerinde davranış testi (şema göçü dahil).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FinanceSnapshotItem, FinanceSnapshotOrder } from "./order-finance-snapshots";

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-komisyon-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

let persist: typeof import("./order-finance-snapshots").persistOrderFinanceSnapshots;
let recalculate: typeof import("./order-finance-snapshots").recalculateFinanceMonth;
let db: typeof import("@/lib/prisma").prisma;

const MONTH = "2026-11";
const ORDERED_AT = "2026-11-18T09:00:00.000Z";
const PRODUCT_ID = "p-komisyon-1";

function order(overrides: Partial<FinanceSnapshotOrder> = {}): FinanceSnapshotOrder {
  return {
    platform: "hepsiburada",
    id: "hb-k1",
    orderNumber: "K1",
    date: ORDERED_AT,
    total: 500,
    profit: 100,
    profitPartial: false,
    profitSource: "calculated",
    estimatedCommission: 110,
    actualCommission: null,
    statusKind: "delivered",
    currency: "TRY",
    ...overrides,
  };
}

function kalem(commissionRate?: number | null): Map<string, FinanceSnapshotItem[]> {
  return new Map([
    [
      "hb-k1",
      [{ productId: PRODUCT_ID, productName: "Vazo", quantity: 1, unitPrice: 500, commissionRate }],
    ],
  ]);
}

async function kalemSatiri(): Promise<{ oran: number | null; yazilma: unknown }> {
  const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT "commissionRate","syncedAt" FROM "OrderItemSnapshot" WHERE "externalOrderId" = ?`,
    "hb-k1"
  );
  const row = rows[0];
  return { oran: row.commissionRate == null ? null : Number(row.commissionRate), yazilma: row.syncedAt };
}

async function ozet() {
  return (await db.orderFinanceSnapshot.findFirst({ where: { externalOrderId: "hb-k1" } }))!;
}

beforeAll(async () => {
  const { ensureRuntimeSchema } = await import("./runtime-schema");
  ({ persistOrderFinanceSnapshots: persist, recalculateFinanceMonth: recalculate } = await import(
    "./order-finance-snapshots"
  ));
  ({ prisma: db } = await import("@/lib/prisma"));
  await ensureRuntimeSchema();

  await db.appSetting.create({ data: { key: "vatRate", value: "20" } });
  await db.product.create({
    data: {
      id: PRODUCT_ID, barcode: "KOM-1", sku: "KOM-1", name: "Vazo",
      categoryName: "Dekorasyon", currentSalePrice: 500, desi: 1,
    },
  });
  await db.productCost.create({
    data: { productId: PRODUCT_ID, costMode: "manual", manualCost: 100, totalCost: 100 },
  });
  // İlana elle girilen VARSAYILAN oran %22 (ürün eklenirken girilen).
  await db.listing.create({
    data: {
      id: "l-komisyon-1", productId: PRODUCT_ID, platform: "hepsiburada",
      salePrice: 500, commissionRate: 0.22, isActive: true,
    },
  });
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("kalem geçmişi — siparişte kesilen oran saklanır", () => {
  it("şema göçü kolonu eklemiş", async () => {
    const kolonlar = await db.$queryRawUnsafe<Array<{ name: string }>>(
      `PRAGMA table_info("OrderItemSnapshot")`
    );
    expect(kolonlar.map((k) => k.name)).toContain("commissionRate");
  });

  it("oran gelmeyen kalemde alan BOŞ kalır (sıfır uydurulmaz)", async () => {
    await persist([order()], kalem(undefined));
    expect((await kalemSatiri()).oran).toBeNull();
  });

  it("oran sonradan gelince kaleme yazılır", async () => {
    const r = await persist([order()], kalem(0.18));
    expect(r.itemWriteReasons.commissionRate).toBe(1);
    expect((await kalemSatiri()).oran).toBeCloseTo(0.18, 9);
  });

  it("aynı oranla tekrar gelince HİÇ yazmaz", async () => {
    const once = (await kalemSatiri()).yazilma;
    await new Promise((r) => setTimeout(r, 30));
    const r = await persist([order()], kalem(0.18));
    expect(r.writtenItems).toBe(0);
    expect((await kalemSatiri()).yazilma).toEqual(once);
  });

  it("oranı taşımayan bir çağrı kayıtlı oranı SİLMEZ ve yazım üretmez", async () => {
    for (const bos of [undefined, null]) {
      const r = await persist([order()], kalem(bos));
      expect(r.writtenItems).toBe(0);
      expect((await kalemSatiri()).oran).toBeCloseTo(0.18, 9);
    }
  });

  it("bozuk oran (yüzde olarak gelmiş 18, sıfır, negatif) kaleme yazılmaz", async () => {
    for (const bozuk of [18, 0, -0.2, Number.NaN]) {
      await persist([order()], kalem(bozuk));
      expect((await kalemSatiri()).oran).toBeCloseTo(0.18, 9);
    }
  });

  it("oran değişirse güncellenir", async () => {
    await persist([order()], kalem(0.15));
    expect((await kalemSatiri()).oran).toBeCloseTo(0.15, 9);
  });
});

describe("yeniden hesap — siparişin KENDİ oranını kullanır", () => {
  it("kayıtlı oran (%15) ilana elle girilen %22'nin yerine geçer", async () => {
    const sonuc = await recalculate(MONTH);
    expect(sonuc.recalculatedOrders).toBe(1);
    const row = await ozet();
    expect(row.estimatedCommissionKurus).toBe(7_500); // 500 × %15
  });

  it("ilandaki varsayılan oran sonradan değişse de o siparişin komisyonu OYNAMAZ", async () => {
    const once = (await ozet()).profitKurus;
    await db.listing.update({ where: { id: "l-komisyon-1" }, data: { commissionRate: 0.3 } });
    const sonuc = await recalculate(MONTH);
    expect(sonuc.changedOrders).toBe(0);
    const row = await ozet();
    expect(row.estimatedCommissionKurus).toBe(7_500);
    expect(row.profitKurus).toBe(once);
  });

  it("oranı kayıtlı OLMAYAN eski kalem ilanın bugünkü varsayılan oranına düşer (eski davranış)", async () => {
    await db.$executeRawUnsafe(
      `UPDATE "OrderItemSnapshot" SET "commissionRate" = NULL WHERE "externalOrderId" = ?`,
      "hb-k1"
    );
    await recalculate(MONTH);
    // Hepsiburada'da ilana girilen oran KDV HARİÇTİR → kesilen 500 × %30 × 1,2 = 180.
    expect((await ozet()).estimatedCommissionKurus).toBe(18_000);
  });
});
