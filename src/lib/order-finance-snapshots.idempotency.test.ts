/**
 * "DEĞİŞEN-ONLY" sözleşmesinin ISO-METİN (Turso/libSQL adapter) modundaki regresyon testi.
 *
 * NEDEN AYRI DOSYA: `order-finance-snapshots.write.test.ts` klasik yerel motorda (epoch-ms
 * tamsayı) koşuyor. Üretim ise libSQL adapter'ı üzerinden ISO-8601 METİN yazıyor. Aynı kodun
 * iki depolama biçiminde farklı davranması tam olarak bu projede yaşandı; buradaki testler
 * ÜRETİMDEKİ biçimde koşar (TURSO_DATABASE_URL bir dosyaya işaret ettiğinde adapter devreye
 * girer, ağ gerekmez).
 *
 * NEDEN VAR (ölçüldü 13 Ağu 2026): art arda üç sipariş yenilemesinde, aradaki 70 saniyede
 * hiçbir sipariş değişmediği hâlde 193 sipariş özeti + 221 kalem satırı yeniden yazıldı.
 * Uzak-HTTP'de her yazma ~96ms ve TEK SIRA hâlinde ilerlediği için bu, yalnız Raporlar'ı
 * değil TÜM uygulamayı bekletiyordu. Aşağıdaki testler yazımın:
 *   • temiz veride idempotent olduğunu,
 *   • ESKİ biçimde (epoch-ms tamsayı, 'Z' ekli ISO, milisaniyesiz ISO, yerel ofsetli ISO,
 *     SQLite metni) kayıtlı satırları EN FAZLA bir kez düzelttiğini,
 *   • ve bir yazma olduğunda SEBEBİNİ (hangi alan) bildirdiğini
 * kilitler. Sebep bildirimi olmadan bu sorunun kaynağını bulmak elle veritabanı arkeolojisi
 * gerektirdi.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  FinanceSnapshotItem,
  FinanceSnapshotOrder,
} from "./order-finance-snapshots";

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-iso-idem-"));
const dbFile = path.join(tempDir, "iso.db").replace(/\\/g, "/");
// TURSO_DATABASE_URL set edilince hem prisma.ts libSQL adapter'ına geçer hem de
// sqlite-date.ts kanonik biçimi "iso-text" seçer — üretimdeki ikilinin aynısı.
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.DATABASE_URL = `file:${dbFile}`;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.TURSO_REPLICA_PATH;

let persist: typeof import("./order-finance-snapshots").persistOrderFinanceSnapshots;
let db: typeof import("@/lib/prisma").prisma;

const ORDERED_AT = "2026-07-24T00:11:36.791Z";

function order(id: string, overrides: Partial<FinanceSnapshotOrder> = {}): FinanceSnapshotOrder {
  return {
    platform: "trendyol",
    id,
    orderNumber: `no-${id}`,
    date: ORDERED_AT,
    total: 499.99,
    profit: 55.59,
    profitPartial: false,
    profitSource: "calculated",
    estimatedCommission: 35,
    actualCommission: null,
    statusKind: "delivered",
    currency: "TRY",
    outputVat: 41.67,
    inputVatCredit: 9.5,
    ...overrides,
  };
}

function line(): FinanceSnapshotItem {
  return { productId: "p1", productName: "Kedi Figürü", quantity: 1, unitPrice: 499.99 };
}

beforeAll(async () => {
  const { ensureRuntimeSchema } = await import("./runtime-schema");
  ({ persistOrderFinanceSnapshots: persist } = await import("./order-finance-snapshots"));
  ({ prisma: db } = await import("@/lib/prisma"));
  await ensureRuntimeSchema();
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  // Toplu yazım için açılan ikinci libSQL istemcisi (libsql-batch.ts) dosya tanıtıcısını
  // tutmaya devam edebiliyor; Windows'ta silme EBUSY veriyor. Geçici klasörün silinememesi
  // testin sonucunu etkilemez.
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* geçici dosya işletim sistemine bırakılır */
  }
});

