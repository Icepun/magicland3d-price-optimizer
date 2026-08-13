import { describe, it, expect } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { PrismaLibSQL } from "@prisma/adapter-libsql";
import { PrismaClient } from "@/generated/prisma/client";
import {
  DATE_COLUMN_INTROSPECTION_SQL,
  DATE_COLUMN_TABLE_LIST_SQL,
  nonCanonicalDateProbeSql,
  nonCanonicalDateCountSql,
} from "@/lib/runtime-schema";
import { nowDbDateSql, repairDateColumnSql } from "@/lib/sqlite-date";

/**
 * Açılış göçündeki SQL GERÇEKTEN çalışıyor mu?
 *
 * NEDEN: `normalizeDateColumns()` introspection sorgusu bir sürüm boyunca GEÇERSİZ SQL
 * üretti (`ESCAPE ''` — template literal içinde ters bölü kaçışı dizeyi bozuyordu).
 * Sorgu her açılışta patlayınca onarım "başarısız" sayıldı, o sürümde sürüm damgası da
 * başarıya bağlıydı → damga hiç yazılmadı → uygulama HER AÇILIŞTA tam şema göçünü baştan
 * koştu: ölçülen 205 saniye, Panel'in tüm kartları boş bekledi.
 *
 * `tsc` bunu yakalayamaz (dize içinde SQL). Bu yüzden sorgular gerçek libSQL üzerinde koşuyor.
 *
 * ⚠️ SQL KOPYALANMAZ, koddan IMPORT EDİLİR. Önceki tur burada bir KOPYA tutuyordu; kod ile
 * kopya ayrıştığı an test yeşil kalıp uygulama patlardı.
 */

async function acDb(): Promise<{ db: PrismaClient; kapat: () => Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlprobe-"));
  const db = new PrismaClient({
    adapter: new PrismaLibSQL({ url: `file:${path.join(dir, "t.db")}` }),
  });
  return {
    db,
    kapat: async () => {
      await db.$disconnect();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows kilidi */ }
    },
  };
}

