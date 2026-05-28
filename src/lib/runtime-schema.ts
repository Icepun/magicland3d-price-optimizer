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

/**
 * v0.5.1 migration: mevcut Trendyol source ürünler için otomatik Trendyol Listing oluştur.
 * Bir kez çalışır (AppSetting flag).
 */
async function migrateTrendyolProductsToListings() {
  if (!(await tableExists("Listing"))) return;
  if (!(await tableExists("Product"))) return;

  const migrationKey = "trendyolListingsMigratedAt";
  const existing = await prisma.appSetting.findUnique({ where: { key: migrationKey } });
  if (existing) return;

  // Trendyol source ürünleri al — listing'i olmayanlar için listing oluştur
  const products = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      source: string;
      currentSalePrice: number;
      listPrice: number | null;
      stock: number;
      trendyolId: string | null;
      sku: string;
      commissionRate: number | null;
    }>
  >(
    `SELECT p.id, p.source, p.currentSalePrice, p.listPrice, p.stock, p.trendyolId, p.sku, p.commissionRate
     FROM Product p
     WHERE p.source = 'trendyol'
       AND NOT EXISTS (SELECT 1 FROM Listing l WHERE l.productId = p.id AND l.platform = 'trendyol')`
  );

  for (const p of products) {
    const id = `listing_${p.id}_trendyol`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO Listing (id, productId, platform, externalId, externalSku, salePrice, listPrice, stock, commissionRate, isActive, createdAt, updatedAt)
       VALUES (?, ?, 'trendyol', ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      id,
      p.id,
      p.trendyolId,
      p.sku,
      p.currentSalePrice,
      p.listPrice,
      p.stock,
      p.commissionRate
    );
  }

  await prisma.appSetting.upsert({
    where: { key: migrationKey },
    create: { key: migrationKey, value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });
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
    await ensureColumn("Product", "productMainId", "TEXT");
    await ensureColumn("Product", "hidden", "BOOLEAN NOT NULL DEFAULT false");

    // CargoRule platform alanı (Trendyol/Shopify ayrı baremi)
    await ensureColumn("CargoRule", "platform", "TEXT");
    // Eski kurallar (platform yok) Trendyol baremiydi — Shopify'a bulaşmasın diye
    // platform'u 'trendyol' olarak işaretle. platform dolu olanlar etkilenmez.
    if (await tableExists("CargoRule")) {
      await prisma.$executeRawUnsafe(
        `UPDATE "CargoRule" SET "platform" = 'trendyol' WHERE "platform" IS NULL`
      );
    }

    // ExpenseRule platform alanı. NOT: backfill YOK — null = tüm platformlar
    // (KDV gibi giderler her platforma uygulanır). Kullanıcı platform-spesifik
    // giderleri (Platform Hizmet Bedeli) manuel olarak Trendyol'a atar.
    await ensureColumn("ExpenseRule", "platform", "TEXT");

    // New ProductCost columns
    await ensureColumn("ProductCost", "filamentTypeId", "TEXT");
    await ensureColumn("ProductCost", "filamentWeight", "REAL");
    await ensureColumn("ProductCost", "printTimeHours", "REAL");
    await ensureColumn("ProductCost", "wasteRate", "REAL");
    await ensureColumn("ProductCost", "packagingPoset", "REAL");
    await ensureColumn("ProductCost", "packagingNaylon", "REAL");
    await ensureColumn("ProductCost", "packagingBant", "REAL");
    await ensureColumn("ProductCost", "packagingKart", "REAL");
    // Seçim bazlı paketleme (fiyat Maliyet Ayarları'ndan dinamik çekilir)
    await ensureColumn("ProductCost", "packagingOptionId", "TEXT");
    await ensureColumn("ProductCost", "nylonLevel", "TEXT");
    await ensureColumn("ProductCost", "tapeUsed", "BOOLEAN");

    // Listing tablosu — 3 platform için ayrı satış kaydı
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Listing" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "productId" TEXT NOT NULL,
        "platform" TEXT NOT NULL,
        "externalId" TEXT,
        "externalSku" TEXT,
        "salePrice" REAL NOT NULL DEFAULT 0,
        "listPrice" REAL,
        "stock" INTEGER NOT NULL DEFAULT 0,
        "commissionRate" REAL,
        "commissionFixed" REAL,
        "cargoCost" REAL,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "lastSyncedAt" DATETIME,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "Listing_productId_platform_key" ON "Listing"("productId", "platform")
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "Listing_platform_isActive_idx" ON "Listing"("platform", "isActive")
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "Listing_externalId_idx" ON "Listing"("externalId")
    `);

    // UnmatchedListing — Shopify ana ürününe bağlanmamış Trendyol/HB ürünleri
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "UnmatchedListing" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "platform" TEXT NOT NULL,
        "externalId" TEXT,
        "externalSku" TEXT,
        "barcode" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "categoryName" TEXT,
        "price" REAL NOT NULL DEFAULT 0,
        "stock" INTEGER NOT NULL DEFAULT 0,
        "imageUrl" TEXT,
        "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UnmatchedListing_platform_externalId_key" ON "UnmatchedListing"("platform", "externalId")
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "UnmatchedListing_platform_barcode_idx" ON "UnmatchedListing"("platform", "barcode")
    `);

    await cleanupPdfCommissionRules();
    await migrateTrendyolProductsToListings();
  })();

  return schemaReady;
}
