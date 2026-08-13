/**
 * TARİH ONARIMI — biçim bilgisinin TEK kaynağı `sqlite-date.ts` olduğunu kilitler.
 *
 * NEDEN GERÇEK libSQL: onarım bir SQL DİZESİ. `tsc` de `eslint` de `next build` de dizenin
 * içini görmez. Bu sınıf hata sahada iki kez ısırdı — biri uygulamayı 205 saniye açılmaz
 * yaptı, diğeri "N kolon onarıldı" derken hiçbir satıra dokunmadı.
 *
 * Burada kilitlenen: `repairDateColumnSql()` TEK ifadeyle hem TAMSAYI→ISO hem METİN→METİN
 * durumunu kapatır. Onarım ifadesinin ikinci bir kopyası (`runtime-schema.ts`) ayrışırsa
 * son testteki eşdeğerlik kontrolü kırmızıya döner.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaLibSQL } from "@prisma/adapter-libsql";
import { PrismaClient } from "@/generated/prisma/client";
import { canonicalDateSql, repairDateColumnSql } from "@/lib/sqlite-date";
import { nonCanonicalDateProbeSql, nonCanonicalDateWhereSql } from "@/lib/runtime-schema";

async function acDb(): Promise<{ db: PrismaClient; kapat: () => Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "date-repair-"));
  const db = new PrismaClient({
    adapter: new PrismaLibSQL({ url: `file:${path.join(dir, "t.db")}` }),
  });
  return {
    db,
    kapat: async () => {
      await db.$disconnect();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows dosyayı kilitli tutabilir; temizlik testi düşürmesin */
      }
    },
  };
}

/** Prisma DATETIME kolonunu JS Date'e çevirir; HAM metni görmek için TEXT'e zorluyoruz. */
async function hamDegerler(
  db: PrismaClient,
  kolon = "d"
): Promise<Record<string, string | null>> {
  const rows = await db.$queryRawUnsafe<Array<{ id: string; v: string | null }>>(
    `SELECT "id", CAST("${kolon}" AS TEXT) AS v FROM "Ornek" ORDER BY "id"`
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.v]));
}

/** Sahada ölçülen bütün biçimler tek tabloda. */
const KANONIK = "2026-08-13T07:00:00.000+00:00";
const SATIRLAR = `
  ('kanonik',  '${KANONIK}'),
  ('bosluklu', '2026-07-13 20:00:43'),
  ('zamanZ',   '2026-08-12T15:08:12.251Z'),
  ('zMsSiz',   '2026-08-01T00:00:00Z'),
  ('offset3',  '2026-08-01T12:00:00.000+03:00'),
  ('ciplak',   '2026-08-01T12:00:00.000'),
  ('ciplakMs', '2026-08-01T12:00:00'),
  ('tamsayi',  1784109600000),
  ('sayiMetni','1784109600000'),
  ('cop',      'tarih-değil'),
  ('bos',      NULL)`;

async function kurTablo(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(`CREATE TABLE "Ornek" ("id" TEXT PRIMARY KEY, "d" DATETIME)`);
  await db.$executeRawUnsafe(`INSERT INTO "Ornek" VALUES ${SATIRLAR}`);
}

