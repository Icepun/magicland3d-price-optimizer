-- AlterTable
ALTER TABLE "Product" ADD COLUMN "commissionRate" REAL;
ALTER TABLE "Product" ADD COLUMN "commissionSource" TEXT;
ALTER TABLE "Product" ADD COLUMN "commissionUpdatedAt" DATETIME;

-- The PDF category import was removed because Trendyol category names do not
-- match products reliably. Product-level finance data is now the source.
DELETE FROM "CommissionRule" WHERE "name" LIKE 'Trendyol PDF - %';
