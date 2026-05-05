-- CreateTable
CREATE TABLE "Product" (
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
);

-- CreateTable
CREATE TABLE "ProductCost" (
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
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductCost_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProductCost_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "CostTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CostTemplate" (
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
);

-- CreateTable
CREATE TABLE "CommissionRule" (
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
);

-- CreateTable
CREATE TABLE "CargoRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
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
);

-- CreateTable
CREATE TABLE "ExpenseRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" REAL NOT NULL,
    "categoryName" TEXT,
    "minPrice" REAL NOT NULL DEFAULT 0,
    "maxPrice" REAL NOT NULL DEFAULT 999999,
    "priority" INTEGER NOT NULL DEFAULT 10,
    "isActive" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "Recommendation" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Recommendation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PriceHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "oldPrice" REAL NOT NULL,
    "newPrice" REAL NOT NULL,
    "changeSource" TEXT NOT NULL,
    "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    CONSTRAINT "PriceHistory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_barcode_key" ON "Product"("barcode");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCost_productId_key" ON "ProductCost"("productId");
