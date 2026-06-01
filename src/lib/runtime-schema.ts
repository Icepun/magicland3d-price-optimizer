import { prisma } from "@/lib/prisma";
import fs from "node:fs";
import path from "node:path";

let schemaReady: Promise<void> | null = null;

/**
 * Şema sürümü. Şema değiştiğinde ARTIR → tüm CREATE/ALTER bir kez daha çalışıp
 * damgayı günceller; aksi halde fast-path ile atlanır.
 */
const CURRENT_SCHEMA_VERSION = "16";

/** Açılış/perf ölçümünü userData/perf.log'a yaz (packaged app'te görünür). */
function logPerf(msg: string) {
  try {
    const settingsFile =
      process.env.TURSO_SETTINGS_FILE || process.env.SHOPIFY_SETTINGS_FILE;
    const dir = settingsFile ? path.dirname(settingsFile) : process.cwd();
    fs.appendFileSync(
      path.join(dir, "perf.log"),
      `[${new Date().toISOString()}] ${msg}\n`
    );
  } catch {
    /* ignore */
  }
}

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

/**
 * v0.14 migration: v0.13'teki parentProductId tabanlı varyant bağlarını VariantGroup'a taşı.
 * Her ana ürün (çocuğu olan) için bir grup oluşturulur; ana ürün + tüm çocukları o gruba bağlanır.
 * Hiçbir üye artık "ana" değil — hepsi eşit. Bir kez çalışır (AppSetting flag).
 */
async function migrateParentVariantsToGroups() {
  if (!(await tableExists("Product"))) return;
  if (!(await tableExists("VariantGroup"))) return;

  const flag = "variantGroupsMigratedAt";
  const existing = await prisma.appSetting.findUnique({ where: { key: flag } });
  if (existing) return;

  // Çocuğu olan (parent olarak referans verilen) ürünler
  const parents = await prisma.$queryRawUnsafe<Array<{ parentProductId: string }>>(
    `SELECT DISTINCT "parentProductId" FROM "Product" WHERE "parentProductId" IS NOT NULL`
  );

  for (const { parentProductId } of parents) {
    if (!parentProductId) continue;
    const prow = await prisma.$queryRawUnsafe<Array<{ name: string; variantGroupId: string | null }>>(
      `SELECT "name", "variantGroupId" FROM "Product" WHERE "id" = ? LIMIT 1`,
      parentProductId
    );
    if (!prow?.[0]) continue;
    if (prow[0].variantGroupId) continue; // zaten gruplu
    const groupId = `vg_${parentProductId}`;
    const groupName = prow[0].name || "Varyant Grubu";
    await prisma.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "VariantGroup" (id, name, createdAt, updatedAt)
       VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      groupId,
      groupName
    );
    // Ana ürünü + tüm çocuklarını gruba bağla (hepsi eşit üye)
    await prisma.$executeRawUnsafe(
      `UPDATE "Product" SET "variantGroupId" = ? WHERE "id" = ? OR "parentProductId" = ?`,
      groupId,
      parentProductId,
      parentProductId
    );
  }

  await prisma.appSetting.upsert({
    where: { key: flag },
    create: { key: flag, value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });
}

