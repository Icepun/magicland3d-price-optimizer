-- AlterTable
ALTER TABLE "Product" ADD COLUMN "imageUrl" TEXT;

-- CreateTable
CREATE TABLE "FilamentType" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "costPerGram" REAL NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ProductCost" (
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
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductCost_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProductCost_filamentTypeId_fkey" FOREIGN KEY ("filamentTypeId") REFERENCES "FilamentType" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ProductCost_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "CostTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ProductCost" (
    "costMode",
    "electricityCost",
    "id",
    "laborCost",
    "machineWearCost",
    "manualCost",
    "materialCost",
    "materialWeight",
    "otherCost",
    "packagingCost",
    "printTimeHours",
    "productId",
    "templateId",
    "totalCost",
    "updatedAt",
    "wasteRate"
)
SELECT
    "costMode",
    "electricityCost",
    "id",
    "laborCost",
    "machineWearCost",
    "manualCost",
    "materialCost",
    "materialWeight",
    "otherCost",
    "packagingCost",
    "printTimeHours",
    "productId",
    "templateId",
    "totalCost",
    "updatedAt",
    "wasteRate"
FROM "ProductCost";
DROP TABLE "ProductCost";
ALTER TABLE "new_ProductCost" RENAME TO "ProductCost";
CREATE UNIQUE INDEX "ProductCost_productId_key" ON "ProductCost"("productId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
