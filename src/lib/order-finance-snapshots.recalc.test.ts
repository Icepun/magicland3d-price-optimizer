/**
 * "Bu ayı yeniden hesapla" sözleşmesi — gerçek SQLite üzerinde davranış testi.
 *
 * Yakalanmış kâr bilerek dondurulur (geçmiş ay kendiliğinden kaymasın). Ama kullanıcı maliyeti
 * DÜZELTTİĞİNDE Siparişler ekranı yeni rakamı gösterirken Raporlar eskisinde kalıyordu ve bunu
 * düzeltmenin hiçbir yolu yoktu. Bu testler yeniden hesabın:
 *   • rakamı gerçekten güncellediğini (ÖNCE/SONRA farkıyla),
 *   • ikinci kez çalışınca HİÇBİR ŞEY yazmadığını (idempotent),
 *   • manuel siparişe ve başka ayın siparişine dokunmadığını
 * kilitler.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FinanceSnapshotOrder } from "./order-finance-snapshots";

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-recalc-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

let persist: typeof import("./order-finance-snapshots").persistOrderFinanceSnapshots;
let recalculate: typeof import("./order-finance-snapshots").recalculateFinanceMonth;
let startRecalc: typeof import("./order-finance-snapshots").startFinanceMonthRecalc;
let flushRecalc: typeof import("./order-finance-snapshots").flushFinanceMonthRecalc;
let recalcState: typeof import("./order-finance-snapshots").financeRecalcState;
let db: typeof import("@/lib/prisma").prisma;

const MONTH = "2026-07";
const ORDERED_AT = "2026-07-10T09:00:00.000Z";
const PRODUCT_ID = "p-recalc-1";

function order(overrides: Partial<FinanceSnapshotOrder> = {}): FinanceSnapshotOrder {
  return {
    platform: "trendyol",
    id: "ty-r1",
    orderNumber: "R1",
    date: ORDERED_AT,
    total: 300,
    profit: 100,
    profitPartial: false,
    profitSource: "calculated",
    estimatedCommission: 0,
    actualCommission: null,
    statusKind: "delivered",
    currency: "TRY",
    ...overrides,
  };
}

async function snapshotOf(externalOrderId: string) {
  const row = await db.orderFinanceSnapshot.findFirst({ where: { externalOrderId } });
  return row!;
}

/** Ürünün maliyetini değiştir — yeniden hesabın okuyacağı GÜNCEL kaynak burasıdır. */
async function setProductCost(amount: number): Promise<void> {
  await db.productCost.update({
    where: { productId: PRODUCT_ID },
    data: { manualCost: amount, totalCost: amount },
  });
}

