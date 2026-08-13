/**
 * BİLDİRİM SPAM'İ — sahada görülen gerilemenin koruması.
 *
 * Berke tek bir baskı bitişi için zilde ÜÇ "Baskı tamamlandı" gördü. Veritabanındaki satırlar
 * (13 Ağu 2026):
 *
 *   2026-08-13 09:13:17            ← eski biçim (CURRENT_TIMESTAMP)
 *   2026-08-13 09:13:21            ← eski biçim
 *   2026-08-13T09:13:21.620+00:00  ← kanonik biçim
 *
 * İKİ AYRI KUSUR aynı anda:
 *  1. Satır id'si `printer-done:${cfg}:${Date.now()}` idi → HER ÇAĞRIDA farklı, dolayısıyla
 *     `INSERT OR IGNORE` hiçbir şeyi engellemiyordu. Tekilleştirme yalnız BELLEKTEKİ haritaya
 *     bakıyordu ve o harita sürece ait: ikinci bir süreç (ikinci pencere, geliştirme sunucusu,
 *     yeniden başlatma) kendi boş haritasıyla aynı bildirimi yeniden yazıyordu.
 *  2. `createdAt` sahada İKİ biçimde bulunuyor. Düz metin karşılaştırması biçimlerden birini
 *     tümüyle ıskalar; bu yüzden pencere `dbEpochMs()` ile sorgulanır.
 *
 * Bu test SQL'i GERÇEK libSQL üzerinde koşturur — dize içindeki sorguyu başka hiçbir araç
 * görmez (bu projede geçersiz bir göç sorgusu tam bu yüzden yayınlanıp uygulamayı 205 saniye
 * açtırmamıştı).
 */
import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NOTIFY_DEDUPE_MS, recentNotificationSql } from "./relay";

const client = createClient({ url: ":memory:" });
const NOW = Date.UTC(2026, 7, 13, 9, 13, 21);

/** `dbEpochMs` motora göre karar verir; testte kanonik metin dalını kullanıyoruz. */
async function sayim(type: string, body: string, since: number): Promise<number> {
  const r = await client.execute({ sql: recentNotificationSql(), args: [type, body, since] });
  return Number(r.rows[0]?.n ?? 0);
}

beforeAll(async () => {
  await client.execute(`CREATE TABLE "Notification" (
    "id" TEXT PRIMARY KEY, "type" TEXT NOT NULL, "severity" TEXT,
    "title" TEXT, "body" TEXT, "href" TEXT,
    "createdAt" DATETIME NOT NULL, "acknowledgedAt" DATETIME
  )`);
});

afterAll(() => client.close());

describe("bildirim mükerrer koruması", () => {
  it("SQL gerçek veritabanında ÇALIŞIR (dize içindeki sorgu sessizce bozuk olmasın)", async () => {
    await expect(sayim("printer-done", "yok", NOW - NOTIFY_DEDUPE_MS)).resolves.toBe(0);
  });

  it("HER İKİ tarih biçimini de sayar — sahadaki asıl tuzak", async () => {
    const body = "Bambu Lab A1 Combo — Delorean key hanger";
    // Sahadaki üç satırın birebir biçimleri.
    await client.execute({
      sql: `INSERT INTO "Notification" ("id","type","body","createdAt") VALUES (?,?,?,?)`,
      args: ["a", "printer-done", body, "2026-08-13 09:13:17"],
    });
    await client.execute({
      sql: `INSERT INTO "Notification" ("id","type","body","createdAt") VALUES (?,?,?,?)`,
      args: ["b", "printer-done", body, "2026-08-13T09:13:21.620+00:00"],
    });

    // Düz metin karşılaştırması biçimlerden birini ıskalardı; ikisi de sayılmalı.
    const n = await sayim("printer-done", body, NOW - NOTIFY_DEDUPE_MS);
    expect(n).toBe(2);
  });

  it("30 dakikadan ESKİ bildirim pencereye girmez — aynı dosya yeniden basılırsa haber verilir", async () => {
    const body = "Bambu Lab A1 Combo — pokeball keychain";
    // Dört saat önce biten baskı: yeni bitişi SUSTURMAMALI.
    await client.execute({
      sql: `INSERT INTO "Notification" ("id","type","body","createdAt") VALUES (?,?,?,?)`,
      args: ["c", "printer-done", body, "2026-08-13T05:13:21.000+00:00"],
    });

    expect(await sayim("printer-done", body, NOW - NOTIFY_DEDUPE_MS)).toBe(0);
  });

  it("farklı yazıcı/model aynı pencerede birbirini susturmaz", async () => {
    const body = "Snapmaker U1 — Dark Lord PS5";
    await client.execute({
      sql: `INSERT INTO "Notification" ("id","type","body","createdAt") VALUES (?,?,?,?)`,
      args: ["d", "printer-done", body, "2026-08-13T09:13:00.000+00:00"],
    });

    expect(await sayim("printer-done", "Snapmaker U1 — Başka Model", NOW - NOTIFY_DEDUPE_MS)).toBe(0);
    expect(await sayim("printer-done", body, NOW - NOTIFY_DEDUPE_MS)).toBe(1);
  });

  it("bildirim TÜRÜ ayrı sayılır — 'tamamlandı' ile 'duraklatıldı' karışmaz", async () => {
    const body = "Bambu Lab A1 Combo — Delorean key hanger";
    await client.execute({
      sql: `INSERT INTO "Notification" ("id","type","body","createdAt") VALUES (?,?,?,?)`,
      args: ["e", "printer-paused", body, "2026-08-13T09:13:10.000+00:00"],
    });

    expect(await sayim("printer-paused", body, NOW - NOTIFY_DEDUPE_MS)).toBe(1);
    // "tamamlandı" sayımı duraklatma satırından etkilenmemeli (yukarıdaki iki satır kalıyor).
    expect(await sayim("printer-done", body, NOW - NOTIFY_DEDUPE_MS)).toBe(2);
  });
});
