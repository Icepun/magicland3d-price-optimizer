import { describe, it, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { PrismaLibSQL } from "@prisma/adapter-libsql";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * Açılış göçündeki SQL GERÇEKTEN çalışıyor mu?
 *
 * NEDEN: `normalizeDateColumns()` introspection sorgusu bir sürüm boyunca GEÇERSİZ SQL
 * üretti (`ESCAPE ''` — template literal içinde ters bölü kaçışı dizeyi bozuyordu).
 * Sorgu her açılışta patlayınca onarım "başarısız" sayıldı, o sürümde sürüm damgası da
 * başarıya bağlıydı → damga hiç yazılmadı → uygulama HER AÇILIŞTA tam şema göçünü baştan
 * koştu: ölçülen 205 saniye, Panel'in tüm kartları boş bekledi.
 *
 * `tsc` bunu yakalayamaz (dize içinde SQL). Bu yüzden sorgu gerçek libSQL üzerinde koşuyor.
 */
describe("normalizeDateColumns introspection SQL", () => {
  it("gerçek libSQL'de çalışır ve _ ile başlayan tabloları eler", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlprobe-"));
    const db = new PrismaClient({ adapter: new PrismaLibSQL({ url: `file:${path.join(dir, "t.db")}` }) });
    try {
      await db.$executeRawUnsafe(`CREATE TABLE "Ornek" ("id" TEXT PRIMARY KEY, "orderedAt" DATETIME, "ad" TEXT)`);
      await db.$executeRawUnsafe(`CREATE TABLE "_prisma_migrations" ("id" TEXT PRIMARY KEY, "started_at" DATETIME)`);
      await db.$executeRawUnsafe(`CREATE TABLE "Recommendation" ("id" TEXT PRIMARY KEY, "createdAt" DATETIME)`);

      const rows = await db.$queryRawUnsafe<Array<{ tbl: string; col: string }>>(
        `SELECT m.name AS tbl, p.name AS col
           FROM sqlite_master m
           JOIN pragma_table_info(m.name) p
          WHERE m.type = 'table'
            AND m.name NOT LIKE 'sqlite_%'
            AND substr(m.name, 1, 1) <> '_'
            AND m.name <> 'Recommendation'
            AND UPPER(p.type) = 'DATETIME'`
      );
      const tablolar = rows.map((r) => r.tbl);
      expect(tablolar).toContain("Ornek");
      expect(tablolar).not.toContain("_prisma_migrations");
      expect(tablolar).not.toContain("Recommendation");
      expect(rows.find((r) => r.tbl === "Ornek")?.col).toBe("orderedAt");
    } finally {
      await db.$disconnect();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows kilidi */ }
    }
  }, 60_000);
});