describe("tarih onarımı göç SQL'leri (gerçek libSQL)", () => {
  it("introspection tarih kolonlarını bulur, _ ile başlayanları ve Recommendation'ı eler", async () => {
    const { db, kapat } = await acDb();
    try {
      await db.$executeRawUnsafe(`CREATE TABLE "Ornek" ("id" TEXT PRIMARY KEY, "orderedAt" DATETIME, "ad" TEXT)`);
      await db.$executeRawUnsafe(`CREATE TABLE "_prisma_migrations" ("id" TEXT PRIMARY KEY, "started_at" DATETIME)`);
      await db.$executeRawUnsafe(`CREATE TABLE "Recommendation" ("id" TEXT PRIMARY KEY, "createdAt" DATETIME)`);

      const rows = await db.$queryRawUnsafe<Array<{ tbl: string; col: string }>>(
        DATE_COLUMN_INTROSPECTION_SQL
      );
      const tablolar = rows.map((r) => r.tbl);
      expect(tablolar).toContain("Ornek");
      expect(tablolar).not.toContain("_prisma_migrations");
      expect(tablolar).not.toContain("Recommendation");
      expect(rows.find((r) => r.tbl === "Ornek")?.col).toBe("orderedAt");
    } finally {
      await kapat();
    }
  }, 60_000);

  it("yedek yol (tablo listesi + PRAGMA table_info) aynı kolonları verir", async () => {
    // Tablo-değerli PRAGMA bir motorda desteklenmezse göç bu yola düşer; o yol da ölçülmeli.
    const { db, kapat } = await acDb();
    try {
      await db.$executeRawUnsafe(`CREATE TABLE "Ornek" ("id" TEXT PRIMARY KEY, "orderedAt" DATETIME, "ad" TEXT)`);
      await db.$executeRawUnsafe(`CREATE TABLE "Recommendation" ("id" TEXT PRIMARY KEY, "createdAt" DATETIME)`);

      const tablolar = await db.$queryRawUnsafe<Array<{ name: string }>>(DATE_COLUMN_TABLE_LIST_SQL);
      expect(tablolar.map((t) => t.name)).toEqual(["Ornek"]);

      const kolonlar = await db.$queryRawUnsafe<Array<{ name: string; type: string }>>(
        `PRAGMA table_info("Ornek")`
      );
      expect(
        kolonlar.filter((c) => String(c.type).toUpperCase() === "DATETIME").map((c) => c.name)
      ).toEqual(["orderedAt"]);
    } finally {
      await kapat();
    }
  }, 60_000);

  it("iso-text: boşluklu ve Z ekli metinleri kanonik biçime çevirir, temiz kolona dokunmaz", async () => {
    // ÖLÇÜLEN GERÇEK DURUM (canlı Turso, 13 Ağu 2026): 47 tarih kolonunun 8'inde toplam 2.922
    // satır bu biçimdeydi (SQLite CURRENT_TIMESTAMP "2026-08-13 07:00:00" ve mobilin "…Z" eki).
    // Eski onarım YALNIZ tamsayı→ISO çeviriyordu, bu satırlara hiç dokunmuyordu.
    const { db, kapat } = await acDb();
    try {
      await db.$executeRawUnsafe(
        `CREATE TABLE "Ornek" ("id" TEXT PRIMARY KEY, "orderedAt" DATETIME, "temizAt" DATETIME)`
      );
      const kanonik = "2026-08-13T07:00:00.000+00:00";
      await db.$executeRawUnsafe(
        `INSERT INTO "Ornek" VALUES ('a', '2026-07-13 20:00:43', ?), ('b', '2026-08-12T15:08:12.251Z', ?), ('c', ?, ?), ('d', 1784109600000, ?), ('e', NULL, ?)`,
        kanonik, kanonik, kanonik, kanonik, kanonik, kanonik
      );

      const [{ v: bozukMu }] = await db.$queryRawUnsafe<Array<{ v: number }>>(
        nonCanonicalDateProbeSql("Ornek", "orderedAt", "iso-text")
      );
      expect(Number(bozukMu)).toBe(1);
      const [{ n }] = await db.$queryRawUnsafe<Array<{ n: number }>>(
        nonCanonicalDateCountSql("Ornek", "orderedAt", "iso-text")
      );
      expect(Number(n)).toBe(3); // a, b, d — NULL ve kanonik olan sayılmaz

      // Temiz kolon hiç işaretlenmemeli (yoksa her göçte gereksiz yazma olurdu).
      const [{ v: temizMi }] = await db.$queryRawUnsafe<Array<{ v: number }>>(
        nonCanonicalDateProbeSql("Ornek", "temizAt", "iso-text")
      );
      expect(Number(temizMi)).toBe(0);

      await db.$executeRawUnsafe(repairDateColumnSql("Ornek", "orderedAt", "iso-text"));
      await db.$executeRawUnsafe(repairDateColumnSql("Ornek", "orderedAt", "iso-text"));

      const sonuc = await db.$queryRawUnsafe<Array<{ id: string; v: string | null }>>(
        // Prisma DATETIME kolonunu JS Date'e çevirir; HAM metni görmek için TEXT'e zorluyoruz.
        `SELECT "id", CAST("orderedAt" AS TEXT) AS v FROM "Ornek" ORDER BY "id"`
      );
      expect(sonuc[0]).toEqual({ id: "a", v: "2026-07-13T20:00:43.000+00:00" });
      expect(sonuc[1]).toEqual({ id: "b", v: "2026-08-12T15:08:12.251+00:00" });
      expect(sonuc[2]).toEqual({ id: "c", v: kanonik });
      expect(sonuc[3].v).toMatch(/^2026-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/);
      expect(sonuc[4].v).toBeNull();

      // Onarımdan sonra kolon TEMİZ sayılmalı; ikinci tur hiçbir satıra dokunmamalı (idempotent).
      const [{ v: kaldiMi }] = await db.$queryRawUnsafe<Array<{ v: number }>>(
        nonCanonicalDateProbeSql("Ornek", "orderedAt", "iso-text")
      );
      expect(Number(kaldiMi)).toBe(0);
      await db.$executeRawUnsafe(repairDateColumnSql("Ornek", "orderedAt", "iso-text"));
      const ikinci = await db.$queryRawUnsafe<Array<{ id: string; v: string | null }>>(
        // Prisma DATETIME kolonunu JS Date'e çevirir; HAM metni görmek için TEXT'e zorluyoruz.
        `SELECT "id", CAST("orderedAt" AS TEXT) AS v FROM "Ornek" ORDER BY "id"`
      );
      expect(ikinci).toEqual(sonuc);
    } finally {
      await kapat();
    }
  }, 60_000);

  it("iso-text: 'T' içeren ama '+00:00' ile bitmeyen biçimler de onarılır (ofsetli/ofsetsiz)", async () => {
    // 🔴 DENETİMDE BULUNDU: eski onarım yalnız (a) '%Z' ile biten ve (b) 'T' İÇERMEYEN
    // metinlerle eşleşiyordu. '…+03:00' ya da ofsetsiz '…T12:00:00.000' bir değer sonsuza
    // kadar "bozuk" bulunuyor, her tam göçte iki BOŞ UPDATE koşuyor ve günlük yine
    // "onarıldı" diyordu — v40'taki "başarı raporladı, hiçbir satıra dokunmadı" hatasının
    // bir kat aşağıda tekrarı.
    const { db, kapat } = await acDb();
    try {
      await db.$executeRawUnsafe(`CREATE TABLE "Ornek" ("id" TEXT PRIMARY KEY, "d" DATETIME)`);
      await db.$executeRawUnsafe(
        `INSERT INTO "Ornek" VALUES ('offset3', '2026-08-01T12:00:00.000+03:00'),
                                   ('ciplak',  '2026-08-01T12:00:00.000'),
                                   ('ciplakMs','2026-08-01T12:00:00'),
                                   ('zMsSiz',  '2026-08-01T00:00:00Z')`
      );
      await db.$executeRawUnsafe(repairDateColumnSql("Ornek", "d", "iso-text"));

      const rows = await db.$queryRawUnsafe<Array<{ id: string; v: string }>>(
        `SELECT "id", CAST("d" AS TEXT) AS v FROM "Ornek" ORDER BY "id"`
      );
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.v]));
      // '+03:00' UTC'ye çevrilir (12:00 TR = 09:00 UTC) — an KORUNUR, biçim tekleşir.
      expect(byId.offset3).toBe("2026-08-01T09:00:00.000+00:00");
      expect(byId.ciplak).toBe("2026-08-01T12:00:00.000+00:00");
      expect(byId.ciplakMs).toBe("2026-08-01T12:00:00.000+00:00");
      // 🔴 İKİNCİ BULGU: milisaniyesiz 'Z' damgası eskiden '…T00:00:00+00:00' oluyordu.
      // Kanonik sayılırdı ama '+' (0x2B) < '.' (0x2E) olduğu için ay sınırı filtresinden
      // DÜŞERDİ — onarım, düzeltmeye çalıştığı hatayı kendi çıktısında üretirdi.
      expect(byId.zMsSiz).toBe("2026-08-01T00:00:00.000+00:00");

      // Kolon artık TEMİZ ve ikinci tur hiçbir satıra dokunmaz (idempotent).
      const [{ v: kaldiMi }] = await db.$queryRawUnsafe<Array<{ v: number }>>(
        nonCanonicalDateProbeSql("Ornek", "d", "iso-text")
      );
      expect(Number(kaldiMi)).toBe(0);
      await db.$executeRawUnsafe(repairDateColumnSql("Ornek", "d", "iso-text"));
      const ikinci = await db.$queryRawUnsafe<Array<{ id: string; v: string }>>(
        `SELECT "id", CAST("d" AS TEXT) AS v FROM "Ornek" ORDER BY "id"`
      );
      expect(ikinci).toEqual(rows);

      // Ay sınırı filtresi artık HİÇBİR satırı elemiyor (hatanın kökü buydu).
      const agustos = await db.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "Ornek" WHERE "d" >= '2026-08-01T00:00:00.000+00:00' ORDER BY "id"`
      );
      expect(agustos.map((r) => r.id).sort()).toEqual(
        ["ciplak", "ciplakMs", "offset3", "zMsSiz"].sort()
      );
    } finally {
      await kapat();
    }
  }, 60_000);

  it("iso-text: çözülemeyen metne DOKUNMAZ (NULL yazıp veriyi kaybetmez)", async () => {
    const { db, kapat } = await acDb();
    try {
      await db.$executeRawUnsafe(`CREATE TABLE "Ornek" ("id" TEXT PRIMARY KEY, "orderedAt" DATETIME NOT NULL)`);
      await db.$executeRawUnsafe(`INSERT INTO "Ornek" VALUES ('x', 'tarih-değil')`);
      await db.$executeRawUnsafe(repairDateColumnSql("Ornek", "orderedAt", "iso-text"));
      const rows = await db.$queryRawUnsafe<Array<{ id: string; v: string }>>(
        `SELECT "id", CAST("orderedAt" AS TEXT) AS v FROM "Ornek" ORDER BY "id"`
      );
      expect(Object.fromEntries(rows.map((r) => [r.id, r.v]))).toEqual({
        x: "tarih-değil",
      });
    } finally {
      await kapat();
    }
  }, 60_000);

  it("nowDbDateSql() KANONİK biçim yazar (CURRENT_TIMESTAMP yazmıyordu)", async () => {
    // Senkron rotaları Listing/UnmatchedListing damgalarını CURRENT_TIMESTAMP ile yazıyordu:
    // "2026-08-13 07:00:00". Açılış göçü kolonu tek biçime çekse bile ilk ürün senkronunda
    // yeniden karışıyordu — onarımın kazancı dakikalar içinde eriyordu.
    const { db, kapat } = await acDb();
    try {
      await db.$executeRawUnsafe(`CREATE TABLE "Ornek" ("id" TEXT PRIMARY KEY, "d" DATETIME)`);
      await db.$executeRawUnsafe(
        `INSERT INTO "Ornek" (id, d) VALUES ('yeni', ${nowDbDateSql("iso-text")})`
      );
      await db.$executeRawUnsafe(
        `INSERT INTO "Ornek" (id, d) VALUES ('eski', CURRENT_TIMESTAMP)`
      );
      const rows = await db.$queryRawUnsafe<Array<{ id: string; v: string }>>(
        `SELECT "id", CAST("d" AS TEXT) AS v FROM "Ornek" ORDER BY "id"`
      );
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.v]));
      expect(byId.yeni).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/);
      // Karşı örnek: eski yol boşluklu biçim yazıyor (bu satır kanonik DEĞİL).
      expect(byId.eski).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

      const [{ v: bozukMu }] = await db.$queryRawUnsafe<Array<{ v: number }>>(
        nonCanonicalDateProbeSql("Ornek", "d", "iso-text")
      );
      expect(Number(bozukMu)).toBe(1); // yalnız 'eski' satırı yüzünden

      await db.$executeRawUnsafe(`DELETE FROM "Ornek" WHERE "id" = 'eski'`);
      const [{ v: yeniBozukMu }] = await db.$queryRawUnsafe<Array<{ v: number }>>(
        nonCanonicalDateProbeSql("Ornek", "d", "iso-text")
      );
      expect(Number(yeniBozukMu)).toBe(0); // nowDbDateSql'in yazdığı satır temiz
    } finally {
      await kapat();
    }
  }, 60_000);

  it("epoch-ms: nowDbDateSql tamsayı yazar (o motorun kanonik biçimi)", async () => {
    const { db, kapat } = await acDb();
    try {
      await db.$executeRawUnsafe(`CREATE TABLE "Ornek" ("id" TEXT PRIMARY KEY, "d" DATETIME)`);
      await db.$executeRawUnsafe(
        `INSERT INTO "Ornek" (id, d) VALUES ('a', ${nowDbDateSql("epoch-ms")})`
      );
      const [row] = await db.$queryRawUnsafe<Array<{ t: string; v: number }>>(
        `SELECT typeof("d") AS t, "d" AS v FROM "Ornek"`
      );
      expect(row.t).toBe("integer");
      // Damga "şimdi"ye yakın olmalı (birim karışırsa yıllarca sapardı).
      expect(Math.abs(Number(row.v) - Date.now())).toBeLessThan(60_000);
    } finally {
      await kapat();
    }
  }, 60_000);

  it("epoch-ms: her metin biçimi (boşluklu ve ISO) tamsayıya çevrilir", async () => {
    // Klasik yerel motorda kanonik biçim TAMSAYI'dır; eski "bozuk" tanımı 'T' içeren metni
    // temiz sayıyordu ve o kolonlar sonsuza kadar karışık kalıyordu.
    const { db, kapat } = await acDb();
    try {
      await db.$executeRawUnsafe(`CREATE TABLE "Ornek" ("id" TEXT PRIMARY KEY, "orderedAt" DATETIME)`);
      await db.$executeRawUnsafe(
        `INSERT INTO "Ornek" VALUES ('a', '2026-07-13 20:00:43'), ('b', '2026-07-13T20:00:43.000+00:00'), ('c', 1784109600000)`
      );
      const [{ n }] = await db.$queryRawUnsafe<Array<{ n: number }>>(
        nonCanonicalDateCountSql("Ornek", "orderedAt", "epoch-ms")
      );
      expect(Number(n)).toBe(2);

      await db.$executeRawUnsafe(repairDateColumnSql("Ornek", "orderedAt", "epoch-ms"));
      const tipler = await db.$queryRawUnsafe<Array<{ t: string }>>(
        `SELECT typeof("orderedAt") AS t FROM "Ornek"`
      );
      expect(tipler.every((r) => r.t === "integer")).toBe(true);
      const [{ v: kaldiMi }] = await db.$queryRawUnsafe<Array<{ v: number }>>(
        nonCanonicalDateProbeSql("Ornek", "orderedAt", "epoch-ms")
      );
      expect(Number(kaldiMi)).toBe(0);
    } finally {
      await kapat();
    }
  }, 60_000);

  it("karışık biçim sıralamayı bozar, onarım sonrası düzelir (hatanın KÖKÜ)", async () => {
    // Metin sıralamasında boşluk (0x20) 'T'den (0x54) küçüktür: karışık kolonda en yeni kayıt
    // en eski görünür ve `>= '…T…'` filtresi boşluklu satırların HEPSİNİ sessizce eler.
    const { db, kapat } = await acDb();
    try {
      await db.$executeRawUnsafe(`CREATE TABLE "Ornek" ("id" TEXT PRIMARY KEY, "orderedAt" DATETIME)`);
      // Ay kovasının SINIRI tam bu duruma denk gelir: aynı güne ait iki damga, biri boşluklu.
      await db.$executeRawUnsafe(
        `INSERT INTO "Ornek" VALUES ('kanonik', '2026-08-01T09:00:00.000+00:00'), ('bosluklu', '2026-08-01 12:00:00')`
      );
      const oncesi = await db.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "Ornek" WHERE "orderedAt" >= '2026-08-01T00:00:00.000+00:00'`
      );
      // 🔴 12:00'daki sipariş, 00:00 sınırının ALTINDA sayıldı: ' ' (0x20) < 'T' (0x54).
      expect(oncesi.map((r) => r.id)).toEqual(["kanonik"]);

      await db.$executeRawUnsafe(repairDateColumnSql("Ornek", "orderedAt", "iso-text"));
      const sonrasi = await db.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "Ornek" WHERE "orderedAt" >= '2026-08-01T00:00:00.000+00:00' ORDER BY "id"`
      );
      expect(sonrasi.map((r) => r.id)).toEqual(["bosluklu", "kanonik"]);
    } finally {
      await kapat();
    }
  }, 60_000);
});
