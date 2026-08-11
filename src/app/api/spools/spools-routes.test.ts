import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-spool-routes-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

const DAY_MS = 86_400_000;

let getUsage: typeof import("./[id]/usage/route").GET;
let listSpools: typeof import("./route").GET;
let deleteSpool: typeof import("./[id]/route").DELETE;
let db: typeof import("@/lib/prisma").prisma;

interface SpoolRow {
  id: string;
  name: string;
  material: string;
  costGap: { actualPerGram: number; tablePerGram: number } | null;
}

async function readSpools(): Promise<SpoolRow[]> {
  const response = await listSpools();
  expect(response.status).toBe(200);
  return (await response.json()) as SpoolRow[];
}

async function findSpool(id: string): Promise<SpoolRow> {
  const row = (await readSpools()).find((s) => s.id === id);
  if (!row) throw new Error("Makara listede yok");
  return row;
}

interface UsageResponse {
  items: Array<{ id: string; grams: number; productName: string | null; createdAt: string }>;
  nextCursor: string | null;
  pace: { gramsPerDay: number; sampleCount: number; spanDays: number; windowGrams: number } | null;
}

async function readUsage(spoolId: string, query = ""): Promise<UsageResponse> {
  const request = new NextRequest(`http://localhost/api/spools/${spoolId}/usage${query}`);
  const response = await getUsage(request, { params: Promise.resolve({ id: spoolId }) });
  expect(response.status).toBe(200);
  return (await response.json()) as UsageResponse;
}

let spoolSeq = 0;

/** Verilen "kaç gün önce" listesine göre makara + tüketim kayıtları kurar. */
async function seedSpool(daysAgo: number[], grams = 100) {
  spoolSeq += 1;
  const spool = await db.filamentSpool.create({
    data: {
      name: `Test makara ${spoolSeq}`,
      material: "PLA",
      totalGrams: 1000,
      remainingGrams: 400,
    },
  });
  for (const days of daysAgo) {
    await db.filamentUsage.create({
      data: {
        spoolId: spool.id,
        grams,
        productName: `Ürün ${days}`,
        createdAt: new Date(Date.now() - days * DAY_MS),
      },
    });
  }
  return spool;
}

beforeAll(async () => {
  ({ GET: getUsage } = await import("./[id]/usage/route"));
  ({ GET: listSpools } = await import("./route"));
  ({ DELETE: deleteSpool } = await import("./[id]/route"));
  ({ prisma: db } = await import("@/lib/prisma"));
  // Makara/tüketim tabloları migration'larda değil, çalışma anı şemasında tanımlı.
  const { ensureRuntimeSchema } = await import("@/lib/runtime-schema");
  await ensureRuntimeSchema();
});

