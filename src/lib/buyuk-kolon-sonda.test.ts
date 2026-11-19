import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createClient, type Client } from "@libsql/client";
import { buyukKolonuSonaTasi, buyukKolonlariSondaTut, type SemaCalistirici } from "./buyuk-kolon-sonda";

/**
 * Canlı veritabanındaki tablonun AYNISI (19 Kas 2026, `sqlite_master`): görsel kolonu satırın
 * ortasında, `contentMd5` ve `mesh*` onun arkasında. Arızayı üreten düzen buydu.
 */
const CANLI_TANIM = `CREATE TABLE "ProductModelFile" (
  "id" TEXT NOT NULL PRIMARY KEY, "productId" TEXT NOT NULL, "printerConfigId" TEXT NOT NULL,
  "originalName" TEXT NOT NULL, "storedPath" TEXT NOT NULL, "fileType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL DEFAULT 0, "gramaj" REAL, "estPrintMin" INTEGER,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  , "label" TEXT, "sortOrder" INTEGER NOT NULL DEFAULT 0, "r2Key" TEXT, "colorsJson" TEXT, "sliced" BOOLEAN,
  "plateJson" TEXT, "thumbnail" TEXT, "contentMd5" TEXT, "meshR2Key" TEXT, "meshName" TEXT, "meshType" TEXT,
  "meshSizeBytes" INTEGER)`;

const klasor = mkdtempSync(path.join(tmpdir(), "magicland-kolon-test-"));
let sayac = 0;
let db: Client;
let c: SemaCalistirici;

function calistirici(istemci: Client): SemaCalistirici {
  return {
    sorgu: async (sql) => (await istemci.execute(sql)).rows as unknown as Array<Record<string, unknown>>,
    islem: async (ifadeler) => {
      await istemci.batch(ifadeler, "write");
    },
  };
}

async function kolonAdlari(): Promise<string[]> {
  return (await db.execute(`PRAGMA table_info("ProductModelFile")`)).rows.map((r) => String(r.name));
}

async function tumSatirlar(): Promise<string> {
  const r = await db.execute(
    `SELECT id, productId, printerConfigId, originalName, storedPath, fileType, sizeBytes, gramaj, estPrintMin,
            label, sortOrder, r2Key, colorsJson, sliced, plateJson, contentMd5, meshR2Key, meshName, meshType,
            meshSizeBytes, thumbnail
       FROM "ProductModelFile" ORDER BY id`
  );
  return JSON.stringify(r.rows.map((s) => Object.values(s)));
}

