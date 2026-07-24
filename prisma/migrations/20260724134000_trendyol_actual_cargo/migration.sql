ALTER TABLE "OrderFinanceSnapshot"
ADD COLUMN "estimatedCargoKurus" INTEGER;

ALTER TABLE "OrderFinanceSnapshot"
ADD COLUMN "actualCargoKurus" INTEGER;

CREATE TABLE "PlatformOrderCargoItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "platform" TEXT NOT NULL,
  "invoiceSerialNumber" TEXT NOT NULL,
  "parcelUniqueId" TEXT NOT NULL,
  "orderNumber" TEXT NOT NULL,
  "shipmentType" TEXT NOT NULL,
  "amountKurus" INTEGER NOT NULL,
  "desi" REAL,
  "sourceUpdatedAt" DATETIME,
  "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "PlatformOrderCargoItem_platform_invoiceSerialNumber_parcelUniqueId_shipmentType_key"
ON "PlatformOrderCargoItem"(
  "platform",
  "invoiceSerialNumber",
  "parcelUniqueId",
  "shipmentType"
);

CREATE INDEX "PlatformOrderCargoItem_platform_orderNumber_idx"
ON "PlatformOrderCargoItem"("platform", "orderNumber");

CREATE INDEX "PlatformOrderCargoItem_platform_syncedAt_idx"
ON "PlatformOrderCargoItem"("platform", "syncedAt");
