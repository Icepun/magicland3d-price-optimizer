/**
 * "Eski hesapla kayıtlı" siparişlerin YENİDEN HESAPLANABİLİRLİK dökümü.
 *
 * NEDEN VAR (ölçüldü, 13 Ağu 2026):
 *   Raporlar "18 sipariş eski hesaplamayla kayıtlı" diyor, kullanıcı "Bu ayı yeniden hesapla"
 *   düğmesine basıyor ve HİÇBİR ŞEY değişmiyordu. Sebep: o siparişlerin ÜRÜN GEÇMİŞİ
 *   (`OrderItemSnapshot`) kayıtlı değil; yeniden hesabın tek girdisi o olduğu için
 *   dokunulmadan geçiliyorlar. Canlı veride 368 siparişin 73'ünde ürün geçmişi yok ve
 *   73'ünün TAMAMI eski damgalı — yani uyarının bir kısmı KALICI olarak düzeltilemez.
 *
 *   Sayıyı ikiye ayırmadan arayüz dürüst olamaz: düğme yalnız "düzeltilebilir" olanları
 *   sayarak sunulmalı, düzeltilemeyenler ayrı ve sebebiyle söylenmeli.
 *
 * ⚠️ Ay kovaları `Europe/Istanbul` ile hesaplanır (FINANCE_TIME_ZONE) — SQL'de GROUP BY ile
 * yapılamaz, bu yüzden satırlar okunup JS'te kovalanır. Sipariş geçmişi birkaç yüz satır.
 */
import { prisma } from "@/lib/prisma";
import { isFinanceSnapshotOutdated, FINANCE_CALCULATION_VERSION } from "@/core/finance-version";
import { FINANCE_TIME_ZONE, monthKey } from "./monthly-finance";
import { dbEpochMs, parseDbDate } from "./sqlite-date";

/** Bir siparişin ASLA yeniden hesaplanamama sebebi. */
export type FinanceRecalcBlockReason = "no-item-history";

/** Kullanıcıya gösterilecek KISA sebep metni — tek kaynak (arayüz kendi metnini uydurmasın). */
export const FINANCE_RECALC_BLOCK_LABELS: Record<FinanceRecalcBlockReason, string> = {
  "no-item-history": "Ürün geçmişi kayıtlı değil",
};

/** Yeniden hesap için okunan tek satır (saf özet — veritabanından bağımsız test edilebilir). */
export interface FinanceRecalcCandidate {
  orderedAt: Date;
  calculationVersion: number;
  /** Bu siparişin kalemleri `OrderItemSnapshot`'ta var mı? */
  hasItemHistory: boolean;
}

export interface FinanceRecalcReadinessBucket {
  /** Kapsamdaki (manuel olmayan) sipariş sayısı. */
  totalOrders: number;
  /** Eski hesap sürümüyle kayıtlı sipariş sayısı. */
  outdatedOrders: number;
  /** Bunların GERÇEKTEN yeniden hesaplanabilenleri. */
  recalculableOrders: number;
  /** Bunların ASLA düzeltilemeyecek olanları. */
  blockedOrders: number;
  /** Sebep → sipariş sayısı (yalnız dolu sebepler yer alır). */
  blockedReasons: Partial<Record<FinanceRecalcBlockReason, number>>;
}

export interface FinanceRecalcMonthReadiness extends FinanceRecalcReadinessBucket {
  /** "YYYY-MM". */
  month: string;
}

export interface FinanceRecalcReadiness extends FinanceRecalcReadinessBucket {
  /** Satırların karşılaştırıldığı güncel hesap sürümü. */
  calculationVersion: number;
  /** Sipariş bulunan aylar, ESKİDEN YENİYE. Sipariş olmayan ay hiç yer almaz. */
  months: FinanceRecalcMonthReadiness[];
}

function emptyBucket(): FinanceRecalcReadinessBucket {
  return {
    totalOrders: 0,
    outdatedOrders: 0,
    recalculableOrders: 0,
    blockedOrders: 0,
    blockedReasons: {},
  };
}

