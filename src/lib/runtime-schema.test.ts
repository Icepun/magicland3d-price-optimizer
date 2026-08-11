import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * AÇILIŞ ŞEMA GÖÇÜ — uygulamanın her başlangıçta çalıştırdığı en riskli kod.
 *
 * Denetimde "1127 satır, tamamen testsiz ve elle sürüm artırmaya bağlı" diye işaretlenmişti:
 * buradaki bir hata uygulamanın HİÇ açılmamasına yol açar. Bu test en azından şunları kilitler:
 * göç sıfırdan çalışır, İKİ KEZ çalıştırılabilir (idempotent), beklenen tablolar ve tekillik
 * kısıtları gerçekten oluşur.
 */
const tempDir = mkdtempSync(path.join(tmpdir(), "magicland-schema-test-"));
process.env.DATABASE_URL = `file:${path.join(tempDir, "schema.db")}`;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

let db: typeof import("@/lib/prisma").prisma;

beforeAll(async () => {
  const runtime = await import("./runtime-schema");
  ({ prisma: db } = await import("@/lib/prisma"));
  // Sıfırdan kurulum + hemen ardından ikinci tur: göç idempotent olmalı.
  await runtime.ensureRuntimeSchema();
  await runtime.ensureRuntimeSchema();
});

async function tableNames(): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
  );
  return rows.map((r) => r.name);
}

describe("açılış şema göçü", () => {
  it("iki kez çalıştırıldığında hata vermez ve tabloları kurar", async () => {
    const names = await tableNames();
    // Uygulamanın çalışması için zorunlu çekirdek tablolar.
    for (const t of [
      "Product",
      "ProductCost",
      "Listing",
      "AppSetting",
      "CommissionRule",
      "CargoRule",
      "ExpenseRule",
      "OrderFinanceSnapshot",
      "ManualOrder",
      "FilamentType",
      "FilamentSpool",
      "Notification",
    ]) {
      expect(names, `${t} tablosu kurulmalı`).toContain(t);
    }
  });

  it("sipariş kalemi geçmişi tablosunu ve indekslerini kurar", async () => {
    expect(await tableNames()).toContain("OrderItemSnapshot");

    const idx = await db.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='OrderItemSnapshot'`
    );
    // Tekillik + sorgu indeksleri; adları değil VARLIKLARI önemli.
    expect(idx.length).toBeGreaterThanOrEqual(3);
  });

  /**
   * Tekilleştirme anahtarı bozulursa aynı sipariş her yenilemede satır ÇOĞALTIR ve
   * ürün bazlı satış raporu sessizce şişer. Bu yüzden veritabanı seviyesinde kilitli.
   */
  it("aynı siparişin aynı satırını ikinci kez yazmaya izin vermez", async () => {
    const satir = (id: string) =>
      db.$executeRawUnsafe(
        `INSERT INTO OrderItemSnapshot
           (id, platform, externalOrderId, lineIndex, orderedAt, productName, quantity,
            unitPriceKurus, lineRevenueKurus, statusKind)
         VALUES (?, 'shopify', 'SIPARIS-1', 0, 1754870000000, 'Test ürünü', 1, 10000, 10000, 'delivered')`,
        id
      );

    await satir("satir-a");
    await expect(satir("satir-b")).rejects.toThrow();

    const kalan = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*) AS n FROM OrderItemSnapshot WHERE externalOrderId = 'SIPARIS-1'`
    );
    expect(Number(kalan[0].n)).toBe(1);
  });

  it("aynı siparişin FARKLI satırlarını kabul eder", async () => {
    await db.$executeRawUnsafe(
      `INSERT INTO OrderItemSnapshot
         (id, platform, externalOrderId, lineIndex, orderedAt, productName, quantity,
          unitPriceKurus, lineRevenueKurus, statusKind)
       VALUES ('satir-c', 'shopify', 'SIPARIS-1', 1, 1754870000000, 'İkinci ürün', 2, 5000, 10000, 'delivered')`
    );
    const kalan = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*) AS n FROM OrderItemSnapshot WHERE externalOrderId = 'SIPARIS-1'`
    );
    expect(Number(kalan[0].n)).toBe(2);
  });
});
