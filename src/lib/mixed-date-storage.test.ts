/**
 * KARIŞIK TİPLİ TARİH DEPOLAMASI — gerileme koruması.
 *
 * SQLite dinamik tiplidir: aynı DATETIME kolonuna hem epoch-ms TAMSAYI hem ISO METİN
 * yazılabilir ve SQLite'ta TAMSAYI her zaman METİN'den küçük sayılır. Sahada tam olarak bu
 * oldu: masaüstünün ham SQL yazımı `getTime()` (tamsayı), telefon ve Prisma ise ISO metin
 * yazıyordu. Sonuç: Raporlar 359 siparişin yalnız ~79'unu okuyor, "geçmiş şu tarihten beri"
 * yanlış tarih gösteriyordu. Hiçbir hata verilmiyordu.
 *
 * Bu dosya üç şeyi kilitler:
 *  1) Prisma'nın (libSQL adapter) kanonik yazma biçimi = ISO METİN, filtreleri de METİN bağlar.
 *  2) Karışık tipli veride düz `gte` filtresi satır DÜŞÜRÜR (hatanın kendisi kanıtlanır).
 *  3) `dbEpochMs()` ile normalize edilmiş okuma ve `repairDateColumnSql()` onarımı sonrası
 *     HİÇBİR satır düşmez, "en eski kayıt" doğru çıkar.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dbEpochMs,
  parseDbDate,
  repairDateColumnSql,
  toDbDate,
} from "./sqlite-date";
import { aggregateMonthlyFinance } from "./monthly-finance";

/** Bu dosya HER ZAMAN libSQL adapter'lı bir istemci kurar → kanonik biçim ISO metindir. */
const ISO = "iso-text" as const;

const SNAPSHOT_DDL = `
  CREATE TABLE "OrderFinanceSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "platform" TEXT NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "orderedAt" DATETIME NOT NULL,
    "revenueKurus" INTEGER NOT NULL,
    "profitKurus" INTEGER,
    "profitPartial" BOOLEAN NOT NULL DEFAULT false,
    "statusKind" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "calculationVersion" INTEGER NOT NULL DEFAULT 1,
    "profitSource" TEXT NOT NULL DEFAULT 'calculated',
    "estimatedCommissionKurus" INTEGER,
    "actualCommissionKurus" INTEGER,
    "outputVatKurus" INTEGER,
    "inputVatCreditKurus" INTEGER
  )`;

/** Test siparişleri: yarısı ESKİ biçimde (tamsayı), yarısı kanonik biçimde (ISO metin). */
const ORDERS = [
  { id: "eski-1", at: "2026-05-24T09:00:00.000Z", raw: "int" },
  { id: "eski-2", at: "2026-06-12T09:00:00.000Z", raw: "int" },
  { id: "eski-3", at: "2026-07-03T09:00:00.000Z", raw: "int" },
  { id: "yeni-1", at: "2026-06-20T09:00:00.000Z", raw: "text" },
  { id: "yeni-2", at: "2026-07-18T09:00:00.000Z", raw: "text" },
] as const;

