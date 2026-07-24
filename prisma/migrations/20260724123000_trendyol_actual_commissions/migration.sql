ALTER TABLE "OrderFinanceSnapshot"
ADD COLUMN "profitSource" TEXT NOT NULL DEFAULT 'calculated';

ALTER TABLE "OrderFinanceSnapshot"
ADD COLUMN "estimatedCommissionKurus" INTEGER;

ALTER TABLE "OrderFinanceSnapshot"
ADD COLUMN "actualCommissionKurus" INTEGER;

CREATE TABLE "PlatformOrderFinancial" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "platform" TEXT NOT NULL,
  "externalOrderId" TEXT NOT NULL,
  "orderNumber" TEXT NOT NULL,
  "grossRevenueKurus" INTEGER NOT NULL,
  "commissionKurus" INTEGER NOT NULL,
  "sellerRevenueKurus" INTEGER NOT NULL,
  "transactionCount" INTEGER NOT NULL DEFAULT 0,
  "sourceUpdatedAt" DATETIME,
  "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "PlatformOrderFinancial_platform_externalOrderId_key"
ON "PlatformOrderFinancial"("platform", "externalOrderId");

CREATE INDEX "PlatformOrderFinancial_platform_orderNumber_idx"
ON "PlatformOrderFinancial"("platform", "orderNumber");

CREATE INDEX "PlatformOrderFinancial_platform_syncedAt_idx"
ON "PlatformOrderFinancial"("platform", "syncedAt");
