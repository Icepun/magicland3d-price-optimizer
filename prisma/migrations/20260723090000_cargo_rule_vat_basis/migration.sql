ALTER TABLE "CargoRule" ADD COLUMN "vatIncluded" BOOLEAN NOT NULL DEFAULT true;

UPDATE "CargoRule"
SET "vatIncluded" = false
WHERE "cargoProvider" LIKE '%TEX%' OR "name" LIKE '%TEX%';