async function withDb<T>(run: (db: TestDb) => Promise<T>): Promise<T> {
  const { PrismaLibSQL } = await import("@prisma/adapter-libsql");
  const { PrismaClient } = await import("@/generated/prisma/client");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mixed-date-"));
  const db = new PrismaClient({
    adapter: new PrismaLibSQL({ url: `file:${path.join(dir, "t.db")}` }),
  });
  try {
    await db.$executeRawUnsafe(SNAPSHOT_DDL);
    for (const order of ORDERS) {
      const date = new Date(order.at);
      await db.$executeRawUnsafe(
        `INSERT INTO "OrderFinanceSnapshot"
           ("id","platform","externalOrderId","orderNumber","orderedAt","revenueKurus",
            "profitKurus","statusKind","currency","syncedAt","outputVatKurus","inputVatCreditKurus")
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        order.id,
        "trendyol",
        order.id,
        order.id,
        order.raw === "int" ? date.getTime() : toDbDate(date, ISO),
        10_000,
        4_000,
        "delivered",
        "TRY",
        order.raw === "int" ? date.getTime() : toDbDate(date, ISO),
        1_667,
        500
      );
    }
    return await run(db as unknown as TestDb);
  } finally {
    await db.$disconnect();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows dosyayı kilitli tutabilir; temizlik testi düşürmesin */
    }
  }
}

type TestDb = {
  $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T>;
  $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number>;
  orderFinanceSnapshot: {
    findMany: (args?: unknown) => Promise<Array<{ externalOrderId: string; orderedAt: Date }>>;
    findFirst: (args?: unknown) => Promise<{ externalOrderId: string; orderedAt: Date } | null>;
    create: (args: unknown) => Promise<unknown>;
  };
};

const WINDOW_START = new Date("2026-01-01T00:00:00.000Z");

describe("karışık tipli tarih kolonu", () => {
  it("Prisma (libSQL adapter) tarihleri ISO METİN yazar — toDbDate ile BİREBİR aynı", async () => {
    await withDb(async (db) => {
      await db.orderFinanceSnapshot.create({
        data: {
          id: "prisma",
          platform: "trendyol",
          externalOrderId: "prisma",
          orderNumber: "prisma",
          orderedAt: new Date("2026-07-15T10:00:00.000Z"),
          revenueKurus: 1,
          statusKind: "delivered",
          syncedAt: new Date("2026-07-15T10:00:00.000Z"),
        },
      });
      // Depolama tipi metin (tamsayı DEĞİL) ve içerik `toDbDate()` ile birebir aynı biçim.
      const rows = await db.$queryRawUnsafe<Array<{ t: string; ham: string }>>(
        `SELECT typeof("orderedAt") t, CAST("orderedAt" AS TEXT) ham
           FROM "OrderFinanceSnapshot" WHERE "id" = 'prisma'`
      );
      expect(rows[0].t).toBe("text");
      expect(rows[0].ham).toBe(toDbDate(new Date("2026-07-15T10:00:00.000Z"), ISO));
    });
  }, 60_000);

  it("HATANIN KANITI: düz gte filtresi tamsayı satırları sessizce eler", async () => {
    await withDb(async (db) => {
      const found = await db.orderFinanceSnapshot.findMany({
        where: { orderedAt: { gte: WINDOW_START } },
        select: { externalOrderId: true, orderedAt: true },
      });
      // Beş siparişin yalnız ISO metin yazılmış ikisi görünür. Hata mesajı YOK.
      expect(found.map((row) => row.externalOrderId).sort()).toEqual(["yeni-1", "yeni-2"]);

      // Aynı sebeple "en eski sipariş" de yanlış: sıralama önce tamsayıları getirir.
      const first = await db.orderFinanceSnapshot.findFirst({
        orderBy: { orderedAt: "asc" },
        select: { externalOrderId: true, orderedAt: true },
      });
      expect(first?.externalOrderId).toBe("eski-1");
    });
  }, 60_000);

  it("normalize okuma karışık veride HİÇBİR satırı düşürmez", async () => {
    await withDb(async (db) => {
      const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT "externalOrderId","orderedAt" FROM "OrderFinanceSnapshot"
          WHERE ${dbEpochMs("orderedAt")} >= ?`,
        WINDOW_START.getTime()
      );
      expect(rows.map((row) => String(row.externalOrderId)).sort()).toEqual(
        ORDERS.map((order) => order.id).sort()
      );
      // Çözülen anlar da doğru (tamsayı ve metin aynı anı verir).
      for (const row of rows) {
        const expected = ORDERS.find((order) => order.id === String(row.externalOrderId))!;
        expect(parseDbDate(row.orderedAt)?.toISOString()).toBe(expected.at);
      }

      const bounds = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT MIN(${dbEpochMs("orderedAt")}) AS "oldest",
                MAX(${dbEpochMs("syncedAt")})  AS "latest"
           FROM "OrderFinanceSnapshot"`
      );
      expect(parseDbDate(bounds[0].oldest)?.toISOString()).toBe("2026-05-24T09:00:00.000Z");
      expect(parseDbDate(bounds[0].latest)?.toISOString()).toBe("2026-07-18T09:00:00.000Z");
    });
  }, 60_000);

  it("onarım göçü sonrası tek biçim kalır ve düz Prisma sorgusu da tam sonuç verir", async () => {
    await withDb(async (db) => {
      await db.$executeRawUnsafe(repairDateColumnSql("OrderFinanceSnapshot", "orderedAt", ISO));
      await db.$executeRawUnsafe(repairDateColumnSql("OrderFinanceSnapshot", "syncedAt", ISO));

      const types = await db.$queryRawUnsafe<Array<{ t: string; n: number | bigint }>>(
        `SELECT typeof("orderedAt") t, COUNT(*) n FROM "OrderFinanceSnapshot" GROUP BY 1`
      );
      expect(types.map((row) => row.t)).toEqual(["text"]);

      const found = await db.orderFinanceSnapshot.findMany({
        where: { orderedAt: { gte: WINDOW_START } },
        select: { externalOrderId: true, orderedAt: true },
      });
      expect(found.map((row) => row.externalOrderId).sort()).toEqual(
        ORDERS.map((order) => order.id).sort()
      );

      const first = await db.orderFinanceSnapshot.findFirst({
        orderBy: { orderedAt: "asc" },
        select: { externalOrderId: true, orderedAt: true },
      });
      expect(first?.externalOrderId).toBe("eski-1");

      // Onarım anı DEĞİŞTİRMEZ (milisaniye dahil birebir).
      for (const row of found) {
        const expected = ORDERS.find((order) => order.id === row.externalOrderId)!;
        expect(row.orderedAt.toISOString()).toBe(expected.at);
      }
    });
  }, 60_000);

  it("onarım idempotenttir — ikinci kez çalışınca hiçbir şey değişmez", async () => {
    await withDb(async (db) => {
      const sql = repairDateColumnSql("OrderFinanceSnapshot", "orderedAt", ISO);
      await db.$executeRawUnsafe(sql);
      const before = await db.$queryRawUnsafe<Array<{ v: string }>>(
        `SELECT "orderedAt" v FROM "OrderFinanceSnapshot" ORDER BY "id"`
      );
      await db.$executeRawUnsafe(sql);
      const after = await db.$queryRawUnsafe<Array<{ v: string }>>(
        `SELECT "orderedAt" v FROM "OrderFinanceSnapshot" ORDER BY "id"`
      );
      expect(after).toEqual(before);
    });
  }, 60_000);

  it("aylık toplama karışık veride tam ciroyu üretir (uçtan uca)", async () => {
    await withDb(async (db) => {
      const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT "platform","orderedAt","revenueKurus","profitKurus","profitPartial",
                "statusKind","currency","outputVatKurus","inputVatCreditKurus"
           FROM "OrderFinanceSnapshot"
          WHERE "platform" <> 'manual' AND ${dbEpochMs("orderedAt")} >= ?`,
        WINDOW_START.getTime()
      );
      const months = aggregateMonthlyFinance({
        snapshots: rows.map((row) => ({
          platform: String(row.platform),
          orderedAt: parseDbDate(row.orderedAt)!,
          revenueKurus: Number(row.revenueKurus),
          profitKurus: row.profitKurus == null ? null : Number(row.profitKurus),
          profitPartial: Boolean(Number(row.profitPartial)),
          statusKind: String(row.statusKind),
          currency: String(row.currency),
          outputVatKurus: row.outputVatKurus == null ? null : Number(row.outputVatKurus),
          inputVatCreditKurus:
            row.inputVatCreditKurus == null ? null : Number(row.inputVatCreditKurus),
        })),
        expenses: [],
        monthCount: 12,
        now: new Date("2026-08-12T12:00:00.000Z"),
      });
      const total = months.reduce((sum, month) => sum + month.orderCount, 0);
      const revenue = months.reduce((sum, month) => sum + month.revenue, 0);
      expect(total).toBe(ORDERS.length);
      expect(revenue).toBe(ORDERS.length * 100);
    });
  }, 60_000);
});

