import { execute, query } from "@/lib/turso";

let cargoVatSchemaPromise: Promise<void> | null = null;
let financeSchemaPromise: Promise<void> | null = null;
let manualOrderSchemaPromise: Promise<void> | null = null;

/**
 * Mobil uygulama masaüstü açılmadan önce güncellenebilir. Bu yüzden kargo KDV kolonunu
 * ilk kargo sorgusundan önce Turso'da da güvenle hazırlarız.
 */
export function ensureCargoVatSchema(): Promise<void> {
  if (!cargoVatSchemaPromise) {
    cargoVatSchemaPromise = (async () => {
      const columns = await query<{ name: string }>(`PRAGMA table_info("CargoRule")`);
      if (columns.length === 0) {
        throw new Error("CargoRule tablosu bulunamadı.");
      }
      if (columns.some((column) => column.name === "vatIncluded")) return;

      try {
        await execute(
          `ALTER TABLE "CargoRule"
             ADD COLUMN "vatIncluded" INTEGER NOT NULL DEFAULT 1`
        );
      } catch (error) {
        // İki cihaz aynı anda güncellerse ikinci ALTER "duplicate column" dönebilir.
        const refreshed = await query<{ name: string }>(`PRAGMA table_info("CargoRule")`);
        if (!refreshed.some((column) => column.name === "vatIncluded")) throw error;
      }

      await execute(
        `UPDATE "CargoRule"
            SET "vatIncluded" = 0
          WHERE UPPER(COALESCE("cargoProvider", '')) LIKE '%TEX%'
             OR UPPER("name") LIKE '%TEX%'`
      );
    })().catch((error) => {
      cargoVatSchemaPromise = null;
      throw error;
    });
  }
  return cargoVatSchemaPromise;
}

/**
 * Finans geçmişi masaüstü açılmadan önce de kullanılabilsin diye gerekli tabloları
 * mobilde idempotent olarak hazırlar. AppSetting.schemaVersion masaüstü migration
 * yöneticisine aittir; burada özellikle değiştirilmez.
 */
export function ensureFinanceSchema(): Promise<void> {
  if (!financeSchemaPromise) {
    financeSchemaPromise = (async () => {
      await execute(
        `CREATE TABLE IF NOT EXISTS "ActualExpense" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "name" TEXT NOT NULL,
          "category" TEXT,
          "amountKurus" INTEGER NOT NULL,
          "paidAt" DATETIME NOT NULL,
          "note" TEXT,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" DATETIME NOT NULL
        )`
      );
      await execute(
        `CREATE INDEX IF NOT EXISTS "ActualExpense_paidAt_idx"
           ON "ActualExpense"("paidAt")`
      );
      await execute(
        `CREATE TABLE IF NOT EXISTS "OrderFinanceSnapshot" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "platform" TEXT NOT NULL,
          "externalOrderId" TEXT NOT NULL,
          "orderNumber" TEXT NOT NULL,
          "orderedAt" DATETIME NOT NULL,
          "revenueKurus" INTEGER NOT NULL,
          "profitKurus" INTEGER,
          "profitPartial" BOOLEAN NOT NULL DEFAULT 0,
          "statusKind" TEXT NOT NULL,
          "currency" TEXT NOT NULL DEFAULT 'TRY',
          "syncedAt" DATETIME NOT NULL,
          "calculationVersion" INTEGER NOT NULL DEFAULT 1,
          CONSTRAINT "OrderFinanceSnapshot_platform_externalOrderId_key"
            UNIQUE ("platform", "externalOrderId")
        )`
      );
      await execute(
        `CREATE INDEX IF NOT EXISTS "OrderFinanceSnapshot_orderedAt_idx"
           ON "OrderFinanceSnapshot"("orderedAt")`
      );
      await execute(
        `CREATE INDEX IF NOT EXISTS "OrderFinanceSnapshot_statusKind_orderedAt_idx"
           ON "OrderFinanceSnapshot"("statusKind", "orderedAt")`
      );
    })().catch((error) => {
      financeSchemaPromise = null;
      throw error;
    });
  }
  return financeSchemaPromise;
}

/**
 * Manuel siparişler mobil ve masaüstünde aynı Turso tablosunu kullanır. Kalemler ve hesap
 * dökümü sürümlü JSON olarak tek satırda tutulduğu için telefondaki create/update atomiktir.
 */
export function ensureManualOrderSchema(): Promise<void> {
  if (!manualOrderSchemaPromise) {
    manualOrderSchemaPromise = (async () => {
      await execute(
        `CREATE TABLE IF NOT EXISTS "ManualOrder" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "orderNumber" TEXT NOT NULL,
          "mode" TEXT NOT NULL,
          "orderedAt" DATETIME NOT NULL,
          "statusKind" TEXT NOT NULL,
          "customerName" TEXT,
          "currency" TEXT NOT NULL DEFAULT 'TRY',
          "revenueKurus" INTEGER NOT NULL,
          "netRevenueKurus" INTEGER NOT NULL,
          "totalCostKurus" INTEGER NOT NULL,
          "inputVatCreditKurus" INTEGER NOT NULL,
          "profitKurus" INTEGER,
          "profitPartial" BOOLEAN NOT NULL DEFAULT 0,
          "itemsJson" TEXT NOT NULL,
          "breakdownJson" TEXT NOT NULL,
          "calculationVersion" INTEGER NOT NULL DEFAULT 1,
          "note" TEXT,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" DATETIME NOT NULL,
          CONSTRAINT "ManualOrder_orderNumber_key" UNIQUE ("orderNumber")
        )`
      );
      await execute(
        `CREATE INDEX IF NOT EXISTS "ManualOrder_orderedAt_idx"
           ON "ManualOrder"("orderedAt")`
      );
      await execute(
        `CREATE INDEX IF NOT EXISTS "ManualOrder_statusKind_orderedAt_idx"
           ON "ManualOrder"("statusKind", "orderedAt")`
      );
    })().catch((error) => {
      manualOrderSchemaPromise = null;
      throw error;
    });
  }
  return manualOrderSchemaPromise;
}
