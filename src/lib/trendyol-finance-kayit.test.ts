/**
 * Gerçek komisyonu KAYITLI kâra işleyen ham SQL — GERÇEK libSQL'de koşar.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tempDir = mkdtempSync(path.join(tmpdir(), "komisyon-kayit-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

let db: typeof import("@/lib/prisma").prisma;
let isle: typeof import("./trendyol-finance").gercekKomisyonlariKayitlaraIsle;

beforeAll(async () => {
  const { ensureRuntimeSchema } = await import("@/lib/runtime-schema");
  await ensureRuntimeSchema();
  ({ prisma: db } = await import("@/lib/prisma"));
  ({ gercekKomisyonlariKayitlaraIsle: isle } = await import("./trendyol-finance"));
});
afterAll(async () => {
  await db?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

async function kayit(
  id: string,
  over: { statusKind?: string; profitPartial?: number; actual?: number | null } = {}
) {
  const now = new Date().toISOString();
  await db.$executeRawUnsafe(
    `INSERT INTO "OrderFinanceSnapshot"
       ("id","platform","externalOrderId","orderNumber","orderedAt","revenueKurus","profitKurus",
        "profitPartial","statusKind","currency","syncedAt","calculationVersion","profitSource",
        "estimatedCommissionKurus","actualCommissionKurus","inputVatCreditKurus")
     VALUES (?, 'trendyol', ?, ?, ?, 25999, 10000, ?, ?, 'TRY', ?, 4, 'calculated', 3380, ?, 1000)`,
    `ofs:trendyol:${id}`,
    id,
    `no-${id}`,
    now,
    over.profitPartial ?? 0,
    over.statusKind ?? "delivered",
    now,
    over.actual ?? null
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "PlatformOrderFinancial"
       ("id","platform","externalOrderId","orderNumber","grossRevenueKurus","commissionKurus",
        "sellerRevenueKurus","transactionCount","syncedAt")
     VALUES (?, 'trendyol', ?, ?, 25999, 3640, 22359, 1, ?)`,
    `pof:trendyol:${id}`,
    id,
    `no-${id}`,
    now
  );
}

const oku = async (id: string) =>
  (
    await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT "profitKurus","actualCommissionKurus","profitSource","inputVatCreditKurus"
         FROM "OrderFinanceSnapshot" WHERE "externalOrderId" = ?`,
      id
    )
  )[0];

describe("gercekKomisyonlariKayitlaraIsle — gerçek libSQL", () => {
  it("bekleyen tam kârlı kayda farkı işler; iade/kısmi/işlenmiş kayda dokunmaz", async () => {
    await db.appSetting.upsert({
      where: { key: "vatRate" },
      create: { key: "vatRate", value: "20" },
      update: { value: "20" },
    });
    await kayit("ty-1");
    await kayit("ty-2", { statusKind: "cancelled" });
    await kayit("ty-3", { profitPartial: 1 });
    await kayit("ty-4", { actual: 3380 });

    expect(await isle()).toBe(1);

    expect(await oku("ty-1")).toMatchObject({
      profitKurus: 9783,
      actualCommissionKurus: 3640,
      profitSource: "platform",
      inputVatCreditKurus: 1043,
    });
    expect(await oku("ty-2")).toMatchObject({ profitKurus: 10000, actualCommissionKurus: null });
    expect(await oku("ty-3")).toMatchObject({ profitKurus: 10000, actualCommissionKurus: null });
    expect(await oku("ty-4")).toMatchObject({ profitKurus: 10000, actualCommissionKurus: 3380 });

    // İkinci tur bir şey bulmaz — fark iki kez işlenmez.
    expect(await isle()).toBe(0);
    expect((await oku("ty-1"))?.profitKurus).toBe(9783);
  });
});
