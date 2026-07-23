CREATE TABLE "ActualExpense" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "category" TEXT,
  "amountKurus" INTEGER NOT NULL,
  "paidAt" DATETIME NOT NULL,
  "note" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "ActualExpense_paidAt_idx" ON "ActualExpense"("paidAt");

CREATE TABLE "OrderFinanceSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "platform" TEXT NOT NULL,
  "externalOrderId" TEXT NOT NULL,
  "orderNumber" TEXT NOT NULL,
  "orderedAt" DATETIME NOT NULL,
  "revenueKurus" INTEGER NOT NULL,
  "profitKurus" INTEGER,
  "profitPartial" BOOLEAN NOT NULL DEFAULT false,
  "statusKind" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'TRY',
  "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "calculationVersion" INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX "OrderFinanceSnapshot_platform_externalOrderId_key"
ON "OrderFinanceSnapshot"("platform", "externalOrderId");

CREATE INDEX "OrderFinanceSnapshot_orderedAt_idx"
ON "OrderFinanceSnapshot"("orderedAt");

CREATE INDEX "OrderFinanceSnapshot_statusKind_orderedAt_idx"
ON "OrderFinanceSnapshot"("statusKind", "orderedAt");
