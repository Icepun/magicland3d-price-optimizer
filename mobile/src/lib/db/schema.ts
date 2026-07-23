import { execute, query } from "@/lib/turso";

let cargoVatSchemaPromise: Promise<void> | null = null;

/**
 * Mobil uygulama masaüstü açılmadan önce güncellenebilir. Bu yüzden kargo KDV kolonunu
 * ilk kargo sorgusundan önce Turso'da da güvenle hazırlarız.
 */
export function ensureCargoVatSchema(): Promise<void> {
  if (!cargoVatSchemaPromise) {
    cargoVatSchemaPromise = (async () => {
      const columns = await query<{ name: string }>(`PRAGMA table_info("CargoRule")`);
      if (columns.length === 0) {
        throw new Error("CargoRule tablosu bulunamadı.");
      }
      if (columns.some((column) => column.name === "vatIncluded")) return;

      try {
        await execute(
          `ALTER TABLE "CargoRule"
             ADD COLUMN "vatIncluded" INTEGER NOT NULL DEFAULT 1`
        );
      } catch (error) {
        // İki cihaz aynı anda güncellerse ikinci ALTER "duplicate column" dönebilir.
        const refreshed = await query<{ name: string }>(`PRAGMA table_info("CargoRule")`);
        if (!refreshed.some((column) => column.name === "vatIncluded")) throw error;
      }

      await execute(
        `UPDATE "CargoRule"
            SET "vatIncluded" = 0
          WHERE UPPER(COALESCE("cargoProvider", '')) LIKE '%TEX%'
             OR UPPER("name") LIKE '%TEX%'`
      );
    })().catch((error) => {
      cargoVatSchemaPromise = null;
      throw error;
    });
  }
  return cargoVatSchemaPromise;
}