afterAll(async () => {
  await db?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("makara tüketim geçmişi ucu", () => {
  it("kayıtları en yeniden eskiye verir ve imleçle sayfalar", async () => {
    const spool = await seedSpool([1, 2, 3, 4, 5]);

    const first = await readUsage(spool.id, "?limit=2");
    expect(first.items).toHaveLength(2);
    expect(first.items[0].productName).toBe("Ürün 1");
    expect(first.items[1].productName).toBe("Ürün 2");
    expect(first.nextCursor).toBe(first.items[1].id);

    const second = await readUsage(spool.id, `?limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((i) => i.productName)).toEqual(["Ürün 3", "Ürün 4"]);

    const third = await readUsage(spool.id, `?limit=2&cursor=${second.nextCursor}`);
    expect(third.items.map((i) => i.productName)).toEqual(["Ürün 5"]);
    // Son sayfada devamı olmadığı için imleç kapanır.
    expect(third.nextCursor).toBeNull();
  });

  it("yalnız kendi makarasının kayıtlarını döndürür", async () => {
    const mine = await seedSpool([1, 2, 3]);
    await seedSpool([1, 2, 3]);

    const page = await readUsage(mine.id);
    expect(page.items).toHaveLength(3);
    const rows = await db.filamentUsage.findMany({ where: { id: { in: page.items.map((i) => i.id) } } });
    expect(rows.every((r) => r.spoolId === mine.id)).toBe(true);
  });

  it("yeterli geçmiş yokken tüketim hızı üretmez", async () => {
    const spool = await seedSpool([2, 9]);
    const page = await readUsage(spool.id);
    expect(page.items).toHaveLength(2);
    expect(page.pace).toBeNull();
  });

  it("kayıtlar birkaç güne sıkışmışsa hız üretmez", async () => {
    const spool = await seedSpool([0, 1, 2]);
    const page = await readUsage(spool.id);
    expect(page.pace).toBeNull();
  });

  it("uzun süredir kullanılmayan makarada hız üretmez", async () => {
    const spool = await seedSpool([60, 75, 90, 100]);
    const page = await readUsage(spool.id);
    expect(page.items).toHaveLength(4);
    expect(page.pace).toBeNull();
  });

  it("yeterli geçmişte günlük tüketim hızını hesaplar", async () => {
    const spool = await seedSpool([0, 3, 6, 10], 100);
    const page = await readUsage(spool.id);
    expect(page.pace).not.toBeNull();
    expect(page.pace?.sampleCount).toBe(4);
    expect(page.pace?.windowGrams).toBe(400);
    // 400 g / ~10 gün → günde ~40 g.
    expect(page.pace?.gramsPerDay).toBeGreaterThan(39);
    expect(page.pace?.gramsPerDay).toBeLessThan(41);
  });

  it("sonraki sayfalarda hız göndermez", async () => {
    const spool = await seedSpool([0, 3, 6, 10], 100);
    const first = await readUsage(spool.id, "?limit=3");
    expect(first.pace).not.toBeNull();

    const second = await readUsage(spool.id, `?limit=3&cursor=${first.nextCursor}`);
    expect(second.items).toHaveLength(1);
    expect(second.pace).toBeNull();
  });

  it("kaydı olmayan makarada boş liste döner", async () => {
    const spool = await seedSpool([]);
    const page = await readUsage(spool.id);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.pace).toBeNull();
  });
});

/** Alış bedeli ve malzemesi verilmiş bir makara kurar (gram maliyeti karşılaştırması için). */
async function seedPricedSpool(material: string, spoolCost: number | null, totalGrams = 1000) {
  spoolSeq += 1;
  return db.filamentSpool.create({
    data: {
      name: `Fiyatlı makara ${spoolSeq}`,
      material,
      totalGrams,
      remainingGrams: totalGrams,
      spoolCost,
    },
  });
}

describe("makara listesi gram maliyeti karşılaştırması", () => {
  beforeEach(async () => {
    await db.filamentUsage.deleteMany({});
    await db.filamentSpool.deleteMany({});
    await db.filamentType.deleteMany({});
  });

  it("belirgin fark varsa gerçek ve tablodaki gram maliyetini birlikte verir", async () => {
    await db.filamentType.create({ data: { name: "PLA", costPerGram: 0.55 } });
    const spool = await seedPricedSpool("PLA", 740);

    const row = await findSpool(spool.id);
    expect(row.costGap).not.toBeNull();
    expect(row.costGap?.actualPerGram).toBeCloseTo(0.74, 5);
    expect(row.costGap?.tablePerGram).toBeCloseTo(0.55, 5);
  });

  it("fark küçükken uyarı üretmez", async () => {
    await db.filamentType.create({ data: { name: "PLA", costPerGram: 0.55 } });
    const spool = await seedPricedSpool("PLA", 570);

    const row = await findSpool(spool.id);
    expect(row.costGap).toBeNull();
  });

  it("alış bedeli girilmemiş makarada karşılaştırma yapmaz", async () => {
    await db.filamentType.create({ data: { name: "PLA", costPerGram: 0.55 } });
    const spool = await seedPricedSpool("PLA", null);

    const row = await findSpool(spool.id);
    expect(row.costGap).toBeNull();
  });

  it("malzeme tabloda yoksa karşılaştırma yapmaz", async () => {
    await db.filamentType.create({ data: { name: "PETG", costPerGram: 0.55 } });
    const spool = await seedPricedSpool("ABS", 900);

    const row = await findSpool(spool.id);
    expect(row.costGap).toBeNull();
  });

  it("aynı malzemeye birden çok satır varsa yanlış satırla eşleşmez", async () => {
    await db.filamentType.create({ data: { name: "PLA Ucuz", costPerGram: 0.4 } });
    await db.filamentType.create({ data: { name: "PLA Premium", costPerGram: 0.9 } });
    const spool = await seedPricedSpool("PLA", 740);

    const row = await findSpool(spool.id);
    expect(row.costGap).toBeNull();
  });

  it("pasif filament satırını hesaba katmaz", async () => {
    await db.filamentType.create({ data: { name: "PLA", costPerGram: 0.55, isActive: false } });
    const spool = await seedPricedSpool("PLA", 740);

    const row = await findSpool(spool.id);
    expect(row.costGap).toBeNull();
  });

  it("büyük/küçük harf ve boşluk farkına takılmaz", async () => {
    await db.filamentType.create({ data: { name: " pla+ ", costPerGram: 0.5 } });
    const spool = await seedPricedSpool("PLA+", 800);

    const row = await findSpool(spool.id);
    expect(row.costGap?.actualPerGram).toBeCloseTo(0.8, 5);
  });
});

/**
 * Silme ucu — kullanıcı "sile basıyorum hiçbir şey olmuyor" dediğinde bulunan gerilemenin
 * koruması. Buradaki iki davranış SIRAYA bağlı ve şema tek başına garanti etmiyor:
 * çalışma anı tablosunda yabancı anahtar yok, yani "cascade" veritabanı tarafından
 * uygulanmıyor — tüketim satırlarını rota elle siliyor.
 */
describe("makara silme ucu", () => {
  const cagir = (id: string) =>
    deleteSpool(new NextRequest(`http://localhost/api/spools/${id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id }),
    });

  it("makarayı ve tüketim kayıtlarını birlikte siler", async () => {
    const spool = await seedSpool([1, 2, 3]);
    expect(await db.filamentUsage.count({ where: { spoolId: spool.id } })).toBe(3);

    const response = await cagir(spool.id);

    expect(response.status).toBe(200);
    expect(await db.filamentSpool.findUnique({ where: { id: spool.id } })).toBeNull();
    // Şemada "cascade" yazıyor diye bu satır silinirse kayıtlar sessizce öksüz kalır.
    expect(await db.filamentUsage.count({ where: { spoolId: spool.id } })).toBe(0);
  });

  it("başka makaranın kayıtlarına dokunmaz", async () => {
    const silinecek = await seedSpool([1, 2]);
    const kalacak = await seedSpool([1, 2, 3]);

    expect((await cagir(silinecek.id)).status).toBe(200);

    expect(await db.filamentSpool.findUnique({ where: { id: kalacak.id } })).not.toBeNull();
    expect(await db.filamentUsage.count({ where: { spoolId: kalacak.id } })).toBe(3);
  });

  it("zaten silinmiş satırda hata vermez (çift tık / eski liste)", async () => {
    const spool = await seedSpool([1]);
    expect((await cagir(spool.id)).status).toBe(200);

    // İkinci çağrı da başarı dönmeli: kullanıcı açısından sonuç aynı, arayüz satırı geri koymamalı.
    expect((await cagir(spool.id)).status).toBe(200);
  });
});