function add(bucket: FinanceRecalcReadinessBucket, candidate: FinanceRecalcCandidate): void {
  bucket.totalOrders++;
  if (!isFinanceSnapshotOutdated(candidate.calculationVersion)) return;
  bucket.outdatedOrders++;
  if (candidate.hasItemHistory) {
    bucket.recalculableOrders++;
    return;
  }
  bucket.blockedOrders++;
  bucket.blockedReasons["no-item-history"] =
    (bucket.blockedReasons["no-item-history"] ?? 0) + 1;
}

/**
 * SAF toplama — veritabanı gerektirmez, ay kovalama kuralı tek yerde kalır.
 * Toplam ile ayların toplamı her zaman birbirini tutar (arayüz iki sayıyı yan yana gösteriyor;
 * ayrı ayrı hesaplanırsa sessizce ayrışırlar).
 */
export function summarizeRecalcReadiness(
  candidates: FinanceRecalcCandidate[],
  timeZone = FINANCE_TIME_ZONE
): FinanceRecalcReadiness {
  const overall = emptyBucket();
  const byMonth = new Map<string, FinanceRecalcReadinessBucket>();

  for (const candidate of candidates) {
    add(overall, candidate);
    const key = monthKey(candidate.orderedAt, timeZone);
    let bucket = byMonth.get(key);
    if (!bucket) {
      bucket = emptyBucket();
      byMonth.set(key, bucket);
    }
    add(bucket, candidate);
  }

  return {
    calculationVersion: FINANCE_CALCULATION_VERSION,
    ...overall,
    months: [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, bucket]) => ({ month, ...bucket })),
  };
}

/** Ham sorgu tamsayıları sürücüye göre BigInt gelebilir. */
function toInt(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

/**
 * Tüm sipariş özetlerini kalem geçmişi bilgisiyle birlikte TEK sorguda okur.
 *
 * ⚠️ Uzak-HTTP'de her sorgu ~96ms ve hepsi SIRALI: iki ayrı sorgu + JS'te birleştirme yerine
 * tek `LEFT JOIN` seçildi. Tarih kolonu `dbEpochMs()` ile normalize okunur — depolama tipi
 * karışıksa (eski epoch-ms tamsayı / kanonik ISO metin) hiçbir satır düşmesin diye.
 */
export async function readFinanceRecalcReadiness(options: {
  /** Yalnız bu andan sonraki siparişler (verilmezse TÜM geçmiş). */
  since?: Date;
  timeZone?: string;
} = {}): Promise<FinanceRecalcReadiness> {
  const args: unknown[] = [];
  // `i` alt sorgusu yalnız platform/externalOrderId seçtiği için "orderedAt" tek anlamlıdır;
  // tabloya ön ek gerekmez (ön ek eklemek dbEpochMs'in ürettiği ifadeyi elle yamamak olurdu).
  let sinceClause = "";
  if (options.since) {
    sinceClause = ` AND ${dbEpochMs("orderedAt")} >= ?`;
    args.push(options.since.getTime());
  }

  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT s."orderedAt" AS "orderedAt",
            s."calculationVersion" AS "calculationVersion",
            CASE WHEN i."externalOrderId" IS NULL THEN 0 ELSE 1 END AS "hasItems"
       FROM "OrderFinanceSnapshot" s
       LEFT JOIN (SELECT DISTINCT "platform", "externalOrderId" FROM "OrderItemSnapshot") i
              ON i."platform" = s."platform"
             AND i."externalOrderId" = s."externalOrderId"
      WHERE s."platform" <> 'manual'${sinceClause}`,
    ...args
  );

  const candidates: FinanceRecalcCandidate[] = [];
  for (const row of rows) {
    const orderedAt = parseDbDate(row.orderedAt);
    // Tarihi çözülemeyen satır hiçbir aya düşemez; sessizce yutmak yerine atlanır.
    if (!orderedAt) continue;
    candidates.push({
      orderedAt,
      calculationVersion: toInt(row.calculationVersion),
      hasItemHistory: toInt(row.hasItems) === 1,
    });
  }
  return summarizeRecalcReadiness(candidates, options.timeZone);
}
