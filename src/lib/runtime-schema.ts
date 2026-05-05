import { prisma } from "@/lib/prisma";

let schemaReady: Promise<void> | null = null;

async function tableExists(tableName: string) {
  const tables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    tableName
  );
  return tables.length > 0;
}

async function ensureColumn(tableName: string, columnName: string, definition: string) {
  if (!(await tableExists(tableName))) return;

  const columns = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `PRAGMA table_info("${tableName}")`
  );
  if (!columns.some((column) => column.name === columnName)) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${definition}`
    );
  }
}

export function ensureRuntimeSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Product" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "barcode" TEXT NOT NULL,
        "sku" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "categoryName" TEXT NOT NULL,
        "currentSalePrice" REAL NOT NULL,
        "listPrice" REAL,
        "stock" INTEGER NOT NULL DEFAULT 0,
        "desi" REAL,
        "weight" REAL,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "source" TEXT NOT NULL DEFAULT 'manual',
        "trendyolId" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "Product_barcode_key" ON "Product"("barcode")
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ProductCost" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "productId" TEXT NOT NULL,
        "costMode" TEXT NOT NULL DEFAULT 'manual',
        "templateId" TEXT,
        "manualCost" REAL,
        "materialWeight" REAL,
        "printTimeHours" REAL,
        "materialCost" REAL,
        "electricityCost" REAL,
        "machineWearCost" REAL,
        "packagingCost" REAL,
        "laborCost" REAL,
        "otherCost" REAL,
        "wasteRate" REAL,
        "totalCost" REAL,
        "updatedAt" DATETIME NOT NULL
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ProductCost_productId_key" ON "ProductCost"("productId")
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Recommendation" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "productId" TEXT NOT NULL,
        "currentPrice" REAL NOT NULL,
        "recommendedPrice" REAL NOT NULL,
        "currentProfit" REAL NOT NULL,
        "recommendedProfit" REAL NOT NULL,
        "profitDifference" REAL NOT NULL,
        "currentMargin" REAL NOT NULL,
        "recommendedMargin" REAL NOT NULL,
        "reason" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'ready',
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "AppSetting" (
        "key" TEXT NOT NULL PRIMARY KEY,
        "value" TEXT NOT NULL
      )
    `);

    await ensureColumn("Product", "trendyolId", "TEXT");
    await ensureColumn("Product", "source", "TEXT NOT NULL DEFAULT 'manual'");
    await ensureColumn("Product", "createdAt", "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP");
    await ensureColumn("Product", "updatedAt", "DATETIME");
    await ensureColumn("Product", "desi", "REAL");
    await ensureColumn("Product", "weight", "REAL");
    await ensureColumn("Product", "listPrice", "REAL");
    await ensureColumn("Product", "isActive", "BOOLEAN NOT NULL DEFAULT true");
    await ensureColumn("Product", "imageUrl", "TEXT");
  })();

  return schemaReady;
}
