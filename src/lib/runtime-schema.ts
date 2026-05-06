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

async function cleanupPdfCommissionRules() {
  if (!(await tableExists("CommissionRule"))) return;

  const cleanupKey = "cleanupPdfCommissionRulesAt";
  const existing = await prisma.appSetting.findUnique({ where: { key: cleanupKey } });
  if (existing) return;

  await prisma.commissionRule.deleteMany({
    where: {
      name: {
        startsWith: "Trendyol PDF - ",
      },
    },
  });

  await prisma.appSetting.upsert({
    where: { key: cleanupKey },
    create: { key: cleanupKey, value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });
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
        "imageUrl" TEXT,
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
        "filamentTypeId" TEXT,
        "filamentWeight" REAL,
        "printTimeHours" REAL,
        "wasteRate" REAL,
        "packagingPoset" REAL,
        "packagingNaylon" REAL,
        "packagingBant" REAL,
        "packagingKart" REAL,
        "manualCost" REAL,
        "materialWeight" REAL,
        "materialCost" REAL,
        "electricityCost" REAL,
        "machineWearCost" REAL,
        "laborCost" REAL,
        "packagingCost" REAL,
        "otherCost" REAL,
        "totalCost" REAL,
        "updatedAt" DATETIME NOT NULL
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ProductCost_productId_key" ON "ProductCost"("productId")
    `);

    // FilamentType table
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "FilamentType" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "costPerGram" REAL NOT NULL,
        "isActive" BOOLEAN NOT NULL DEFAULT true
      )
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

    // Ensure new columns on existing tables
    await ensureColumn("Product", "trendyolId", "TEXT");
    await ensureColumn("Product", "source", "TEXT NOT NULL DEFAULT 'manual'");
    await ensureColumn("Product", "createdAt", "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP");
    await ensureColumn("Product", "updatedAt", "DATETIME");
    await ensureColumn("Product", "desi", "REAL");
    await ensureColumn("Product", "weight", "REAL");
    await ensureColumn("Product", "listPrice", "REAL");
    await ensureColumn("Product", "isActive", "BOOLEAN NOT NULL DEFAULT true");
    await ensureColumn("Product", "imageUrl", "TEXT");
    await ensureColumn("Product", "commissionRate", "REAL");
    await ensureColumn("Product", "commissionSource", "TEXT");
    await ensureColumn("Product", "commissionUpdatedAt", "DATETIME");

    // New ProductCost columns
    await ensureColumn("ProductCost", "filamentTypeId", "TEXT");
    await ensureColumn("ProductCost", "filamentWeight", "REAL");
    await ensureColumn("ProductCost", "printTimeHours", "REAL");
    await ensureColumn("ProductCost", "wasteRate", "REAL");
    await ensureColumn("ProductCost", "packagingPoset", "REAL");
    await ensureColumn("ProductCost", "packagingNaylon", "REAL");
    await ensureColumn("ProductCost", "packagingBant", "REAL");
    await ensureColumn("ProductCost", "packagingKart", "REAL");

    await cleanupPdfCommissionRules();
  })();

  return schemaReady;
}
