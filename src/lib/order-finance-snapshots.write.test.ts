/**
 * Faz A regresyon testi: snapshot yazımı DEĞİŞEN-ONLY olmalı.
 *
 * Eskiden her sipariş yenilemesi 180 satırın tamamını yeniden yazıyordu (~190 ardışık uzak
 * ifade ≈ 18sn) ve libSQL adapter'ın süreç genelindeki tek kilidini o süre boyunca tutuyordu.
 * Bu test, değişmemiş satırlara HİÇ yazılmadığını `syncedAt` damgasının sabit kalmasıyla
 * kanıtlar — mock değil, gerçek SQLite üzerinde davranış testi.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FinanceSnapshotOrder } from "./order-finance-snapshots";

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-snapshot-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

let persist: typeof import("./order-finance-snapshots").persistOrderFinanceSnapshots;
let db: typeof import("@/lib/prisma").prisma;

function order(overrides: Partial<FinanceSnapshotOrder> = {}): FinanceSnapshotOrder {
  return {
    platform: "trendyol",
    id: "ty-1001",
    orderNumber: "1001",
    date: "2026-07-01T10:00:00.000Z",
    total: 249.99,
    profit: 65.25,
    profitPartial: false,
    profitSource: "calculated",
    estimatedCommission: 35,
    actualCommission: null,
    statusKind: "delivered",
    currency: "TRY",
    ...overrides,
  };
}

async function syncedAtOf(externalOrderId: string): Promise<number | null> {
  const row = await db.orderFinanceSnapshot.findFirst({
    where: { externalOrderId },
    select: { syncedAt: true },
  });
  return row ? row.syncedAt.getTime() : null;
}

beforeAll(async () => {
  const { ensureRuntimeSchema } = await import("./runtime-schema");
  ({ persistOrderFinanceSnapshots: persist } = await import("./order-finance-snapshots"));
  ({ prisma: db } = await import("@/lib/prisma"));
  await ensureRuntimeSchema();
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("persistOrderFinanceSnapshots — değişen-only yazma", () => {
  it("ilk çağrıda satırı oluşturur", async () => {
    await persist([order()]);
    const row = await db.orderFinanceSnapshot.findFirst({
      where: { externalOrderId: "ty-1001" },
    });
    expect(row).not.toBeNull();
    expect(row!.revenueKurus).toBe(24_999);
    expect(row!.profitKurus).toBe(6_525);
  });

  it("AYNI veriyle tekrar çağrılınca satıra HİÇ yazmaz (syncedAt sabit kalır)", async () => {
    const before = await syncedAtOf("ty-1001");
    expect(before).not.toBeNull();

    await new Promise((r) => setTimeout(r, 30)); // damga değişebilseydi fark ederdik
    await persist([order()]);

    const after = await syncedAtOf("ty-1001");
    expect(after).toBe(before); // ← yazma olmadı
  });

  it("gelir değişince O satırı yazar", async () => {
    const before = await syncedAtOf("ty-1001");
    await new Promise((r) => setTimeout(r, 30));

    await persist([order({ total: 199.99, profit: 40 })]);

    const after = await syncedAtOf("ty-1001");
    expect(after).not.toBe(before); // ← yazma oldu
    const row = await db.orderFinanceSnapshot.findFirst({
      where: { externalOrderId: "ty-1001" },
    });
    expect(row!.revenueKurus).toBe(19_999);
  });

  it("çok siparişte YALNIZ değişeni yazar, diğerlerine dokunmaz", async () => {
    const a = order({ id: "ty-2001", orderNumber: "2001" });
    const b = order({ id: "ty-2002", orderNumber: "2002", total: 100, profit: 20 });
    const c = order({ id: "ty-2003", orderNumber: "2003", total: 300, profit: 90 });
    await persist([a, b, c]);

    const beforeA = await syncedAtOf("ty-2001");
    const beforeB = await syncedAtOf("ty-2002");
    const beforeC = await syncedAtOf("ty-2003");
    await new Promise((r) => setTimeout(r, 30));

    // Yalnız b değişti
    await persist([a, { ...b, total: 150, profit: 35 }, c]);

    expect(await syncedAtOf("ty-2001")).toBe(beforeA); // dokunulmadı
    expect(await syncedAtOf("ty-2003")).toBe(beforeC); // dokunulmadı
    expect(await syncedAtOf("ty-2002")).not.toBe(beforeB); // yazıldı
  });

  it("platform kaynaklı gerçek komisyon gelince yazar ve profitSource'u yükseltir", async () => {
    const base = order({ id: "ty-3001", orderNumber: "3001" });
    await persist([base]);
    const before = await syncedAtOf("ty-3001");
    await new Promise((r) => setTimeout(r, 30));

    await persist([
      { ...base, profit: 67.5, profitSource: "platform", actualCommission: 32.5 },
    ]);

    const row = await db.orderFinanceSnapshot.findFirst({
      where: { externalOrderId: "ty-3001" },
    });
    expect(await syncedAtOf("ty-3001")).not.toBe(before);
    expect(row!.profitSource).toBe("platform");
    expect(row!.actualCommissionKurus).toBe(3_250);
    expect(row!.profitKurus).toBe(6_750);
  });

  it("platform kârı yakalandıktan sonra AYNI veriyle tekrar yazmaz", async () => {
    const settled = order({
      id: "ty-3001",
      orderNumber: "3001",
      profit: 67.5,
      profitSource: "platform",
      actualCommission: 32.5,
    });
    const before = await syncedAtOf("ty-3001");
    await new Promise((r) => setTimeout(r, 30));

    await persist([settled]);

    expect(await syncedAtOf("ty-3001")).toBe(before); // ← idempotent
  });

  it("manuel siparişi ve tarihsizi yok sayar (çift sayım koruması)", async () => {
    await persist([
      order({ platform: "manual", id: "manual-9", orderNumber: "M9" }),
      order({ id: "ty-9999", orderNumber: "9999", date: null }),
    ]);
    expect(
      await db.orderFinanceSnapshot.findFirst({ where: { externalOrderId: "manual-9" } })
    ).toBeNull();
    expect(
      await db.orderFinanceSnapshot.findFirst({ where: { externalOrderId: "ty-9999" } })
    ).toBeNull();
  });
});
