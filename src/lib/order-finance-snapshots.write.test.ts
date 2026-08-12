/**
 * Faz A regresyon testi: snapshot yazımı DEĞİŞEN-ONLY olmalı.
 *
 * Eskiden her sipariş yenilemesi 180 satırın tamamını yeniden yazıyordu (~190 ardışık uzak
 * ifade ≈ 18sn) ve libSQL adapter'ın süreç genelindeki tek kilidini o süre boyunca tutuyordu.
 * Bu test, değişmemiş satırlara HİÇ yazılmadığını `syncedAt` damgasının sabit kalmasıyla
 * kanıtlar — mock değil, gerçek SQLite üzerinde davranış testi.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  FinanceSnapshotItem,
  FinanceSnapshotOrder,
} from "./order-finance-snapshots";

const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-snapshot-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "test.db")}`;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

let persist: typeof import("./order-finance-snapshots").persistOrderFinanceSnapshots;
let schedule: typeof import("./order-finance-snapshots").scheduleOrderFinanceSnapshots;
let flush: typeof import("./order-finance-snapshots").flushOrderFinanceSnapshots;
let lastWrite: typeof import("./order-finance-snapshots").lastOrderFinanceSnapshotWrite;
let inFlight: typeof import("./order-finance-snapshots").orderFinanceSnapshotWriteInFlight;
let db: typeof import("@/lib/prisma").prisma;

function order(overrides: Partial<FinanceSnapshotOrder> = {}): FinanceSnapshotOrder {
  return {
    platform: "trendyol",
    id: "ty-1001",
    orderNumber: "1001",
    date: "2026-07-01T10:00:00.000Z",
    total: 249.99,
    profit: 65.25,
    profitPartial: false,
    profitSource: "calculated",
    estimatedCommission: 35,
    actualCommission: null,
    statusKind: "delivered",
    currency: "TRY",
    ...overrides,
  };
}

function items(...rows: Array<Partial<FinanceSnapshotItem>>): FinanceSnapshotItem[] {
  return rows.map((row) => ({
    productId: row.productId ?? null,
    productName: row.productName ?? "Ürün",
    quantity: row.quantity ?? 1,
    unitPrice: row.unitPrice ?? 100,
  }));
}

/** Kalem satırları — Prisma istemcisi yeniden üretilmeden çalışsın diye ham sorguyla okunur. */
async function itemRows(
  externalOrderId: string
): Promise<Array<Record<string, unknown>>> {
  return db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT "lineIndex","productId","productName","quantity","unitPriceKurus",
            "lineRevenueKurus","statusKind","currency","syncedAt"
       FROM "OrderItemSnapshot" WHERE "externalOrderId" = ? ORDER BY "lineIndex"`,
    externalOrderId
  );
}

async function syncedAtOf(externalOrderId: string): Promise<number | null> {
  const row = await db.orderFinanceSnapshot.findFirst({
    where: { externalOrderId },
    select: { syncedAt: true },
  });
  return row ? row.syncedAt.getTime() : null;
}

beforeAll(async () => {
  const { ensureRuntimeSchema } = await import("./runtime-schema");
  ({
    persistOrderFinanceSnapshots: persist,
    scheduleOrderFinanceSnapshots: schedule,
    flushOrderFinanceSnapshots: flush,
    lastOrderFinanceSnapshotWrite: lastWrite,
    orderFinanceSnapshotWriteInFlight: inFlight,
  } = await import("./order-finance-snapshots"));
  ({ prisma: db } = await import("@/lib/prisma"));
  await ensureRuntimeSchema();
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("persistOrderFinanceSnapshots — değişen-only yazma", () => {
  it("ilk çağrıda satırı oluşturur", async () => {
    await persist([order()]);
    const row = await db.orderFinanceSnapshot.findFirst({
      where: { externalOrderId: "ty-1001" },
    });
    expect(row).not.toBeNull();
    expect(row!.revenueKurus).toBe(24_999);
    expect(row!.profitKurus).toBe(6_525);
  });

  it("AYNI veriyle tekrar çağrılınca satıra HİÇ yazmaz (syncedAt sabit kalır)", async () => {
    const before = await syncedAtOf("ty-1001");
    expect(before).not.toBeNull();

    await new Promise((r) => setTimeout(r, 30)); // damga değişebilseydi fark ederdik
    await persist([order()]);

    const after = await syncedAtOf("ty-1001");
    expect(after).toBe(before); // ← yazma olmadı
  });

  it("gelir değişince O satırı yazar", async () => {
    const before = await syncedAtOf("ty-1001");
    await new Promise((r) => setTimeout(r, 30));

    await persist([order({ total: 199.99, profit: 40 })]);

    const after = await syncedAtOf("ty-1001");
    expect(after).not.toBe(before); // ← yazma oldu
    const row = await db.orderFinanceSnapshot.findFirst({
      where: { externalOrderId: "ty-1001" },
    });
    expect(row!.revenueKurus).toBe(19_999);
  });

  it("çok siparişte YALNIZ değişeni yazar, diğerlerine dokunmaz", async () => {
    const a = order({ id: "ty-2001", orderNumber: "2001" });
    const b = order({ id: "ty-2002", orderNumber: "2002", total: 100, profit: 20 });
    const c = order({ id: "ty-2003", orderNumber: "2003", total: 300, profit: 90 });
    await persist([a, b, c]);

    const beforeA = await syncedAtOf("ty-2001");
    const beforeB = await syncedAtOf("ty-2002");
    const beforeC = await syncedAtOf("ty-2003");
    await new Promise((r) => setTimeout(r, 30));

    // Yalnız b değişti
    await persist([a, { ...b, total: 150, profit: 35 }, c]);

    expect(await syncedAtOf("ty-2001")).toBe(beforeA); // dokunulmadı
    expect(await syncedAtOf("ty-2003")).toBe(beforeC); // dokunulmadı
    expect(await syncedAtOf("ty-2002")).not.toBe(beforeB); // yazıldı
  });

  it("platform kaynaklı gerçek komisyon gelince yazar ve profitSource'u yükseltir", async () => {
    const base = order({ id: "ty-3001", orderNumber: "3001" });
    await persist([base]);
    const before = await syncedAtOf("ty-3001");
    await new Promise((r) => setTimeout(r, 30));

    await persist([
      { ...base, profit: 67.5, profitSource: "platform", actualCommission: 32.5 },
    ]);

    const row = await db.orderFinanceSnapshot.findFirst({
      where: { externalOrderId: "ty-3001" },
    });
    expect(await syncedAtOf("ty-3001")).not.toBe(before);
    expect(row!.profitSource).toBe("platform");
    expect(row!.actualCommissionKurus).toBe(3_250);
    expect(row!.profitKurus).toBe(6_750);
  });

  it("platform kârı yakalandıktan sonra AYNI veriyle tekrar yazmaz", async () => {
    const settled = order({
      id: "ty-3001",
      orderNumber: "3001",
      profit: 67.5,
      profitSource: "platform",
      actualCommission: 32.5,
    });
    const before = await syncedAtOf("ty-3001");
    await new Promise((r) => setTimeout(r, 30));

    await persist([settled]);

    expect(await syncedAtOf("ty-3001")).toBe(before); // ← idempotent
  });

  /**
   * KDV kolonları olmadan pazaryeri siparişlerinin KDV'si hiçbir yere yazılmıyor, aylık özet
   * de onları "bilinmiyor" sayıp kapsam dışında bırakıyordu.
   */
  it("motorun KDV çıktısını kuruş olarak saklar", async () => {
    await persist([
      order({ id: "ty-7001", orderNumber: "7001", outputVat: 41.67, inputVatCredit: 9.5 }),
    ]);

    const row = await db.orderFinanceSnapshot.findFirst({
      where: { externalOrderId: "ty-7001" },
    });
    expect(row!.outputVatKurus).toBe(4_167);
    expect(row!.inputVatCreditKurus).toBe(950);
  });

  it("KDV verilmeyen siparişte alanları BOŞ bırakır (uydurma sıfır yazmaz)", async () => {
    await persist([order({ id: "ty-7002", orderNumber: "7002" })]);

    const row = await db.orderFinanceSnapshot.findFirst({
      where: { externalOrderId: "ty-7002" },
    });
    expect(row!.outputVatKurus).toBeNull();
    expect(row!.inputVatCreditKurus).toBeNull();
  });

  /**
   * KDV kolonları eklenmeden önce yazılmış satırlar boştur. Kullanıcıyı "yeniden hesapla"ya
   * mecbur bırakmadan, ilk normal yenilemede dolmaları gerekir.
   */
  it("KDV'si boş olan eski satırı ilk yenilemede doldurur", async () => {
    await persist([order({ id: "ty-7003", orderNumber: "7003" })]);
    const before = await syncedAtOf("ty-7003");
    await new Promise((r) => setTimeout(r, 30));

    await persist([
      order({ id: "ty-7003", orderNumber: "7003", outputVat: 50, inputVatCredit: 12 }),
    ]);

    expect(await syncedAtOf("ty-7003")).not.toBe(before); // ← yazma oldu
    const row = await db.orderFinanceSnapshot.findFirst({
      where: { externalOrderId: "ty-7003" },
    });
    expect(row!.outputVatKurus).toBe(5_000);
    expect(row!.inputVatCreditKurus).toBe(1_200);
  });

  it("KDV yakalandıktan sonra aynı veriyle tekrar YAZMAZ", async () => {
    const settled = order({
      id: "ty-7003",
      orderNumber: "7003",
      outputVat: 50,
      inputVatCredit: 12,
    });
    const before = await syncedAtOf("ty-7003");
    await new Promise((r) => setTimeout(r, 30));

    await persist([settled]);

    expect(await syncedAtOf("ty-7003")).toBe(before); // ← değişen-only sözleşmesi korundu
  });

  it("KDV taşımayan bir tur, kayıtlı KDV'yi SİLMEZ", async () => {
    await persist([
      order({ id: "ty-7004", orderNumber: "7004", outputVat: 33.33, inputVatCredit: 8 }),
    ]);

    // Aynı sipariş, gelirle birlikte (KDV alanları verilmeden) yeniden yazılıyor.
    await persist([order({ id: "ty-7004", orderNumber: "7004", total: 199.99, profit: 40 })]);

    const row = await db.orderFinanceSnapshot.findFirst({
      where: { externalOrderId: "ty-7004" },
    });
    expect(row!.revenueKurus).toBe(19_999);
    expect(row!.outputVatKurus).toBe(3_333);
    expect(row!.inputVatCreditKurus).toBe(800);
  });

  it("kalem verilmeyen sipariş için kalem geçmişine hiç dokunmaz", async () => {
    await persist([order({ id: "ty-4001", orderNumber: "4001" })]);
    expect(await itemRows("ty-4001")).toHaveLength(0);
  });

  it("manuel siparişi ve tarihsizi yok sayar (çift sayım koruması)", async () => {
    await persist([
      order({ platform: "manual", id: "manual-9", orderNumber: "M9" }),
      order({ id: "ty-9999", orderNumber: "9999", date: null }),
    ]);
    expect(
      await db.orderFinanceSnapshot.findFirst({ where: { externalOrderId: "manual-9" } })
    ).toBeNull();
    expect(
      await db.orderFinanceSnapshot.findFirst({ where: { externalOrderId: "ty-9999" } })
    ).toBeNull();
  });
});

describe("ürün bazlı satış geçmişi (kalem satırları)", () => {
  const base = order({ id: "ty-5001", orderNumber: "5001" });

  it("kalemleri sipariş özetiyle aynı turda kaydeder", async () => {
    await persist(
      [base],
      new Map([
        [
          "ty-5001",
          items(
            { productId: "p1", productName: "Kedi Figürü", quantity: 2, unitPrice: 74.9 },
            { productId: null, productName: "Bilinmeyen Ürün", quantity: 1, unitPrice: 100.2 }
          ),
        ],
      ])
    );

    const rows = await itemRows("ty-5001");
    expect(rows).toHaveLength(2);
    expect(Number(rows[0].quantity)).toBe(2);
    expect(String(rows[0].productId)).toBe("p1");
    expect(Number(rows[0].unitPriceKurus)).toBe(7_490);
    expect(Number(rows[0].lineRevenueKurus)).toBe(14_980);
    expect(rows[1].productId).toBeNull();
    expect(String(rows[1].productName)).toBe("Bilinmeyen Ürün");
    expect(String(rows[0].statusKind)).toBe("delivered");
  });

  it("aynı sipariş tekrar işlenince satırlar ÇOĞALMAZ ve yeniden yazılmaz", async () => {
    const sameItems = new Map([
      [
        "ty-5001",
        items(
          { productId: "p1", productName: "Kedi Figürü", quantity: 2, unitPrice: 74.9 },
          { productId: null, productName: "Bilinmeyen Ürün", quantity: 1, unitPrice: 100.2 }
        ),
      ],
    ]);
    const before = (await itemRows("ty-5001")).map((r) => Number(r.syncedAt));
    await new Promise((r) => setTimeout(r, 30));

    await persist([base], sameItems);

    const after = await itemRows("ty-5001");
    expect(after).toHaveLength(2);
    expect(after.map((r) => Number(r.syncedAt))).toEqual(before); // ← yazma olmadı
  });

  it("kalem sayısı azalınca artık satırları siler", async () => {
    await persist(
      [base],
      new Map([
        ["ty-5001", items({ productId: "p1", productName: "Kedi Figürü", quantity: 3, unitPrice: 74.9 })],
      ])
    );

    const rows = await itemRows("ty-5001");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].quantity)).toBe(3);
  });

  it("kalemler bir tur hiç gelmezse kayıtlı geçmişi SİLMEZ", async () => {
    await persist([base], new Map([["ty-5001", []]]));

    expect(await itemRows("ty-5001")).toHaveLength(1);
  });

  it("iptal edilen siparişin kalemlerini durumuyla birlikte saklar", async () => {
    const cancelled = order({
      id: "ty-5002",
      orderNumber: "5002",
      statusKind: "cancelled",
    });
    await persist(
      [cancelled],
      new Map([["ty-5002", items({ productId: "p9", productName: "İade Edilen", quantity: 1 })]])
    );

    const rows = await itemRows("ty-5002");
    expect(rows).toHaveLength(1);
    expect(String(rows[0].statusKind)).toBe("cancelled");
  });

  it("Shopify siparişini özetle aynı kanonik kimlik altında kaydeder", async () => {
    await persist(
      [
        order({
          platform: "shopify",
          id: "gid://shopify/Order/777",
          orderNumber: "#777",
        }),
      ],
      new Map([
        ["gid://shopify/Order/777", items({ productId: "p2", productName: "Kupa", quantity: 1 })],
      ])
    );

    expect(await itemRows("sh-777")).toHaveLength(1);
  });
});

/**
 * Yazım artık sipariş listesi YANITININ içinde değil. İlk dolumda yüzlerce satır yazılırken
 * uygulama donuyordu; bu testler çağıranın beklemediğini ve hatanın yutulmadığını kanıtlar.
 */
describe("arka plan yazımı (ateşle ve unut)", () => {
  it("çağıranı bekletmeden yazar", async () => {
    const target = order({ id: "ty-6001", orderNumber: "6001", total: 500, profit: 120 });

    schedule([target]);
    // Çağıran döndüğünde satır HENÜZ yazılmamıştır — yazım yanıt yolundan çıktı.
    expect(
      await db.orderFinanceSnapshot.findFirst({ where: { externalOrderId: "ty-6001" } })
    ).toBeNull();
    expect(inFlight()).toBe(true);

    await flush();

    const row = await db.orderFinanceSnapshot.findFirst({
      where: { externalOrderId: "ty-6001" },
    });
    expect(row!.revenueKurus).toBe(50_000);
    expect(inFlight()).toBe(false);
  });

  it("kalemleri de arka planda kaydeder ve tur sonucunu bildirir", async () => {
    schedule(
      [order({ id: "ty-6002", orderNumber: "6002" })],
      new Map([["ty-6002", items({ productId: "p7", productName: "Vazo", quantity: 2 })]])
    );
    await flush();

    expect(await itemRows("ty-6002")).toHaveLength(1);
    expect(lastWrite()).toMatchObject({ ok: true, writtenOrders: 1, writtenItems: 1 });
  });

  it("üst üste gelen turlarda son veri kazanır ve hata fırlatmaz", async () => {
    const base = order({ id: "ty-6003", orderNumber: "6003", total: 100, profit: 10 });
    schedule([base]);
    schedule([{ ...base, total: 250, profit: 40 }]);
    await flush();

    const row = await db.orderFinanceSnapshot.findFirst({
      where: { externalOrderId: "ty-6003" },
    });
    expect(row!.revenueKurus).toBe(25_000);
  });

  it("hata olursa çağıranı çökertmez ama son tur durumu hatayı taşır", async () => {
    // Kuruş sınırını aşan tutar yazım turunu düşürür — hata yutulmamalı.
    schedule([order({ id: "ty-6004", orderNumber: "6004", total: 9e12 })]);
    await flush();

    const status = lastWrite();
    expect(status?.ok).toBe(false);
    expect(status?.error).toBeTruthy();
    expect(
      await db.orderFinanceSnapshot.findFirst({ where: { externalOrderId: "ty-6004" } })
    ).toBeNull();
  });

  it("yazılacak sipariş yoksa hiç tur başlatmaz", () => {
    schedule([]);
    expect(inFlight()).toBe(false);
  });
});

/**
 * ⚠️ SESSİZ VERİ KAYBI KORUMASI — ham SQL yazımı Prisma ile AYNI depolama tipini kullanmalı.
 *
 * SQLite dinamik tiplidir: aynı kolona hem tamsayı hem metin yazılabilir ve tamsayı her
 * zaman metinden küçük sayılır. Bu yazım yolu Prisma'dan farklı bir tip kullanırsa
 * `orderedAt >= …` filtreleri bu satırların TAMAMINI sessizce eler — Raporlar 359 siparişin
 * 280'ini tam olarak bu yüzden göstermiyordu (v0.19.142).
 */
describe("ham SQL yazımı Prisma ile aynı tarih biçimini kullanır", () => {
  it("orderedAt/syncedAt depolama tipi Prisma'nın yazdığıyla birebir aynı", async () => {
    await persist([order({ id: "ty-tip-1", orderNumber: "TIP1" })]);
    await db.orderFinanceSnapshot.create({
      data: {
        id: "finance:trendyol:ty-tip-2",
        platform: "trendyol",
        externalOrderId: "ty-tip-2",
        orderNumber: "TIP2",
        orderedAt: new Date("2026-07-01T10:00:00.000Z"),
        revenueKurus: 24_999,
        statusKind: "delivered",
        syncedAt: new Date("2026-07-01T10:00:00.000Z"),
      },
    });

    const rows = await db.$queryRawUnsafe<
      Array<{ externalOrderId: string; ordType: string; syncType: string; ordRaw: string }>
    >(
      `SELECT "externalOrderId",
              typeof("orderedAt") AS "ordType",
              typeof("syncedAt")  AS "syncType",
              CAST("orderedAt" AS TEXT) AS "ordRaw"
         FROM "OrderFinanceSnapshot"
        WHERE "externalOrderId" IN ('ty-tip-1','ty-tip-2')
        ORDER BY "externalOrderId"`
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].ordType).toBe(rows[1].ordType);
    expect(rows[0].syncType).toBe(rows[1].syncType);
    // Aynı an → aynı ham değer (biçim de birebir aynı olmalı, yalnız tip değil).
    expect(rows[0].ordRaw).toBe(rows[1].ordRaw);
  });

  it("kalem geçmişi de aynı biçimi kullanır ve tarih filtresinden düşmez", async () => {
    await persist(
      [order({ id: "ty-tip-3", orderNumber: "TIP3", date: "2026-07-02T10:00:00.000Z" })],
      new Map([["ty-tip-3", items({ productName: "Kutu" })]])
    );
    const [item] = await db.$queryRawUnsafe<Array<{ t: string }>>(
      `SELECT typeof("orderedAt") AS t FROM "OrderItemSnapshot" WHERE "externalOrderId" = 'ty-tip-3'`
    );
    const [snapshot] = await db.$queryRawUnsafe<Array<{ t: string }>>(
      `SELECT typeof("orderedAt") AS t FROM "OrderFinanceSnapshot" WHERE "externalOrderId" = 'ty-tip-3'`
    );
    expect(item.t).toBe(snapshot.t);

    // Uçtan uca: Prisma'nın kendi tarih filtresi bu satırı GÖRMELİ.
    const found = await db.orderFinanceSnapshot.findMany({
      where: {
        externalOrderId: "ty-tip-3",
        orderedAt: { gte: new Date("2026-01-01T00:00:00.000Z") },
      },
      select: { externalOrderId: true },
    });
    expect(found.map((row) => row.externalOrderId)).toEqual(["ty-tip-3"]);
  });
});