export function ensureRuntimeSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const __t0 = Date.now();
    // FAST-PATH: şema zaten güncelse ~50 ardışık CREATE/ALTER/PRAGMA ifadesini ATLA.
    // Embedded replica'da yazma ifadeleri buluta (eu-west-1) gittiği için bu ~50 ifade
    // açılışta 10-15 sn'lik gecikmeye yol açıyordu. Tek bir okuma ile (yerel replica,
    // anında) güncel olup olmadığını kontrol et; güncelse hepsini atla.
    try {
      const rows = await prisma.$queryRawUnsafe<Array<{ value: string }>>(
        `SELECT value FROM AppSetting WHERE key = 'schemaVersion' LIMIT 1`
      );
      if (rows?.[0]?.value === CURRENT_SCHEMA_VERSION) {
        logPerf(`ensureRuntimeSchema FAST-PATH (${Date.now() - __t0}ms)`);
        return;
      }
    } catch {
      /* AppSetting tablosu yok → ilk kurulum, tam şema kurulumuna devam et */
    }

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
      CREATE TABLE IF NOT EXISTS "AppSetting" (
        "key" TEXT NOT NULL PRIMARY KEY,
        "value" TEXT NOT NULL
      )
    `);

    // Kural / şablon / fiyat geçmişi tabloları — eskiden sadece bundled dev.db'de
    // vardı; boş Turso (bulut) DB'de de kurulabilmeleri için burada da yaratılır.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "CommissionRule" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "categoryName" TEXT,
        "minPrice" REAL NOT NULL DEFAULT 0,
        "maxPrice" REAL NOT NULL DEFAULT 999999,
        "commissionRate" REAL NOT NULL,
        "fixedCommission" REAL NOT NULL DEFAULT 0,
        "validFrom" DATETIME,
        "validTo" DATETIME,
        "priority" INTEGER NOT NULL DEFAULT 10,
        "isActive" BOOLEAN NOT NULL DEFAULT true
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "CargoRule" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "platform" TEXT,
        "cargoProvider" TEXT,
        "categoryName" TEXT,
        "minPrice" REAL NOT NULL DEFAULT 0,
        "maxPrice" REAL NOT NULL DEFAULT 999999,
        "minDesi" REAL NOT NULL DEFAULT 0,
        "maxDesi" REAL NOT NULL DEFAULT 999,
        "cargoCost" REAL NOT NULL,
        "validFrom" DATETIME,
        "validTo" DATETIME,
        "priority" INTEGER NOT NULL DEFAULT 10,
        "isActive" BOOLEAN NOT NULL DEFAULT true
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ExpenseRule" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "platform" TEXT,
        "type" TEXT NOT NULL,
        "value" REAL NOT NULL,
        "categoryName" TEXT,
        "minPrice" REAL NOT NULL DEFAULT 0,
        "maxPrice" REAL NOT NULL DEFAULT 999999,
        "priority" INTEGER NOT NULL DEFAULT 10,
        "isActive" BOOLEAN NOT NULL DEFAULT true
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "CostTemplate" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "materialCostPerGram" REAL NOT NULL DEFAULT 0,
        "electricityCostPerHour" REAL NOT NULL DEFAULT 0,
        "machineWearCostPerHour" REAL NOT NULL DEFAULT 0,
        "defaultPackagingCost" REAL NOT NULL DEFAULT 0,
        "defaultLaborCost" REAL NOT NULL DEFAULT 0,
        "defaultOtherCost" REAL NOT NULL DEFAULT 0,
        "defaultWasteRate" REAL NOT NULL DEFAULT 0,
        "isActive" BOOLEAN NOT NULL DEFAULT true
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "PriceHistory" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "productId" TEXT NOT NULL,
        "oldPrice" REAL NOT NULL,
        "newPrice" REAL NOT NULL,
        "changeSource" TEXT NOT NULL,
        "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "note" TEXT
      )
    `);

    // Filament makara envanteri + kullanım kaydı (v0.12)
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "FilamentSpool" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "material" TEXT NOT NULL DEFAULT 'PLA',
        "colorName" TEXT,
        "colorHex" TEXT NOT NULL DEFAULT '#9ca3af',
        "brand" TEXT,
        "totalGrams" REAL NOT NULL DEFAULT 1000,
        "remainingGrams" REAL NOT NULL DEFAULT 1000,
        "spoolCost" REAL,
        "reorderGrams" REAL NOT NULL DEFAULT 200,
        "vendorUrl" TEXT,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "FilamentUsage" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "spoolId" TEXT NOT NULL,
        "productId" TEXT,
        "productName" TEXT,
        "grams" REAL NOT NULL,
        "note" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "FilamentUsage_spoolId_idx" ON "FilamentUsage"("spoolId")
    `);

    // Varyant grubu — aynı ürünün renk/boy seçeneklerini tek genel başlık altında toplar (v0.14)
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "VariantGroup" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    await ensureColumn("Product", "parentProductId", "TEXT"); // legacy (v13) — migration kaynağı, artık kullanılmıyor
    await ensureColumn("Product", "variantLabel", "TEXT");
    await ensureColumn("Product", "variantGroupId", "TEXT");
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "Product_variantGroupId_idx" ON "Product"("variantGroupId")`
    );

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

    // 3D yazıcı bağlantıları (v0.15) — Moonraker (Elegoo/Snapmaker) + Bambu
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "PrinterConfig" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "brand" TEXT NOT NULL,
        "model" TEXT,
        "type" TEXT NOT NULL DEFAULT 'moonraker',
        "host" TEXT NOT NULL,
        "port" INTEGER NOT NULL DEFAULT 7125,
        "accent" TEXT,
        "accessCode" TEXT,
        "serial" TEXT,
        "enabled" BOOLEAN NOT NULL DEFAULT true,
        "sortOrder" INTEGER NOT NULL DEFAULT 0,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "PrintFileProduct" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "printerConfigId" TEXT NOT NULL,
        "filename" TEXT NOT NULL,
        "productId" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "PrintFileProduct_printerConfigId_filename_key" ON "PrintFileProduct"("printerConfigId", "filename")`
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "PrintFileProduct_productId_idx" ON "PrintFileProduct"("productId")`
    );

    // Ürün baskı modelleri (v0.16) — ürün+yazıcı başına dilimlenmiş dosya metadata'sı
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ProductModelFile" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "productId" TEXT NOT NULL,
        "printerConfigId" TEXT NOT NULL,
        "originalName" TEXT NOT NULL,
        "storedPath" TEXT NOT NULL,
        "fileType" TEXT NOT NULL,
        "sizeBytes" INTEGER NOT NULL DEFAULT 0,
        "gramaj" REAL,
        "estPrintMin" INTEGER,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "ProductModelFile_productId_printerConfigId_key" ON "ProductModelFile"("productId", "printerConfigId")`
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "ProductModelFile_printerConfigId_idx" ON "ProductModelFile"("printerConfigId")`
    );

    await cleanupPdfCommissionRules();
    await migrateTrendyolProductsToListings();
    await migrateParentVariantsToGroups();

    // Şema sürümünü damgala → sonraki açılışlar fast-path'ten anında döner
    await prisma.$executeRawUnsafe(
      `INSERT INTO AppSetting (key, value) VALUES ('schemaVersion', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      CURRENT_SCHEMA_VERSION
    );
    logPerf(`ensureRuntimeSchema FULL setup (${Date.now() - __t0}ms)`);
  })();

  return schemaReady;
}
