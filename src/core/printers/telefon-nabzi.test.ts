import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";

const sorgu = vi.fn<(sql: string, ...args: unknown[]) => Promise<Record<string, unknown>[]>>();
vi.mock("@/lib/prisma", () => ({ remotePrisma: { $queryRawUnsafe: (sql: string, ...a: unknown[]) => sorgu(sql, ...a) } }));

import { nabizDinle, nabizSifirla, nabizSonAt, nabizSql, nabizTuru, telefonNabziOku } from "./telefon-nabzi";

const bekle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  sorgu.mockReset();
  nabizSifirla();
  delete (globalThis as { __MLHUB_DB_PAUSED__?: boolean }).__MLHUB_DB_PAUSED__;
});

/**
 * Üç ayrı "telefondan iş var mı" yoklaması tek sorguya indi (19 Kas 2026). Buradaki testler iki
 * şeyi kilitler: iş YOKKEN ayrıntı sorguları çalışmaz; nabız BOZULURSA hiçbir iş sahipsiz kalmaz.
 */
describe("telefon nabzı", () => {
  it("tek sorguyla üç sayımı okur ve bütün dinleyicilere dağıtır", async () => {
    sorgu.mockResolvedValue([{ kamera: BigInt(1), etiket: 0, komut: 2 }]);
    const gelen: unknown[] = [];
    nabizDinle("kamera", (n) => void gelen.push(["kamera", n]));
    nabizDinle("komut", (n) => void gelen.push(["komut", n]));
    await nabizTuru();
    await bekle();
    expect(sorgu).toHaveBeenCalledTimes(1);
    expect(gelen).toEqual([
      ["kamera", { kamera: 1, etiket: 0, komut: 2 }],
      ["komut", { kamera: 1, etiket: 0, komut: 2 }],
    ]);
    expect(nabizSonAt()).toBeGreaterThan(0);
  });

  it("sayım okunamazsa dinleyicilere null gider — her iş kendi sorgusuna döner", async () => {
    sorgu.mockRejectedValue(new Error("no such table: PrinterCamera"));
    const gelen: unknown[] = [];
    nabizDinle("etiket", (n) => void gelen.push(n));
    await nabizTuru();
    await bekle();
    expect(gelen).toEqual([null]);
    expect(nabizSonAt(), "okunamayan tur da 'nabız yaşıyor' sayılır").toBeGreaterThan(0);
  });

  it("uzun süren ya da hata veren bir dinleyici diğerlerini ve sonraki turu engellemez", async () => {
    sorgu.mockResolvedValue([{ kamera: 0, etiket: 1, komut: 1 }]);
    let komutCagri = 0;
    nabizDinle("etiket", () => new Promise<void>(() => {})); // hiç bitmeyen etiket basımı
    nabizDinle("bozuk", () => {
      throw new Error("dinleyici patladı");
    });
    nabizDinle("bozuk-async", async () => {
      throw new Error("dinleyici reddetti");
    });
    nabizDinle("komut", () => void komutCagri++);
    await nabizTuru();
    await nabizTuru();
    await bekle();
    expect(komutCagri).toBe(2);
  });

  it("uyku/askı korumasındayken veritabanına dokunmaz", async () => {
    (globalThis as { __MLHUB_DB_PAUSED__?: boolean }).__MLHUB_DB_PAUSED__ = true;
    const dinleyici = vi.fn();
    nabizDinle("kamera", dinleyici);
    await nabizTuru();
    expect(sorgu).not.toHaveBeenCalled();
    expect(dinleyici).not.toHaveBeenCalled();
  });

  it("önceki tur bitmeden ikinci tur başlamaz (yavaş ağda sorgu birikmez)", async () => {
    let coz: (v: Record<string, unknown>[]) => void = () => {};
    sorgu.mockImplementation(() => new Promise((r) => (coz = r)));
    const ilk = nabizTuru();
    await nabizTuru(); // atlanır
    expect(sorgu).toHaveBeenCalledTimes(1);
    coz([{ kamera: 0, etiket: 0, komut: 0 }]);
    await ilk;
  });
});

describe("nabız sorgusu gerçek tablolarda doğru sayar", () => {
  const klasor = mkdtempSync(path.join(tmpdir(), "magicland-nabiz-test-"));
  let db: Client;
  afterAll(() => {
    try { db?.close(); } catch { /* zaten kapalı */ }
    try { rmSync(klasor, { recursive: true, force: true }); } catch { /* Windows dosyayı geç bırakabilir */ }
  });

  it("süresi dolmuş kamera isteğini ve işlenmiş etiket/komutu saymaz", async () => {
    db = createClient({ url: `file:${path.join(klasor, "nabiz.db").replace(/\\/g, "/")}` });
    await db.batch([
      `CREATE TABLE "PrinterCamera" ("printerConfigId" TEXT PRIMARY KEY, "wantedUntilMs" REAL NOT NULL DEFAULT 0, "owner" TEXT, "ownerAtMs" REAL, "error" TEXT)`,
      `CREATE TABLE "LabelPrintRequest" ("id" TEXT PRIMARY KEY, "status" TEXT NOT NULL, "createdAtMs" REAL NOT NULL)`,
      `CREATE TABLE "PrintCommand" ("id" TEXT PRIMARY KEY, "status" TEXT NOT NULL)`,
      `INSERT INTO "PrinterCamera" ("printerConfigId", "wantedUntilMs") VALUES ('a', 2000), ('b', 500), ('c', 1001)`,
      `INSERT INTO "LabelPrintRequest" VALUES ('1', 'pending', 1), ('2', 'done', 1), ('3', 'error', 1), ('4', 'pending', 1), ('5', 'running', 1)`,
      `INSERT INTO "PrintCommand" VALUES ('1', 'done'), ('2', 'pending'), ('3', 'timeout')`,
    ], "write");
    sorgu.mockImplementation(async (sql, ...args) =>
      (await db.execute({ sql, args: args as never })).rows as unknown as Record<string, unknown>[]
    );
    expect(await telefonNabziOku(1000)).toEqual({ kamera: 2, etiket: 2, komut: 1 });
    expect(await telefonNabziOku(5000)).toEqual({ kamera: 0, etiket: 2, komut: 1 });
    expect(nabizSql()).toContain("?1");
  });
});
