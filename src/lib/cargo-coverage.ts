import { prisma } from "@/lib/prisma";
import { dbEpochMs } from "@/lib/sqlite-date";
import { DAY_MS, EXCLUDED_STATUS, SALES_WINDOW_DAYS, coverageStart, toInt } from "@/lib/planner-insights";

/**
 * KARGO KAPSAMI — "kargo maliyeti hangi ürünlerde tahmine dayanıyor?"
 *
 * Ölçüldü (14 Ağu 2026): 232 siparişin 50'sinde (cironun %20'si) desi girilmediği için kargo
 * maliyeti tahmin ediliyordu. Dağılım dar: satan 108 üründen 39'unda desi yok ve en çok satan
 * birkaç tanesini girmek sorunun büyük kısmını kapatıyor. Kargo sayfası bunu hiç söylemiyordu.
 *
 * BURADA PARA HESABI YOKTUR: yalnız adet sayılır, hiçbir tutar/kâr türetilmez.
 */

export interface EksikDesiUrun {
  id: string;
  name: string;
  /** Ölçülen dönemde satılan adet. */
  units: number;
}

export interface CargoCoverage {
  /** Satış hızının ölçüldüğü gün sayısı. */
  measuredDays: number;
  /** Dönemde satan ürün sayısı. */
  soldProducts: number;
  /** Bunlardan desisi girilmemiş olanlar. */
  missingProducts: number;
  /** Dönemde satılan toplam adet. */
  soldUnits: number;
  /** Desisi girilmemiş ürünlerden satılan adet. */
  missingUnits: number;
  /** Ürünlerde girili EN BÜYÜK desi — kural baremlerinin ne kadarının kullanıldığını gösterir. */
  maxDesi: number | null;
  /** Önce girilecekler: en çok satan desisiz ürünler. */
  top: EksikDesiUrun[];
}

export async function readCargoCoverage(): Promise<CargoCoverage> {
  const now = Date.now();
  const since = now - SALES_WINDOW_DAYS * DAY_MS;

  // TEK SORGU: satışlar + kanal başlangıçları + en büyük desi. Uzak veritabanında her sorgu
  // sıraya girdiği için üç ayrı tur, sayfayı üç kat bekletirdi.
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT 0 AS "kind", p."id" AS "id", p."name" AS "name", p."desi" AS "desi",
            SUM(o."quantity") AS "adet"
       FROM "OrderItemSnapshot" o
       JOIN "Product" p ON p."id" = o."productId"
      WHERE o."productId" IS NOT NULL AND o."statusKind" <> ?
        AND ${dbEpochMs("orderedAt")} >= ?
      GROUP BY p."id"
     UNION ALL
     SELECT 1 AS "kind", NULL, NULL, NULL, MIN(${dbEpochMs("orderedAt")})
       FROM "OrderItemSnapshot" GROUP BY "platform"
     UNION ALL
     SELECT 2 AS "kind", NULL, NULL, MAX("desi"), NULL
       FROM "Product" WHERE "isActive" = 1 AND "desi" IS NOT NULL`,
    EXCLUDED_STATUS,
    since
  );

  const satisSatirlari = rows.filter((r) => Number(r.kind) === 0);
  const kapsamBasi = coverageStart(
    rows.filter((r) => Number(r.kind) === 1).map((r) => toInt(r.adet))
  );
  const enBuyukDesi = rows.find((r) => Number(r.kind) === 2)?.desi;

  const gecmisGun = kapsamBasi == null ? 0 : Math.floor((now - kapsamBasi) / DAY_MS);
  const measuredDays = Math.max(1, Math.min(gecmisGun, SALES_WINDOW_DAYS));

  let soldUnits = 0;
  let missingUnits = 0;
  let missingProducts = 0;
  const eksikler: EksikDesiUrun[] = [];

  for (const r of satisSatirlari) {
    const adet = toInt(r.adet);
    if (!Number.isFinite(adet) || adet <= 0) continue;
    soldUnits += adet;
    // BİLİNMEYEN ≠ SIFIR: desi 0 girilmiş olabilir, o "girilmiş" sayılır; yalnız NULL eksiktir.
    if (r.desi != null) continue;
    missingProducts += 1;
    missingUnits += adet;
    eksikler.push({ id: String(r.id ?? ""), name: String(r.name ?? ""), units: adet });
  }

  eksikler.sort((a, b) => b.units - a.units || a.name.localeCompare(b.name, "tr-TR"));

  return {
    measuredDays,
    soldProducts: satisSatirlari.length,
    missingProducts,
    soldUnits,
    missingUnits,
    maxDesi: enBuyukDesi == null ? null : Number(enBuyukDesi),
    top: eksikler.slice(0, 10),
  };
}
