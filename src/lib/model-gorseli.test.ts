/**
 * Önizleme görseli ayrı tabloda (v63) — taşıma SQL'i GERÇEK libSQL motorunda denenir
 * (bellek: göç SQL'ini gerçek motorda test et; sahte istemci ON CONFLICT/ typeof davranışını bilmez).
 * Ayrıca kaynak taraması: görsel model dosyası satırına bir daha yazılmasın / satırdan okunmasın.
 */
import { createClient } from "@libsql/client";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/libsql-batch", () => ({ batchWrite: async () => false }));

const { TASIMA_IFADELERI } = await import("./model-gorseli");

const db = createClient({ url: ":memory:" });

async function kur() {
  await db.batch(
    [
      `DROP TABLE IF EXISTS "ProductModelFile"`,
      `DROP TABLE IF EXISTS "ProductModelFileThumb"`,
      // Canlıdaki sıra: görsel en sonda; aradaki kolonlar sadeleştirildi.
      `CREATE TABLE "ProductModelFile" ("id" TEXT PRIMARY KEY, "productId" TEXT, "colorsJson" TEXT, "contentMd5" TEXT, "thumbnail" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "ProductModelFileThumb" ("fileId" TEXT NOT NULL PRIMARY KEY, "thumbnail" TEXT NOT NULL)`,
    ],
    "write",
  );
}

const gorsel = (n: number) => `data:image/png;base64,${"A".repeat(n)}`;

describe("eski kolondan yeni tabloya taşıma (gerçek libSQL)", () => {
  beforeEach(kur);

  it("görselleri taşır, eski kolonu boşaltır, diğer kolonlara dokunmaz", async () => {
    await db.batch(
      [
        { sql: `INSERT INTO "ProductModelFile" VALUES ('a', 'p1', '{"c":1}', 'md5a', ?)`, args: [gorsel(40_000)] },
        { sql: `INSERT INTO "ProductModelFile" VALUES ('b', 'p1', NULL, 'md5b', NULL)`, args: [] },
        { sql: `INSERT INTO "ProductModelFile" VALUES ('c', 'p2', NULL, NULL, ?)`, args: [gorsel(10)] },
      ],
      "write",
    );
    await db.batch(TASIMA_IFADELERI.map((sql) => ({ sql, args: [] })), "write");

    const yeni = await db.execute(`SELECT "fileId", length("thumbnail") AS n FROM "ProductModelFileThumb" ORDER BY "fileId"`);
    expect(yeni.rows.map((r) => [r.fileId, Number(r.n)])).toEqual([
      ["a", gorsel(40_000).length],
      ["c", gorsel(10).length],
    ]);
    const eski = await db.execute(`SELECT "id", typeof("thumbnail") AS t, "contentMd5", "colorsJson" FROM "ProductModelFile" ORDER BY "id"`);
    expect(eski.rows.map((r) => r.t)).toEqual(["null", "null", "null"]);
    expect(eski.rows.map((r) => r.contentMd5)).toEqual(["md5a", "md5b", null]);
    expect(eski.rows[0]!.colorsJson).toBe('{"c":1}');
  });

  it("ikinci koşu bir şey değiştirmez; eski sürümün sonradan yazdığı görsel YENİ sayılır ve üstüne yazılır", async () => {
    await db.execute({ sql: `INSERT INTO "ProductModelFile" VALUES ('a', 'p1', NULL, NULL, ?)`, args: [gorsel(5)] });
    await db.batch(TASIMA_IFADELERI.map((sql) => ({ sql, args: [] })), "write");
    await db.batch(TASIMA_IFADELERI.map((sql) => ({ sql, args: [] })), "write");
    expect((await db.execute(`SELECT COUNT(*) AS n FROM "ProductModelFileThumb"`)).rows[0]!.n).toBe(1);

    // Eski sürüm bir cihaz aynı dosyaya yeni görsel yazdı (eski kolona).
    await db.execute({ sql: `UPDATE "ProductModelFile" SET "thumbnail" = ? WHERE "id" = 'a'`, args: [gorsel(7)] });
    await db.batch(TASIMA_IFADELERI.map((sql) => ({ sql, args: [] })), "write");
    const r = await db.execute(`SELECT length("thumbnail") AS n FROM "ProductModelFileThumb" WHERE "fileId" = 'a'`);
    expect(Number(r.rows[0]!.n)).toBe(gorsel(7).length);
  });

  it("silinmiş dosyanın görseli (yetim) temizlenir; boş metin taşınmaz", async () => {
    await db.batch(
      [
        { sql: `INSERT INTO "ProductModelFileThumb" VALUES ('silinen', ?)`, args: [gorsel(3)] },
        { sql: `INSERT INTO "ProductModelFile" VALUES ('bos', 'p1', NULL, NULL, '')`, args: [] },
      ],
      "write",
    );
    await db.batch(TASIMA_IFADELERI.map((sql) => ({ sql, args: [] })), "write");
    expect((await db.execute(`SELECT COUNT(*) AS n FROM "ProductModelFileThumb"`)).rows[0]!.n).toBe(0);
    expect((await db.execute(`SELECT typeof("thumbnail") AS t FROM "ProductModelFile"`)).rows[0]!.t).toBe("null");
  });
});

describe("görsel model dosyası satırında DEĞİL (kaynak taraması)", () => {
  const KOK = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const dosyalar: string[] = [];
  const gez = (dizin: string) => {
    for (const ad of readdirSync(dizin)) {
      const tam = path.join(dizin, ad);
      if (statSync(tam).isDirectory()) {
        if (ad !== "generated" && ad !== "node_modules") gez(tam);
      } else if (/\.(ts|tsx)$/.test(ad) && !/\.test\.tsx?$/.test(ad)) {
        dosyalar.push(tam);
      }
    }
  };
  gez(path.join(KOK, "src"));
  const goreli = (f: string) => path.relative(KOK, f).replace(/\\/g, "/");
  // Eski kolona bilerek dokunan yerler: taşıma, şema, kolon sırası bakımı, yedekteki geçiş okuması.
  const IZINLI = new Set([
    "src/lib/model-gorseli.ts",
    "src/lib/runtime-schema.ts",
    "src/lib/buyuk-kolon-sonda.ts",
    "src/lib/backup-payload.ts",
  ]);

  it("eski kolondan 'görsel var mı' sorgusu yalnız izinli yerlerde", () => {
    const ihlal = dosyalar
      .filter((f) => !IZINLI.has(goreli(f)))
      .filter((f) => /typeof\(\s*"?thumbnail"?\s*\)/.test(readFileSync(f, "utf8")))
      .map(goreli);
    expect(ihlal).toEqual([]);
  });

  it("Prisma ile model dosyasına görsel yazılmıyor / okunmuyor", () => {
    const ihlal = dosyalar
      .map((f) => [goreli(f), readFileSync(f, "utf8")] as const)
      // Tipli yollar zaten derlenmez; bu tarama tipsiz nesneyle (`Record<string, unknown>`) yazmayı da yakalar.
      .filter(([, s]) => /productModelFile\./.test(s) && /(select|omit|data|persist)\s*[:=][^;]{0,300}\bthumbnail\s*:/.test(s))
      .map(([f]) => f);
    expect(ihlal).toEqual([]);
  });
});
