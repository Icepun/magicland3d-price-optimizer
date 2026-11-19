/**
 * EŞİTLİK: Trendyol komisyon kayıtları eskiden Prisma `upsert` ile TEK TEK, şimdi tek istekte
 * (`batchWrite`) yazılıyor. Yazılan satırlar — kimlik, tutarlar, tarih biçimi dahil — eskisiyle
 * birebir aynı olmalı. Testler ÜRETİM biçiminde (libSQL adapter, ISO metin tarih) koşar.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TrendyolCommissionAggregate } from "./trendyol-finance";

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-komisyon-yazma-"));
const dbFile = path.join(tempDir, "komisyon.db").split(path.sep).join("/");
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.DATABASE_URL = `file:${dbFile}`;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.TURSO_REPLICA_PATH;

let db: typeof import("@/lib/prisma").prisma;
let mod: typeof import("./trendyol-finance");

beforeAll(async () => {
  const { ensureRuntimeSchema } = await import("./runtime-schema");
  ({ prisma: db } = await import("@/lib/prisma"));
  mod = await import("./trendyol-finance");
  await ensureRuntimeSchema();
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows dosyayı geç bırakabilir */ }
});

beforeEach(async () => {
  await db.$executeRawUnsafe(`DELETE FROM "PlatformOrderFinancial"`);
});

const toplam = (no: string, ek: Partial<TrendyolCommissionAggregate> = {}): TrendyolCommissionAggregate => ({
  externalOrderId: `ty-${no}`,
  orderNumber: no,
  grossRevenue: 499.99,
  commission: 107.43,
  sellerRevenue: 392.56,
  transactionCount: 2,
  sourceUpdatedAt: new Date("2026-11-18T09:15:30.123Z"),
  ...ek,
});

async function tablo() {
  return db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT "id","platform","externalOrderId","orderNumber","grossRevenueKurus","commissionKurus",
            "sellerRevenueKurus","transactionCount","sourceUpdatedAt","syncedAt", typeof("syncedAt") AS "tur"
       FROM "PlatformOrderFinancial" ORDER BY "externalOrderId"`
  );
}

const VERI = [
  toplam("100"),
  toplam("101", { grossRevenue: 0.01, commission: 0, sellerRevenue: 0.01, transactionCount: 1, sourceUpdatedAt: null }),
  toplam("102", { grossRevenue: 1234.565, commission: 265.4, sellerRevenue: 969.165, orderNumber: "Ç-102" }),
];
const SYNC = new Date("2026-11-19T15:00:00.000Z");

describe("komisyon kayıtları: tek istek = eski tek tek yazma", () => {
  it("yeni satırlar birebir aynı", async () => {
    await mod.komisyonKayitlariniPrismaIleYaz(VERI, SYNC);
    const eski = await tablo();
    await db.$executeRawUnsafe(`DELETE FROM "PlatformOrderFinancial"`);
    await mod.komisyonKayitlariniYaz(VERI, SYNC);
    const yeni = await tablo();
    expect(yeni).toEqual(eski);
    expect(yeni).toHaveLength(3);
    expect(String(yeni[0].syncedAt)).toBe(String(eski[0].syncedAt));
  });

  it("var olan satırların güncellenmesi birebir aynı (kimlik korunur)", async () => {
    const guncel = VERI.map((v) => ({ ...v, commission: v.commission + 1, transactionCount: v.transactionCount + 1 }));
    const SONRA = new Date("2026-11-19T16:30:00.000Z");
    // Eski bir sürümün farklı kimlikle yazdığı satır: güncellemede kimlik DEĞİŞMEMELİ.
    const kur = async () => {
      await mod.komisyonKayitlariniPrismaIleYaz(VERI, SYNC);
      await db.$executeRawUnsafe(`UPDATE "PlatformOrderFinancial" SET "id" = 'eski-cuid-1' WHERE "externalOrderId" = 'ty-100'`);
    };
    await kur();
    await mod.komisyonKayitlariniPrismaIleYaz(guncel, SONRA);
    const eski = await tablo();
    await db.$executeRawUnsafe(`DELETE FROM "PlatformOrderFinancial"`);
    await kur();
    await mod.komisyonKayitlariniYaz(guncel, SONRA);
    const yeni = await tablo();
    expect(yeni).toEqual(eski);
    expect(yeni.find((r) => r.externalOrderId === "ty-100")?.id).toBe("eski-cuid-1");
  });

  it("tek istekte gerçekten tek ifade listesi üretilir ve boş girdi yazmaz", async () => {
    expect(mod.komisyonYazmaIfadeleri(VERI, SYNC)).toHaveLength(3);
    await mod.komisyonKayitlariniYaz([], SYNC);
    expect(await tablo()).toEqual([]);
  });
});