describe("repairDateColumnSql (gerçek libSQL)", () => {
  it("iso-text: TEK ifade hem tamsayıyı hem yabancı metni kanonik biçime çeker", async () => {
    const { db, kapat } = await acDb();
    try {
      await kurTablo(db);
      await db.$executeRawUnsafe(repairDateColumnSql("Ornek", "d", "iso-text"));
      const v = await hamDegerler(db);

      // Kanonik ve NULL satırlara dokunulmadı.
      expect(v.kanonik).toBe(KANONIK);
      expect(v.bos).toBeNull();

      // Boşluklu / 'Z' ekli / ofsetli / ofsetsiz metinlerin hepsi tek biçime indi.
      expect(v.bosluklu).toBe("2026-07-13T20:00:43.000+00:00");
      expect(v.zamanZ).toBe("2026-08-12T15:08:12.251+00:00");
      // Milisaniyesiz damga da `.000` alır: '+' (0x2B) < '.' (0x2E) olduğu için `…00:00+00:00`
      // biçimi ay sınırı filtresinden DÜŞERDİ — onarım kendi hatasını üretmemeli.
      expect(v.zMsSiz).toBe("2026-08-01T00:00:00.000+00:00");
      // Ofset UTC'ye çevrilir: AN korunur, yalnız biçim tekleşir.
      expect(v.offset3).toBe("2026-08-01T09:00:00.000+00:00");
      expect(v.ciplak).toBe("2026-08-01T12:00:00.000+00:00");
      expect(v.ciplakMs).toBe("2026-08-01T12:00:00.000+00:00");

      // Tamsayı epoch-ms de aynı ifadeyle çevrildi (eskiden ayrı bir UPDATE gerekiyordu).
      expect(v.tamsayi).toMatch(/^2026-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/);
      // DATETIME kolonu SAYISAL yakınlıktadır: '1784109600000' metni SQLite'a girerken
      // TAMSAYI'ya döner, yani gerçek bir epoch-ms damgasıdır ve çevrilmesi DOĞRUDUR.
      expect(v.sayiMetni).toBe(v.tamsayi);

      // Çözülemeyen değere DOKUNULMAZ: NULL yazmak NOT NULL kolonu bozar, veriyi kaybederdik.
      expect(v.cop).toBe("tarih-değil");
    } finally {
      await kapat();
    }
  }, 60_000);

  it("iso-text: METİN yakınlıklı kolonda salt sayıdan oluşan değere DOKUNMAZ", async () => {
    // SQLite bu metni Julian GÜN SAYISI sanıp anlamsız bir tarih üretir; yanlış tarih
    // yazmaktansa satır olduğu gibi bırakılır. (DATETIME kolonunda bu değer zaten tamsayıya
    // döner — koruma, tipi TEXT olan kolonlar için duruyor.)
    const { db, kapat } = await acDb();
    try {
      await db.$executeRawUnsafe(`CREATE TABLE "Ornek" ("id" TEXT PRIMARY KEY, "d" TEXT)`);
      await db.$executeRawUnsafe(`INSERT INTO "Ornek" VALUES ('sayiMetni','1784109600000')`);
      await db.$executeRawUnsafe(repairDateColumnSql("Ornek", "d", "iso-text"));
      expect((await hamDegerler(db)).sayiMetni).toBe("1784109600000");
    } finally {
      await kapat();
    }
  }, 60_000);

  it("iso-text: idempotent — ikinci tur hiçbir satırı değiştirmez", async () => {
    const { db, kapat } = await acDb();
    try {
      await kurTablo(db);
      const sql = repairDateColumnSql("Ornek", "d", "iso-text");
      await db.$executeRawUnsafe(sql);
      const birinci = await hamDegerler(db);
      await db.$executeRawUnsafe(sql);
      expect(await hamDegerler(db)).toEqual(birinci);
    } finally {
      await kapat();
    }
  }, 60_000);

  it("iso-text: onarımdan sonra ay sınırı filtresi hiçbir satırı elemez (hatanın KÖKÜ)", async () => {
    const { db, kapat } = await acDb();
    try {
      await db.$executeRawUnsafe(`CREATE TABLE "Ornek" ("id" TEXT PRIMARY KEY, "d" DATETIME)`);
      await db.$executeRawUnsafe(
        `INSERT INTO "Ornek" VALUES ('kanonik','2026-08-01T09:00:00.000+00:00'), ('bosluklu','2026-08-01 12:00:00')`
      );
      const oncesi = await db.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "Ornek" WHERE "d" >= '2026-08-01T00:00:00.000+00:00'`
      );
      // 🔴 12:00'daki kayıt 00:00 sınırının ALTINDA sayıldı: ' ' (0x20) < 'T' (0x54).
      expect(oncesi.map((r) => r.id)).toEqual(["kanonik"]);

      await db.$executeRawUnsafe(repairDateColumnSql("Ornek", "d", "iso-text"));
      const sonrasi = await db.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "Ornek" WHERE "d" >= '2026-08-01T00:00:00.000+00:00' ORDER BY "id"`
      );
      expect(sonrasi.map((r) => r.id)).toEqual(["bosluklu", "kanonik"]);
    } finally {
      await kapat();
    }
  }, 60_000);

  it("iso-text: milisaniyesiz '+00:00' damgası KANONİK SAYILMAZ, onarılır", async () => {
    // 🔴 DENETİMDE BULUNDU: '2026-08-01T00:00:00+00:00' hem 'T' içeriyor hem '+00:00' ile
    // bitiyordu, yani eski tanıma göre TEMİZ sayılıp onarımdan muaf kalıyordu. Oysa metin
    // sıralamasında '+' (0x2B) < '.' (0x2E): ay sınırına tam denk gelen böyle bir satır
    // `>= '…T00:00:00.000+00:00'` filtresinden SESSİZCE düşer.
    const { db, kapat } = await acDb();
    try {
      await db.$executeRawUnsafe(`CREATE TABLE "Ornek" ("id" TEXT PRIMARY KEY, "d" DATETIME)`);
      await db.$executeRawUnsafe(`INSERT INTO "Ornek" VALUES ('msSiz','2026-08-01T00:00:00+00:00')`);

      const oncesi = await db.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "Ornek" WHERE "d" >= '2026-08-01T00:00:00.000+00:00'`
      );
      expect(oncesi).toEqual([]); // hata birebir üretilebiliyor

      const [{ v: bozukMu }] = await db.$queryRawUnsafe<Array<{ v: number }>>(
        nonCanonicalDateProbeSql("Ornek", "d", "iso-text")
      );
      expect(Number(bozukMu)).toBe(1);

      await db.$executeRawUnsafe(repairDateColumnSql("Ornek", "d", "iso-text"));
      expect((await hamDegerler(db)).msSiz).toBe("2026-08-01T00:00:00.000+00:00");

      const sonrasi = await db.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "Ornek" WHERE "d" >= '2026-08-01T00:00:00.000+00:00'`
      );
      expect(sonrasi.map((r) => r.id)).toEqual(["msSiz"]);
    } finally {
      await kapat();
    }
  }, 60_000);

  it("epoch-ms: METİN yakınlıklı kolonda salt sayıdan oluşan değere DOKUNMAZ", async () => {
    // Koruma iso-text dalında vardı, epoch-ms dalında YOKTU: SQLite salt sayıdan oluşan
    // metni Julian GÜN SAYISI sanıp ayrıştırdığı için `julianday(...)` NULL dönmez ve satır
    // 1.5e17 gibi anlamsız bir damgaya çevrilip KALICI olarak bozulurdu.
    const { db, kapat } = await acDb();
    try {
      await db.$executeRawUnsafe(`CREATE TABLE "Ornek" ("id" TEXT PRIMARY KEY, "d" TEXT)`);
      await db.$executeRawUnsafe(`INSERT INTO "Ornek" VALUES ('sayiMetni','1784109600000')`);
      await db.$executeRawUnsafe(repairDateColumnSql("Ornek", "d", "epoch-ms"));
      expect((await hamDegerler(db)).sayiMetni).toBe("1784109600000");
    } finally {
      await kapat();
    }
  }, 60_000);

  it("epoch-ms: metin biçimlerini tamsayıya çevirir, kolon temiz kalır", async () => {
    const { db, kapat } = await acDb();
    try {
      await db.$executeRawUnsafe(`CREATE TABLE "Ornek" ("id" TEXT PRIMARY KEY, "d" DATETIME)`);
      await db.$executeRawUnsafe(
        `INSERT INTO "Ornek" VALUES ('a','2026-07-13 20:00:43'), ('b','2026-07-13T20:00:43.000+00:00'), ('c',1784109600000)`
      );
      await db.$executeRawUnsafe(repairDateColumnSql("Ornek", "d", "epoch-ms"));
      const tipler = await db.$queryRawUnsafe<Array<{ t: string }>>(
        `SELECT typeof("d") AS t FROM "Ornek"`
      );
      expect(tipler.every((r) => r.t === "integer")).toBe(true);
      const [{ v: kaldiMi }] = await db.$queryRawUnsafe<Array<{ v: number }>>(
        nonCanonicalDateProbeSql("Ornek", "d", "epoch-ms")
      );
      expect(Number(kaldiMi)).toBe(0);
    } finally {
      await kapat();
    }
  }, 60_000);
});

