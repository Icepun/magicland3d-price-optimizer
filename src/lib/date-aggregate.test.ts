/**
 * TARİH ALANINDA `aggregate({ _min / _max })` YASAK — gerileme koruması.
 *
 * Uygulama Prisma'yı libSQL driver adapter'ı üzerinden çalıştırıyor. Toplama ifadesi (MIN/MAX)
 * kolonun tipini kaybettiği için Prisma dönen ham epoch-ms sayısını DateTime'a çeviremiyor ve
 * TÜM sorgu düşüyor:
 *
 *   Inconsistent column data: Could not convert value 1786394653611 to type `DateTime`
 *
 * v0.19.139'da Raporlar sayfası tam olarak bu yüzden komple boş kaldı: aylık finans ucu
 * `_min: { orderedAt }` / `_max: { syncedAt }` kullanıyordu ve 500 dönüyordu. `_count` ve
 * SAYISAL `_min/_max` sorunsuz çalışıyor; kırılan yalnız TARİH.
 *
 * Doğru desen: `findFirst({ orderBy: { <tarih>: "asc" | "desc" }, select: { <tarih>: true } })`
 * — gerçek `Date` döner, maliyeti aynıdır (LIMIT 1 + index).
 *
 * Bu dosya iki şeyi birden korur:
 *  1) Kaynak taraması — kimse tarih alanına yeniden `_min/_max` yazmasın.
 *  2) Davranış testi — güvendiğimiz `findFirst` deseni adapter üzerinde gerçekten `Date` döndürsün.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Şemadaki DateTime alan adları — `_min/_max` içinde geçerlerse sorgu çalışma anında patlar. */
const DATE_FIELDS = [
  "orderedAt",
  "syncedAt",
  "paidAt",
  "createdAt",
  "updatedAt",
  "changedAt",
  "acknowledgedAt",
  "openedAt",
  "capturedAt",
  "startedAt",
  "finishedAt",
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated" || entry.name === "node_modules") continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("tarih alanında aggregate _min/_max kullanılmamalı", () => {
  it("kaynakta tek bir örneği bile yok", () => {
    const root = path.resolve(__dirname, "..");
    const ihlaller: string[] = [];

    for (const file of sourceFiles(root)) {
      const text = fs.readFileSync(file, "utf8");
      if (!text.includes("_min:") && !text.includes("_max:")) continue;

      // `_min: { ... }` / `_max: { ... }` bloklarının İÇİNİ tara — aynı dosyadaki başka
      // yerlerde geçen tarih adları yanlış alarm üretmesin.
      const bloklar = text.matchAll(/_(?:min|max):\s*\{([^}]*)\}/g);
      for (const blok of bloklar) {
        const icerik = blok[1];
        for (const alan of DATE_FIELDS) {
          if (new RegExp(`\\b${alan}\\b`).test(icerik)) {
            ihlaller.push(`${path.relative(root, file)} → _min/_max içinde "${alan}"`);
          }
        }
      }
    }

    expect(
      ihlaller,
      `Tarih alanında aggregate _min/_max libSQL adapter'ında TÜM sorguyu düşürür ` +
        `("Could not convert value … to type DateTime"). Bunun yerine ` +
        `findFirst({ orderBy: { <tarih>: "asc" | "desc" } }) kullan. İhlaller:\n` +
        ihlaller.join("\n")
    ).toEqual([]);
  });

  it("findFirst + orderBy deseni adapter üzerinde gerçek Date döndürür", async () => {
    const { PrismaLibSQL } = await import("@prisma/adapter-libsql");
    const { PrismaClient } = await import("@/generated/prisma/client");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "date-agg-"));
    const db = new PrismaClient({ adapter: new PrismaLibSQL({ url: `file:${path.join(dir, "t.db")}` }) });
    try {
      await db.$executeRawUnsafe(
        `CREATE TABLE "PlatformOrderFinancial" (
          "id" TEXT NOT NULL PRIMARY KEY, "platform" TEXT NOT NULL, "externalOrderId" TEXT NOT NULL,
          "orderNumber" TEXT, "actualCommissionKurus" INTEGER NOT NULL DEFAULT 0,
          "settlementRevenueKurus" INTEGER NOT NULL DEFAULT 0, "syncedAt" DATETIME NOT NULL)`
      );
      const damga = Date.now();
      await db.$executeRawUnsafe(
        `INSERT INTO "PlatformOrderFinancial" ("id","platform","externalOrderId","syncedAt")
         VALUES ('a','trendyol','x',?)`,
        damga
      );

      const son = await db.platformOrderFinancial.findFirst({
        where: { platform: "trendyol" },
        orderBy: { syncedAt: "desc" },
        select: { syncedAt: true },
      });

      expect(son?.syncedAt).toBeInstanceOf(Date);
      expect(son?.syncedAt.getTime()).toBe(damga);
      // Sayım da aynı yolda kullanılıyor; tarih içermediği için güvenli.
      expect(await db.platformOrderFinancial.count({ where: { platform: "trendyol" } })).toBe(1);
    } finally {
      await db.$disconnect();
      // Windows dosyayı bir süre kilitli tutabiliyor; temizlik testi düşürmesin.
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* geçici klasör işletim sistemine kalsın */
      }
    }
  }, 60_000);
});