describe("parseDbDate", () => {
  it("her depolama biçimini aynı ana çözer", () => {
    const iso = "2026-05-24T09:00:00.000Z";
    const ms = Date.parse(iso);
    expect(parseDbDate(iso)?.toISOString()).toBe(iso);
    // Kanonik yazma biçimi (Prisma'nınkiyle aynı) da aynı ana çözülür.
    expect(parseDbDate(toDbDate(new Date(iso), ISO))?.toISOString()).toBe(iso);
    expect(toDbDate(new Date(iso), ISO)).toBe("2026-05-24T09:00:00.000+00:00");
    expect(toDbDate(new Date(iso), "epoch-ms")).toBe(ms);
    expect(parseDbDate(ms)?.toISOString()).toBe(iso);
    expect(parseDbDate(BigInt(ms))?.toISOString()).toBe(iso);
    expect(parseDbDate(String(ms))?.toISOString()).toBe(iso);
    expect(parseDbDate(Math.floor(ms / 1000))?.toISOString()).toBe(iso);
    // SQLite CURRENT_TIMESTAMP biçimi UTC'dir — yerel saat sanılmamalı.
    expect(parseDbDate("2026-05-24 09:00:00")?.toISOString()).toBe(iso);
    expect(parseDbDate(null)).toBeNull();
    expect(parseDbDate("")).toBeNull();
    expect(parseDbDate("ne bu")).toBeNull();
  });
});