describe("canonicalDateSql — göç ile aynı satırları seçer", () => {
  // ⚠️ Onarımın kapsamı ile göçün "bozuk mu?" ön elemesi AYNI tanımı kullanmak zorunda.
  // Ayrıştıkları an ya kolon sonsuza kadar bozuk bulunur (her göçte boş UPDATE, günlük yine
  // "onarıldı" der) ya da bozuk satır hiç görülmez. İki taraf ayrı dosyada yaşadığı sürece
  // bu testin koşması ŞART.
  for (const storage of ["iso-text", "epoch-ms"] as const) {
    it(`${storage}: kanonik-olmayan satır kümesi göçünkiyle birebir aynı`, async () => {
      const { db, kapat } = await acDb();
      try {
        await kurTablo(db);
        const bizim = await db.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id" FROM "Ornek" WHERE "d" IS NOT NULL AND NOT (${canonicalDateSql("d", storage)}) ORDER BY "id"`
        );
        const gocun = await db.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id" FROM "Ornek" WHERE ${nonCanonicalDateWhereSql("d", storage)} ORDER BY "id"`
        );
        expect(bizim.map((r) => r.id)).toEqual(gocun.map((r) => r.id));
        expect(bizim.length).toBeGreaterThan(0); // fixture gerçekten bozuk satır içeriyor
      } finally {
        await kapat();
      }
    }, 60_000);
  }

  it("iso-text: onarım sonrası göç kolonu TEMİZ görür (boş UPDATE turu kalmaz)", async () => {
    const { db, kapat } = await acDb();
    try {
      await db.$executeRawUnsafe(`CREATE TABLE "Ornek" ("id" TEXT PRIMARY KEY, "d" DATETIME)`);
      // Çözülemeyen değerler bilerek DIŞARIDA: onlar kalıcı olarak "bozuk" sayılır ve
      // dokunulmaz — kolonun temizlenmesi çözülebilen her biçimin kapandığını gösterir.
      await db.$executeRawUnsafe(
        `INSERT INTO "Ornek" VALUES ('kanonik','${KANONIK}'), ('bosluklu','2026-07-13 20:00:43'),
                                   ('zamanZ','2026-08-12T15:08:12.251Z'), ('offset3','2026-08-01T12:00:00.000+03:00'),
                                   ('ciplak','2026-08-01T12:00:00.000'), ('tamsayi',1784109600000), ('bos',NULL)`
      );
      await db.$executeRawUnsafe(repairDateColumnSql("Ornek", "d", "iso-text"));
      const [{ v }] = await db.$queryRawUnsafe<Array<{ v: number }>>(
        nonCanonicalDateProbeSql("Ornek", "d", "iso-text")
      );
      expect(Number(v)).toBe(0);
    } finally {
      await kapat();
    }
  }, 60_000);
});