beforeAll(async () => {
  const { ensureRuntimeSchema } = await import("./runtime-schema");
  ({
    persistOrderFinanceSnapshots: persist,
    recalculateFinanceMonth: recalculate,
    startFinanceMonthRecalc: startRecalc,
    flushFinanceMonthRecalc: flushRecalc,
    financeRecalcState: recalcState,
  } = await import("./order-finance-snapshots"));
  ({ prisma: db } = await import("@/lib/prisma"));
  await ensureRuntimeSchema();

  // KDV oranı açıkça yazılır: "ayar yok" hâli varsayılana düşer ve test niyeti bulanıklaşır.
  await db.appSetting.create({ data: { key: "vatRate", value: "20" } });
  await db.product.create({
    data: {
      id: PRODUCT_ID,
      barcode: "RECALC-1",
      sku: "RECALC-1",
      name: "Kedi Figürü",
      categoryName: "Dekorasyon",
      currentSalePrice: 300,
      desi: 1,
    },
  });
  await db.productCost.create({
    data: { productId: PRODUCT_ID, costMode: "manual", manualCost: 40, totalCost: 40 },
  });

  // Kalıcı geçmiş: sipariş özeti + kalemleri (yeniden hesabın tek girdisi).
  await persist(
    [order()],
    new Map([
      [
        "ty-r1",
        [{ productId: PRODUCT_ID, productName: "Kedi Figürü", quantity: 1, unitPrice: 300 }],
      ],
    ])
  );
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("recalculateFinanceMonth — maliyet düzeltmesi geçmiş aya yansır", () => {
  let profitWithCheapCost = 0;

  it("normal yenileme yakalanmış kârı KORUR (donmuş davranış aynen duruyor)", async () => {
    await persist([order({ profit: 12.34 })]);
    const row = await snapshotOf("ty-r1");
    expect(row.profitKurus).toBe(10_000); // ilk yakalanan kâr yerinde
  });

  it("yeniden hesap kayıtlı kârı güncel maliyetle yeniden yazar", async () => {
    const result = await recalculate(MONTH);

    expect(result.totalOrders).toBe(1);
    expect(result.recalculatedOrders).toBe(1);
    expect(result.changedOrders).toBe(1);
    const row = await snapshotOf("ty-r1");
    expect(row.profitKurus).not.toBe(10_000); // ← donmuş rakam düzeldi
    expect(row.revenueKurus).toBe(30_000); // ciro yeniden hesapta DEĞİŞMEZ
    profitWithCheapCost = row.profitKurus!;
  });

  it("aynı verilerle ikinci kez çalışınca HİÇBİR ŞEY yazmaz (idempotent)", async () => {
    const before = (await snapshotOf("ty-r1")).syncedAt.getTime();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const result = await recalculate(MONTH);

    expect(result.changedOrders).toBe(0);
    expect(result.profitDeltaKurus).toBe(0);
    expect((await snapshotOf("ty-r1")).syncedAt.getTime()).toBe(before);
  });

  it("maliyet artınca ayın kârı DÜŞER ve fark bildirilir", async () => {
    await setProductCost(90);

    const result = await recalculate(MONTH);

    const after = (await snapshotOf("ty-r1")).profitKurus!;
    expect(after).toBeLessThan(profitWithCheapCost);
    expect(result.changedOrders).toBe(1);
    expect(result.profitDeltaKurus).toBe(after - profitWithCheapCost);
  });

  it("eski hesap sürümüyle yazılmış satırı güncel sürüme taşır", async () => {
    await db.$executeRawUnsafe(
      `UPDATE "OrderFinanceSnapshot" SET "calculationVersion" = 1 WHERE "externalOrderId" = ?`,
      "ty-r1"
    );

    const result = await recalculate(MONTH);

    expect(result.changedOrders).toBe(1);
    expect((await snapshotOf("ty-r1")).calculationVersion).toBe(2);
  });
});

describe("yeniden hesap kapsamı", () => {
  it("kalem bilgisi olmayan siparişe DOKUNMAZ", async () => {
    await persist([order({ id: "ty-r2", orderNumber: "R2", total: 150, profit: 55 })]);
    const before = await snapshotOf("ty-r2");
    await new Promise((resolve) => setTimeout(resolve, 30));

    const result = await recalculate(MONTH);

    const after = await snapshotOf("ty-r2");
    expect(result.skippedOrders).toBe(1);
    expect(after.profitKurus).toBe(5_500);
    expect(after.syncedAt.getTime()).toBe(before.syncedAt.getTime());
  });

  it("başka ayın siparişine DOKUNMAZ", async () => {
    await persist(
      [
        order({
          id: "ty-r3",
          orderNumber: "R3",
          date: "2026-06-12T09:00:00.000Z",
          total: 300,
          profit: 77,
        }),
      ],
      new Map([
        [
          "ty-r3",
          [{ productId: PRODUCT_ID, productName: "Kedi Figürü", quantity: 1, unitPrice: 300 }],
        ],
      ])
    );
    const before = await snapshotOf("ty-r3");
    await new Promise((resolve) => setTimeout(resolve, 30));

    await recalculate(MONTH);

    const after = await snapshotOf("ty-r3");
    expect(after.profitKurus).toBe(7_700);
    expect(after.syncedAt.getTime()).toBe(before.syncedAt.getTime());
  });

  it("manuel siparişin kendi kayıtlı finansına DOKUNMAZ", async () => {
    const manual = await db.manualOrder.create({
      data: {
        orderNumber: "M-1",
        mode: "catalog",
        orderedAt: new Date(ORDERED_AT),
        statusKind: "delivered",
        revenueKurus: 50_000,
        netRevenueKurus: 41_666,
        totalCostKurus: 20_000,
        inputVatCreditKurus: 3_333,
        profitKurus: 18_000,
        itemsJson: "{}",
        breakdownJson: "{}",
        calculationVersion: 1,
      },
    });

    await recalculate(MONTH);

    const after = await db.manualOrder.findUnique({ where: { id: manual.id } });
    expect(after!.profitKurus).toBe(18_000);
    expect(after!.updatedAt.getTime()).toBe(manual.updatedAt.getTime());
    // Manuel sipariş platform geçmişine de yazılmaz (aynı satış iki kez sayılmasın).
    expect(
      await db.orderFinanceSnapshot.findFirst({ where: { orderNumber: "M-1" } })
    ).toBeNull();
  });

  it("geçersiz ay isteğini reddeder", async () => {
    await expect(recalculate("2026-13")).rejects.toThrow();
  });
});

describe("arka plan turu ve ilerleme", () => {
  it("ilerlemeyi bildirir ve tur sonunda sonucu taşır", async () => {
    const phases: string[] = [];
    await recalculate(MONTH, (phase) => phases.push(phase));
    expect(phases[0]).toBe("reading");
    expect(phases).toContain("calculating");
    expect(phases.at(-1)).toBe("done");
  });

  it("çağıranı bekletmeden başlar ve durumu okunabilir kalır", async () => {
    const started = startRecalc(MONTH);
    expect(started.phase).toBe("reading");
    expect(started.month).toBe(MONTH);

    await flushRecalc();

    const state = recalcState();
    expect(state?.phase).toBe("done");
    expect(state?.result?.month).toBe(MONTH);
    expect(state?.finishedAt).toBeTruthy();
  });
});