describe("ISO-metin (Turso) modunda yazım idempotent", () => {
  it("depolama biçimi gerçekten ISO metin (üretimin yolu test ediliyor)", async () => {
    await persist([order("ty-fmt")], new Map([["ty-fmt", [line()]]]));
    const [row] = await db.$queryRawUnsafe<Array<{ t: string }>>(
      `SELECT typeof("orderedAt") AS t FROM "OrderFinanceSnapshot" WHERE "externalOrderId" = 'ty-fmt'`
    );
    expect(row.t).toBe("text");
  });

  it("ikinci ve üçüncü turda HİÇBİR satır yazmaz", async () => {
    const orders = [order("ty-a"), order("ty-b")];
    const items = new Map([
      ["ty-a", [line()]],
      ["ty-b", [line()]],
    ]);

    const first = await persist(orders, items);
    expect(first.writtenOrders).toBe(2);
    expect(first.writtenItems).toBe(2);
    expect(first.writeReasons).toEqual({ new: 2 });

    const second = await persist(orders, items);
    const third = await persist(orders, items);
    expect(second).toMatchObject({ writtenOrders: 0, writtenItems: 0 });
    expect(second.writeReasons).toEqual({});
    expect(second.itemWriteReasons).toEqual({});
    expect(third).toMatchObject({ writtenOrders: 0, writtenItems: 0 });
  });

  it("bir yazma olduğunda SEBEBİNİ (alan adını) bildirir", async () => {
    await persist([order("ty-reason")], new Map([["ty-reason", [line()]]]));

    // Yalnız durum değişti: tek alan, tek sebep.
    const result = await persist(
      [order("ty-reason", { statusKind: "shipped" })],
      new Map([["ty-reason", [line()]]])
    );

    expect(result.writeReasons).toEqual({ statusKind: 1 });
    expect(result.itemWriteReasons).toEqual({ statusKind: 1 });
  });
});

/**
 * Eski satırlar farklı yazıcılar (eski masaüstü sürümleri, telefon) tarafından farklı tarih
 * biçimlerinde bırakıldı. Bunların HER YENİLEMEDE yeniden yazılması = kalıcı gereksiz yük.
 * En fazla BİR kez düzeltilmeli, sonra susmalı.
 */
describe("eski biçimde kayıtlı satırlar en fazla BİR kez düzeltilir", () => {
  const SHAPES: Record<string, string | number> = {
    isoOffset: "2026-07-24T00:11:36.791+00:00",
    isoZ: "2026-07-24T00:11:36.791Z",
    isoNoMs: "2026-07-24T00:11:36+00:00",
    isoLocal: "2026-07-24T03:11:36.791+03:00",
    sqliteText: "2026-07-24 00:11:36",
    epochMs: new Date(ORDERED_AT).getTime(),
  };

  it.each(Object.entries(SHAPES))("%s biçimi ikinci turda yazmaz", async (name, stored) => {
    const id = `ty-old-${name}`;
    // Eski satır: profitSource/KDV kolonları henüz doldurulmamış, sürüm damgası 1.
    await db.$executeRawUnsafe(
      `INSERT INTO "OrderFinanceSnapshot"
         ("id","platform","externalOrderId","orderNumber","orderedAt","revenueKurus","profitKurus",
          "profitPartial","statusKind","currency","calculationVersion","syncedAt")
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      `finance:trendyol:${id}`,
      "trendyol",
      id,
      `no-${id}`,
      stored,
      49_999,
      5_559,
      0,
      "delivered",
      "TRY",
      1,
      "2026-07-24T07:47:19.328+00:00"
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "OrderItemSnapshot"
         ("id","platform","externalOrderId","lineIndex","orderedAt","productId","productName",
          "quantity","unitPriceKurus","lineRevenueKurus","statusKind","currency","syncedAt")
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      `item:trendyol:${id}:0`,
      "trendyol",
      id,
      0,
      stored,
      "p1",
      "Kedi Figürü",
      1,
      49_999,
      49_999,
      "delivered",
      "TRY",
      "2026-07-24T07:47:19.328+00:00"
    );

    const items = new Map([[id, [line()]]]);
    await persist([order(id)], items);

    const second = await persist([order(id)], items);
    const third = await persist([order(id)], items);
    expect(second).toMatchObject({ writtenOrders: 0, writtenItems: 0 });
    expect(third).toMatchObject({ writtenOrders: 0, writtenItems: 0 });
  });
});