beforeEach(async () => {
  db = createClient({ url: `file:${path.join(klasor, `kolon-${++sayac}.db`).replace(/\\/g, "/")}` });
  c = calistirici(db);
  await db.execute(CANLI_TANIM);
  await db.execute(`CREATE INDEX "ProductModelFile_printerConfigId_idx" ON "ProductModelFile" ("printerConfigId")`);
  await db.execute(
    `CREATE INDEX "ProductModelFile_productId_printerConfigId_idx" ON "ProductModelFile" ("productId", "printerConfigId")`
  );
  const satirlar = [];
  for (let i = 0; i < 40; i++) {
    // Beşte biri görselsiz; görseller sayfa boyunu aşacak kadar büyük (taşma sayfalarına düşer).
    const gorsel = i % 5 === 0 ? null : "data:image/png;base64," + randomBytes(2000 + ((i * 7919) % 30000)).toString("base64");
    satirlar.push({
      sql: `INSERT INTO "ProductModelFile" (id, productId, printerConfigId, originalName, storedPath, fileType,
              sizeBytes, gramaj, estPrintMin, label, sortOrder, r2Key, colorsJson, sliced, plateJson, thumbnail,
              contentMd5, meshR2Key, meshName, meshType, meshSizeBytes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        `id${String(i).padStart(3, "0")}`, `urun${i % 9}`, `yazici${i % 3}`, `Parça ${i} çğıöşü.gcode.3mf`,
        i % 2 ? "" : `C:/modeller/${i}`, "3mf", 1000 + i, i % 3 ? 12.5 + i : null, i % 4 ? 60 + i : null,
        i % 6 ? `Gövde ${i}` : null, i % 5, i % 2 ? `models/${i}.3mf` : null, i % 3 ? `{"n":${i}}` : null,
        i % 7 ? i % 2 : null, i % 4 ? `{"plateParam":${i}}` : null, gorsel,
        i % 9 ? `md5-${i}` : null, i % 8 ? null : `meshes/${i}.stl`, i % 8 ? null : `m${i}.stl`,
        i % 8 ? null : "stl", i % 8 ? null : 5000 + i,
      ],
    });
  }
  await db.batch(satirlar, "write");
});

afterAll(() => {
  try {
    db?.close();
  } catch {
    /* zaten kapalı */
  }
  // Windows'ta dosya tanıtıcısı geç bırakılabiliyor; silinemezse geçici klasörde kalması zararsız.
  try {
    rmSync(klasor, { recursive: true, force: true });
  } catch {
    /* bkz. yukarı */
  }
});

describe("büyük kolonu sona taşıma", () => {
  it("görseli son kolon yapar ve hiçbir satırı değiştirmez", async () => {
    const once = await tumSatirlar();
    expect((await kolonAdlari()).indexOf("thumbnail")).toBeLessThan((await kolonAdlari()).indexOf("contentMd5"));

    expect(await buyukKolonuSonaTasi(c, "ProductModelFile", "thumbnail")).toBe("tasindi");

    const adlar = await kolonAdlari();
    expect(adlar[adlar.length - 1]).toBe("thumbnail");
    // Geçici / eski kolon kalmamalı: şema taşımadan öncekiyle AYNI kolonlara sahip.
    expect(adlar.filter((a) => a.startsWith("thumbnail"))).toEqual(["thumbnail"]);
    expect(adlar).toHaveLength(23);
    expect(await tumSatirlar()).toBe(once);
  });

  it("indeksleri ve birincil anahtarı korur", async () => {
    await buyukKolonuSonaTasi(c, "ProductModelFile", "thumbnail");
    const indeksler = (
      await db.execute(`SELECT name FROM sqlite_master WHERE tbl_name='ProductModelFile' AND type='index' ORDER BY name`)
    ).rows.map((r) => String(r.name));
    expect(indeksler).toEqual([
      "ProductModelFile_printerConfigId_idx",
      "ProductModelFile_productId_printerConfigId_idx",
      "sqlite_autoindex_ProductModelFile_1",
    ]);
    await expect(
      db.execute(
        `INSERT INTO "ProductModelFile" (id, productId, printerConfigId, originalName, storedPath, fileType) VALUES ('id000','u','y','a','','gcode')`
      )
    ).rejects.toThrow();
    expect((await db.execute("PRAGMA integrity_check")).rows[0].integrity_check).toBe("ok");
  });

  it("ikinci kez çalıştırılınca hiçbir şey yazmaz", async () => {
    await buyukKolonuSonaTasi(c, "ProductModelFile", "thumbnail");
    const yazmalar: string[][] = [];
    const izleyen: SemaCalistirici = { sorgu: c.sorgu, islem: async (i) => void yazmalar.push(i) };
    expect(await buyukKolonuSonaTasi(izleyen, "ProductModelFile", "thumbnail")).toBe("zaten-sonda");
    expect(yazmalar).toEqual([]);
  });

  it("sonradan kolon eklenince görseli yeniden sona alır", async () => {
    await buyukKolonuSonaTasi(c, "ProductModelFile", "thumbnail");
    const once = await tumSatirlar();
    // İleride yapılacak bir şema değişikliği: yeni kolon HER ZAMAN sona eklenir → görselin arkasına düşer.
    await db.execute(`ALTER TABLE "ProductModelFile" ADD COLUMN "ileridekiKolon" TEXT`);
    expect((await kolonAdlari()).at(-1)).toBe("ileridekiKolon");

    expect(await buyukKolonuSonaTasi(c, "ProductModelFile", "thumbnail")).toBe("tasindi");

    expect((await kolonAdlari()).at(-1)).toBe("thumbnail");
    expect(await tumSatirlar()).toBe(once);
  });

  it("taşıma sonrası yeni kayıt yazılıp okunabilir", async () => {
    await buyukKolonuSonaTasi(c, "ProductModelFile", "thumbnail");
    await db.execute({
      sql: `INSERT INTO "ProductModelFile" (id, productId, printerConfigId, originalName, storedPath, fileType, thumbnail, contentMd5)
            VALUES (?,?,?,?,?,?,?,?)`,
      args: ["yeni", "u", "y", "a.gcode", "", "gcode", "data:image/png;base64,QUJD", "abc"],
    });
    const s = (await db.execute(`SELECT thumbnail, contentMd5, sortOrder, createdAt FROM "ProductModelFile" WHERE id='yeni'`)).rows[0];
    expect(s.thumbnail).toBe("data:image/png;base64,QUJD");
    expect(s.contentMd5).toBe("abc");
    expect(Number(s.sortOrder)).toBe(0);
    expect(s.createdAt).toBeTruthy();
  });

  it("işlem yarıda kesilirse tablo eski haliyle kalır", async () => {
    const once = await tumSatirlar();
    const adlarOnce = await kolonAdlari();
    // Son ifade bozuk: işlemin tamamı geri alınmalı (yeni kolon, taşıma ve ad değişikliği dahil).
    const kesilen: SemaCalistirici = {
      sorgu: c.sorgu,
      islem: async (ifadeler) => {
        await db.batch([...ifadeler.slice(0, -1), `ALTER TABLE "ProductModelFile" RENAME COLUMN "yok" TO "x"`], "write");
      },
    };
    await expect(buyukKolonuSonaTasi(kesilen, "ProductModelFile", "thumbnail")).rejects.toThrow();
    expect(await kolonAdlari()).toEqual(adlarOnce);
    expect(await tumSatirlar()).toBe(once);
  });

  it("olmayan tablo ve kolonu sessizce geçer", async () => {
    expect(await buyukKolonuSonaTasi(c, "OlmayanTablo", "thumbnail")).toBe("tablo-yok");
    expect(await buyukKolonuSonaTasi(c, "ProductModelFile", "olmayan")).toBe("kolon-yok");
  });

  it("zorunlu (NOT NULL) kolona dokunmaz", async () => {
    expect(await buyukKolonuSonaTasi(c, "ProductModelFile", "originalName")).toBe("atlandi");
    expect((await kolonAdlari()).indexOf("originalName")).toBe(3);
  });

  it("açılış bakımı hata olsa da istisna fırlatmaz", async () => {
    const bozuk: SemaCalistirici = {
      sorgu: async () => {
        throw new Error("ağ yok");
      },
      islem: async () => {},
    };
    expect(await buyukKolonlariSondaTut(bozuk)).toEqual([{ tablo: "ProductModelFile", kolon: "thumbnail", sonuc: "hata" }]);
    expect(await buyukKolonlariSondaTut(c)).toEqual([{ tablo: "ProductModelFile", kolon: "thumbnail", sonuc: "tasindi" }]);
  });
});
