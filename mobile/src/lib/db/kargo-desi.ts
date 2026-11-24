import { siparisKimligi } from "@core/order-line-cost";
import { kargoDesiOku } from "@core/kargo-desi";
import { toDbDate } from "@core/sqlite-date";
import { execute, writeBatch } from "@/lib/turso";

/**
 * SHOPIFY KARGO DESİSİ — telefondan "Desiyi düzelt" (masaüstü `/api/orders/kargo-desi` ile aynı kayıt).
 * Kayıt değişince o siparişin kayıtlı kârı "yeniden hesaplanacak" diye işaretlenir; masaüstü ve
 * telefon bir sonraki turda yeni desiyle yazar (siparişe özel maliyetteki işaretin aynısı).
 */

let tabloHazir: Promise<void> | null = null;

/** Telefon masaüstünden önce güncellenirse tablo (v65) henüz yoktur — aynı tanımla açılır. */
function tabloyuHazirla(): Promise<void> {
  tabloHazir ??= (async () => {
    await execute(
      `CREATE TABLE IF NOT EXISTS "OrderCargoDesi" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "platform" TEXT NOT NULL,
        "externalOrderId" TEXT NOT NULL,
        "desi" REAL NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
    );
    await execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS "OrderCargoDesi_platform_externalOrderId_key"
         ON "OrderCargoDesi"("platform", "externalOrderId")`
    );
  })().catch((e) => {
    tabloHazir = null;
    throw e;
  });
  return tabloHazir;
}

function yeniKimlik(): string {
  return `ocd_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Desiyi kaydet (null = kaldır, kargo yine ürün desilerinden). Yalnız Shopify. */
export async function kargoDesisiKaydet(siparisId: string, desi: number | null): Promise<void> {
  const platform = "shopify";
  const externalOrderId = siparisKimligi(platform, siparisId);
  const gecerli = desi == null ? null : kargoDesiOku(desi);
  if (desi != null && gecerli == null) throw new Error("0'dan büyük bir desi gir");
  await tabloyuHazirla();
  const an = toDbDate(new Date());
  await writeBatch([
    gecerli == null
      ? { sql: `DELETE FROM "OrderCargoDesi" WHERE "platform" = ? AND "externalOrderId" = ?`, args: [platform, externalOrderId] }
      : {
          sql: `INSERT INTO "OrderCargoDesi" ("id", "platform", "externalOrderId", "desi", "createdAt", "updatedAt")
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT ("platform", "externalOrderId") DO UPDATE SET "desi" = excluded."desi", "updatedAt" = excluded."updatedAt"`,
          args: [yeniKimlik(), platform, externalOrderId, gecerli, an, an],
        },
    // Kayıtlı kâr bir sonraki turda yeni desiyle yeniden yazılsın.
    {
      sql: `UPDATE "OrderFinanceSnapshot" SET "calculationVersion" = 0 WHERE "platform" = ? AND "externalOrderId" = ?`,
      args: [platform, externalOrderId],
    },
  ]);
}
