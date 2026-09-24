/**
 * TELEFONDAN KAMERA — telefon ile masaüstünün paylaştığı `PrinterCamera` SQL'i GERÇEK libSQL'de.
 *
 * Dize içindeki SQL'i tsc/eslint göremez; bu projede geçersiz bir göç sorgusu tam bu yüzden
 * yayınlanıp uygulamayı açtırmamıştı. Korunan davranışlar:
 *   • iki masaüstü aynı anda açıkken TEK gönderici (atomik sahiplenme),
 *   • sahipliği kaybeden kare yazamaz,
 *   • iki telefon izlerken birinin tazelemesi diğerinin süresini kısaltmaz,
 *   • ekran yeniden açılınca eski hata silinir (masaüstü beklemeden yeniden dener).
 */
import { createClient, type InValue } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import {
  KAMERA_SAHIP_BAYAT_MS, kameraBirakSql, kameraDurumuSql, kameraHataYazSql, kameraIstegiSql,
  kameraIstekleriSql, kameraKareYazSql, kameraSahiplenSql, kameraSahiplikBirakSql, kareCanliMi,
} from "./printer-camera";

const db = createClient({ url: ":memory:" });
const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);

/** runtime-schema.ts'teki tabloyla birebir (v48). */
const TABLO = `CREATE TABLE "PrinterCamera" (
  "printerConfigId" TEXT NOT NULL PRIMARY KEY,
  "wantedUntilMs" REAL NOT NULL DEFAULT 0,
  "owner" TEXT, "ownerAtMs" REAL, "frameUrl" TEXT, "frameAtMs" REAL, "error" TEXT, "updatedAtMs" REAL
)`;

async function calis(sql: string, ...args: InValue[]): Promise<number> {
  const r = await db.execute({ sql, args });
  return r.rowsAffected;
}
async function satir(id: string) {
  const r = await db.execute({ sql: kameraDurumuSql(), args: [id] });
  return r.rows[0] as unknown as Record<string, unknown> | undefined;
}

beforeEach(async () => {
  await db.execute(`DROP TABLE IF EXISTS "PrinterCamera"`);
  await db.execute(TABLO);
});

describe("telefon isteği", () => {
  it("ilk istek satırı açar, tazeleme süreyi uzatır", async () => {
    await calis(kameraIstegiSql(), "p1", T0 + 45_000, 1, T0);
    expect(Number((await satir("p1"))!.wantedUntilMs)).toBe(T0 + 45_000);
    await calis(kameraIstegiSql(), "p1", T0 + 60_000, 0, T0 + 15_000);
    expect(Number((await satir("p1"))!.wantedUntilMs)).toBe(T0 + 60_000);
  });

  it("iki telefon: birinin (daha kısa) tazelemesi diğerinin süresini KISALTMAZ", async () => {
    await calis(kameraIstegiSql(), "p1", T0 + 60_000, 1, T0);
    await calis(kameraIstegiSql(), "p1", T0 + 50_000, 0, T0 + 5_000);
    expect(Number((await satir("p1"))!.wantedUntilMs)).toBe(T0 + 60_000);
  });

  it("ekran yeniden açılınca eski hata silinir; tazelemede silinmez", async () => {
    await calis(kameraIstegiSql(), "p1", T0 + 45_000, 1, T0);
    await calis(kameraHataYazSql(), "Bu yazıcıda kamera bulunamadı.", T0 + 1000, "p1", "mac");
    await calis(kameraIstegiSql(), "p1", T0 + 50_000, 0, T0 + 2000);
    expect((await satir("p1"))!.error).toBe("Bu yazıcıda kamera bulunamadı.");
    await calis(kameraIstegiSql(), "p1", T0 + 55_000, 1, T0 + 3000);
    expect((await satir("p1"))!.error).toBeNull();
  });

  it("yeni açılış, süren oturumun karesini SİLMEZ (izleyen varken ikinci telefon anında görür)", async () => {
    await calis(kameraIstegiSql(), "p1", T0 + 45_000, 1, T0);
    await calis(kameraSahiplenSql(), "mac", T0, "p1", T0 - KAMERA_SAHIP_BAYAT_MS);
    await calis(kameraKareYazSql(), "https://r2/kare1", T0 + 500, T0 + 500, "p1", "mac");
    await calis(kameraIstegiSql(), "p1", T0 + 50_000, 1, T0 + 1000);
    expect((await satir("p1"))!.frameUrl).toBe("https://r2/kare1");
  });

  it("bırakma isteği bitirir → masaüstünün istek listesinden düşer", async () => {
    await calis(kameraIstegiSql(), "p1", T0 + 45_000, 1, T0);
    expect((await db.execute({ sql: kameraIstekleriSql(), args: [T0 + 1000] })).rows).toHaveLength(1);
    await calis(kameraBirakSql(), T0 + 2000, "p1");
    expect((await db.execute({ sql: kameraIstekleriSql(), args: [T0 + 3000] })).rows).toHaveLength(0);
  });
});

