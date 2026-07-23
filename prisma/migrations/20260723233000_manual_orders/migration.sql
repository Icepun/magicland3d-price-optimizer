CREATE TABLE "ManualOrder" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orderNumber" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "orderedAt" DATETIME NOT NULL,
  "statusKind" TEXT NOT NULL DEFAULT 'processing',
  "customerName" TEXT,
  "currency" TEXT NOT NULL DEFAULT 'TRY',
  "revenueKurus" INTEGER NOT NULL,
  "netRevenueKurus" INTEGER NOT NULL,
  "totalCostKurus" INTEGER NOT NULL,
  "inputVatCreditKurus" INTEGER NOT NULL,
  "profitKurus" INTEGER,
  "profitPartial" BOOLEAN NOT NULL DEFAULT false,
  "itemsJson" TEXT NOT NULL,
  "breakdownJson" TEXT NOT NULL,
  "calculationVersion" INTEGER NOT NULL DEFAULT 1,
  "note" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "ManualOrder_orderNumber_key"
ON "ManualOrder"("orderNumber");

CREATE INDEX "ManualOrder_orderedAt_idx"
ON "ManualOrder"("orderedAt");

CREATE INDEX "ManualOrder_statusKind_orderedAt_idx"
ON "ManualOrder"("statusKind", "orderedAt");