describe("masaüstü sahiplenme — iki masaüstü, tek gönderici", () => {
  beforeEach(async () => {
    await calis(kameraIstegiSql(), "p1", T0 + 45_000, 1, T0);
  });

  it("boştaki isteği ilk gelen alır, ikincisi alamaz", async () => {
    expect(await calis(kameraSahiplenSql(), "mac", T0, "p1", T0 - KAMERA_SAHIP_BAYAT_MS)).toBe(1);
    expect(await calis(kameraSahiplenSql(), "win", T0 + 100, "p1", T0 + 100 - KAMERA_SAHIP_BAYAT_MS)).toBe(0);
    expect((await satir("p1"))!.owner).toBe("mac");
  });

  it("sahibi susarsa (uyudu/kapandı) diğeri devralır", async () => {
    await calis(kameraSahiplenSql(), "mac", T0, "p1", T0 - KAMERA_SAHIP_BAYAT_MS);
    const sonra = T0 + KAMERA_SAHIP_BAYAT_MS + 1;
    expect(await calis(kameraSahiplenSql(), "win", sonra, "p1", sonra - KAMERA_SAHIP_BAYAT_MS)).toBe(1);
    // Eski sahip uyanıp kare yazmaya kalkarsa YAZAMAZ — oturumunu kapatması gerektiğini anlar.
    expect(await calis(kameraKareYazSql(), "https://r2/eski", sonra, sonra, "p1", "mac")).toBe(0);
  });

  it("süresi dolmuş istek sahiplenilmez", async () => {
    const sonra = T0 + 46_000;
    expect(await calis(kameraSahiplenSql(), "mac", sonra, "p1", sonra - KAMERA_SAHIP_BAYAT_MS)).toBe(0);
  });

  it("kare yazımı sahiplik zamanını tazeler (canlı sahip devredilmez)", async () => {
    await calis(kameraSahiplenSql(), "mac", T0, "p1", T0 - KAMERA_SAHIP_BAYAT_MS);
    const t = T0 + KAMERA_SAHIP_BAYAT_MS - 1000;
    expect(await calis(kameraKareYazSql(), "https://r2/k", t, t, "p1", "mac")).toBe(1);
    const sonra = T0 + KAMERA_SAHIP_BAYAT_MS + 1;
    expect(await calis(kameraSahiplenSql(), "win", sonra, "p1", sonra - KAMERA_SAHIP_BAYAT_MS)).toBe(0);
  });

  it("hata yazımı sahipliği ve kare adresini bırakır; başkasının oturumunu ezmez", async () => {
    await calis(kameraSahiplenSql(), "mac", T0, "p1", T0 - KAMERA_SAHIP_BAYAT_MS);
    await calis(kameraKareYazSql(), "https://r2/k", T0 + 1, T0 + 1, "p1", "mac");
    expect(await calis(kameraHataYazSql(), "Windows hatası", T0 + 2, "p1", "win")).toBe(0);
    expect(await calis(kameraHataYazSql(), "Kamera bağlantısı koptu.", T0 + 3, "p1", "mac")).toBe(1);
    const s = (await satir("p1"))!;
    expect(s.owner).toBeNull();
    expect(s.frameUrl).toBeNull();
    expect(s.error).toBe("Kamera bağlantısı koptu.");
  });

  it("olağan bitiş sahipliği ve silinen karenin adresini temizler", async () => {
    await calis(kameraSahiplenSql(), "mac", T0, "p1", T0 - KAMERA_SAHIP_BAYAT_MS);
    await calis(kameraKareYazSql(), "https://r2/k", T0 + 1, T0 + 1, "p1", "mac");
    expect(await calis(kameraSahiplikBirakSql(), T0 + 2, "p1", "mac")).toBe(1);
    const s = (await satir("p1"))!;
    expect(s.owner).toBeNull();
    expect(s.frameUrl).toBeNull();
  });
});

describe("kare tazeliği", () => {
  it("12 sn'den eski kare canlı sayılmaz", () => {
    expect(kareCanliMi(T0 - 2000, T0)).toBe(true);
    expect(kareCanliMi(T0 - 13_000, T0)).toBe(false);
    expect(kareCanliMi(null, T0)).toBe(false);
  });
});
