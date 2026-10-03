import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { tlToKurus } from "@/lib/monthly-finance";
import { batchWrite } from "@/lib/libsql-batch";
import { applyActualCommissionToProfit } from "@/core/platform-financials";
import { vatRateOf } from "@/core/vat";
import {
  TrendyolClient,
  type TrendyolSettlementItem,
} from "@/services/trendyol-client";
import { getTrendyolCredentials } from "@/services/trendyol-settings";

const DAY_MS = 86_400_000;
const MAX_WINDOW_MS = 14 * DAY_MS;
const PAGE_SIZE = 1000;

export interface TrendyolCommissionAggregate {
  externalOrderId: string;
  orderNumber: string;
  grossRevenue: number;
  commission: number;
  sellerRevenue: number;
  transactionCount: number;
  sourceUpdatedAt: Date | null;
}

export interface TrendyolCommissionSyncResult {
  fetchedTransactions: number;
  storedOrders: number;
  /** Gerçek komisyonu bu turda KAYITLI kâra işlenen sipariş sayısı. */
  appliedOrders: number;
  skippedTransactions: number;
  days: number;
  syncedAt: string;
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text ? text : null;
}

function orderKeyOf(item: TrendyolSettlementItem): string | null {
  const orderNumber = cleanId(item.orderNumber);
  if (!orderNumber) return null;
  const shipmentPackageId = cleanId(item.shipmentPackageId);
  return shipmentPackageId ? `ty-${shipmentPackageId}` : `ty-order-${orderNumber}`;
}

/**
 * SATICI KUPONU ("Takip Et Kazan" vb.) — satış hareketinden AYRI bir hareket olarak gelir.
 *
 * ⚠️ ÖLÇÜLDÜ (4 Eki 2026): kuponlu siparişte "Sale" hareketi kuponsuz fiyatı (449,99) ve onun
 * komisyonunu (94,50) taşıyor; 20 TL'lik kupon ayrı bir "Coupon" hareketinde BORÇ olarak düşülüyor
 * ve kuponun komisyonu (4,20) geri veriliyor. Yalnız satış hareketi okununca ödeme siparişten
 * büyük görünüyor, gerçek komisyon da kâra İŞLENEMİYORDU (142 sipariş, "komisyon kaydı var ama
 * kâra işlenemiyor" uyarısı). Kupon netlenince ödeme sipariş tutarıyla birebir tutuyor
 * (429,99 / komisyon 90,30).
 *
 * İptal hareketi ("CouponCancel") kuponu geri alır — aynı alanlar ters yönde işlenir.
 */
export interface TrendyolSettlementAdjustments {
  coupons?: TrendyolSettlementItem[];
  couponCancels?: TrendyolSettlementItem[];
}

export function aggregateTrendyolSaleSettlements(
  items: TrendyolSettlementItem[],
  adjustments: TrendyolSettlementAdjustments = {}
): {
  aggregates: TrendyolCommissionAggregate[];
  skippedTransactions: number;
} {
  const sales = aggregateSales(items);
  const byOrder = new Map(sales.aggregates.map((row) => [row.externalOrderId, row]));
  let skippedTransactions = sales.skippedTransactions;

  for (const [list, direction] of [
    [adjustments.coupons ?? [], -1],
    [adjustments.couponCancels ?? [], 1],
  ] as const) {
    for (const item of list) {
      const key = orderKeyOf(item);
      const current = key ? byOrder.get(key) : undefined;
      const commission = finiteNumber(item.commissionAmount) ?? 0;
      const amount = (finiteNumber(item.debt) ?? 0) - (finiteNumber(item.credit) ?? 0);
      const sellerShare = finiteNumber(item.sellerRevenue) ?? amount - commission;
      // Satışı bu pencerede olmayan kupon hiçbir siparişe yazılmaz (yarım tutar üretmesin).
      if (!current) {
        skippedTransactions++;
        continue;
      }
      // Kupon: tutarı (borç) sipariş brütünden düşer, kuponun komisyonu iade edilir.
      // İptali: ikisi de geri gelir.
      current.grossRevenue += direction * Math.abs(amount);
      current.commission += direction * Math.abs(commission);
      current.sellerRevenue += direction * Math.abs(sellerShare);
      current.transactionCount++;
    }
  }

  // Netleşince eksiye düşen paket (eksik/tutarsız hareket) kâra işlenmesin.
  const aggregates: TrendyolCommissionAggregate[] = [];
  for (const row of byOrder.values()) {
    row.grossRevenue = Number(row.grossRevenue.toFixed(2));
    row.commission = Number(row.commission.toFixed(2));
    row.sellerRevenue = Number(row.sellerRevenue.toFixed(2));
    if (row.grossRevenue < 0 || row.commission < 0 || row.sellerRevenue < 0) {
      skippedTransactions += row.transactionCount;
      continue;
    }
    aggregates.push(row);
  }
  return { aggregates, skippedTransactions };
}

function aggregateSales(
  items: TrendyolSettlementItem[]
): {
  aggregates: TrendyolCommissionAggregate[];
  skippedTransactions: number;
} {
  const byOrder = new Map<string, TrendyolCommissionAggregate>();
  let skippedTransactions = 0;

  for (const item of items) {
    const orderNumber = cleanId(item.orderNumber);
    const shipmentPackageId = cleanId(item.shipmentPackageId);
    const commission = finiteNumber(item.commissionAmount);
    const sellerRevenueValue = finiteNumber(item.sellerRevenue);
    const credit = finiteNumber(item.credit);
    const grossRevenue =
      credit != null
        ? credit
        : sellerRevenueValue != null && commission != null
          ? sellerRevenueValue + commission
          : null;

    if (
      !orderNumber ||
      commission == null ||
      grossRevenue == null ||
      commission < 0 ||
      grossRevenue < 0
    ) {
      skippedTransactions++;
      continue;
    }

    const sellerRevenue =
      sellerRevenueValue != null ? sellerRevenueValue : grossRevenue - commission;
    if (!Number.isFinite(sellerRevenue) || sellerRevenue < 0) {
      skippedTransactions++;
      continue;
    }

    const externalOrderId = shipmentPackageId
      ? `ty-${shipmentPackageId}`
      : `ty-order-${orderNumber}`;
    const current = byOrder.get(externalOrderId) ?? {
      externalOrderId,
      orderNumber,
      grossRevenue: 0,
      commission: 0,
      sellerRevenue: 0,
      transactionCount: 0,
      sourceUpdatedAt: null,
    };
    current.grossRevenue += grossRevenue;
    current.commission += commission;
    current.sellerRevenue += sellerRevenue;
    current.transactionCount++;

    const transactionDate = finiteNumber(item.transactionDate);
    if (transactionDate != null) {
      const date = new Date(transactionDate);
      if (
        Number.isFinite(date.getTime()) &&
        (!current.sourceUpdatedAt || date > current.sourceUpdatedAt)
      ) {
        current.sourceUpdatedAt = date;
      }
    }
    byOrder.set(externalOrderId, current);
  }

  return { aggregates: [...byOrder.values()], skippedTransactions };
}

/** Pencere sınırında aynı finans hareketi iki kez dönerse bir kez sayılır. */
function uniqueSettlements(items: TrendyolSettlementItem[]): TrendyolSettlementItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = cleanId(item.id);
    const key =
      id ??
      JSON.stringify([
        item.orderNumber,
        item.shipmentPackageId,
        item.barcode,
        item.transactionDate,
        item.commissionAmount,
        item.credit,
        item.debt,
        item.sellerRevenue,
      ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchSettlements(
  client: TrendyolClient,
  startDate: number,
  endDate: number,
  transactionType: "Sale" | "Coupon" | "CouponCancel"
): Promise<TrendyolSettlementItem[]> {
  const items: TrendyolSettlementItem[] = [];

  for (
    let windowStart = startDate;
    windowStart <= endDate;
    windowStart += MAX_WINDOW_MS
  ) {
    const windowEnd = Math.min(endDate, windowStart + MAX_WINDOW_MS - 1);
    for (let pageNo = 0; pageNo < 100; pageNo++) {
      const page = await client.listSettlements({
        startDate: windowStart,
        endDate: windowEnd,
        page: pageNo,
        size: PAGE_SIZE,
        transactionType,
      });
      const content = page.content ?? [];
      items.push(...content);
      const totalPages = Number(page.totalPages);
      if (
        content.length < PAGE_SIZE ||
        (Number.isFinite(totalPages) && pageNo + 1 >= totalPages)
      ) {
        break;
      }
    }
  }

  return items;
}

export async function syncTrendyolActualCommissions(
  requestedDays = 60
): Promise<TrendyolCommissionSyncResult> {
  const days = Math.max(1, Math.min(180, Math.trunc(requestedDays)));
  await ensureRuntimeSchema();

  const client = new TrendyolClient(await getTrendyolCredentials());
  const endDate = Date.now();
  const startDate = endDate - days * DAY_MS;
  // Satış + satıcı kuponu (ve iptali): kupon ayrı hareket olarak düşülüyor — netlenmezse ödeme
  // siparişten büyük görünür ve gerçek komisyon kâra işlenemez (bkz. aggregateTrendyolSaleSettlements).
  const [sales, coupons, couponCancels] = await Promise.all([
    fetchSettlements(client, startDate, endDate, "Sale"),
    fetchSettlements(client, startDate, endDate, "Coupon"),
    fetchSettlements(client, startDate, endDate, "CouponCancel"),
  ]);
  const unique = uniqueSettlements(sales);
  const { aggregates, skippedTransactions } = aggregateTrendyolSaleSettlements(unique, {
    coupons: uniqueSettlements(coupons),
    couponCancels: uniqueSettlements(couponCancels),
  });
  const syncedAt = new Date();

  for (let offset = 0; offset < aggregates.length; offset += 50) {
    const chunk = aggregates.slice(offset, offset + 50);
    await prisma.$transaction(
      chunk.map((row) =>
        prisma.platformOrderFinancial.upsert({
          where: {
            platform_externalOrderId: {
              platform: "trendyol",
              externalOrderId: row.externalOrderId,
            },
          },
          create: {
            id: `pof:trendyol:${row.externalOrderId}`,
            platform: "trendyol",
            externalOrderId: row.externalOrderId,
            orderNumber: row.orderNumber,
            grossRevenueKurus: tlToKurus(row.grossRevenue),
            commissionKurus: tlToKurus(row.commission),
            sellerRevenueKurus: tlToKurus(row.sellerRevenue),
            transactionCount: row.transactionCount,
            sourceUpdatedAt: row.sourceUpdatedAt,
            syncedAt,
          },
          update: {
            orderNumber: row.orderNumber,
            grossRevenueKurus: tlToKurus(row.grossRevenue),
            commissionKurus: tlToKurus(row.commission),
            sellerRevenueKurus: tlToKurus(row.sellerRevenue),
            transactionCount: row.transactionCount,
            sourceUpdatedAt: row.sourceUpdatedAt,
            syncedAt,
          },
        })
      )
    );
  }

  const appliedOrders = await gercekKomisyonlariKayitlaraIsle();

  return {
    fetchedTransactions: unique.length,
    storedOrders: aggregates.length,
    appliedOrders,
    skippedTransactions,
    days,
    syncedAt: syncedAt.toISOString(),
  };
}

/** Gerçek komisyonu henüz işlenmemiş, kârı TAM hesaplanmış kayıt + o siparişin netleşmiş ödemesi. */
export interface KomisyonBekleyenKayit {
  id: string;
  revenueKurus: number;
  profitKurus: number;
  estimatedCommissionKurus: number;
  inputVatCreditKurus: number | null;
  grossRevenueKurus: number;
  commissionKurus: number;
}

export interface KomisyonGuncellemesi {
  id: string;
  profitKurus: number;
  inputVatCreditKurus: number | null;
  actualCommissionKurus: number;
}

/**
 * Kayıtlı kâra yalnız KOMİSYON FARKI işlenir (SAF).
 *
 * Neden tüm kâr yeniden hesaplanmıyor: tam yakalanmış kâr sonradan değişen maliyet/kural
 * düzenlemeleriyle oynamaz (bkz. `shouldReplaceCapturedProfit`). Gerçek komisyon gelince değişen
 * tek şey komisyondur; kural `applyActualCommissionToProfit` — sipariş ekranının kullandığının
 * ta kendisi (ödeme sipariş tutarıyla %1'den fazla sapıyorsa İŞLENMEZ).
 */
export function gercekKomisyonGuncellemeleri(
  kayitlar: KomisyonBekleyenKayit[],
  vatRate: number
): KomisyonGuncellemesi[] {
  const vatFactor = vatRate > 0 ? vatRate / (100 + vatRate) : 0;
  const sonuc: KomisyonGuncellemesi[] = [];
  for (const k of kayitlar) {
    const uygulanan = applyActualCommissionToProfit({
      profit: k.profitKurus / 100,
      profitPartial: false,
      orderRevenue: k.revenueKurus / 100,
      estimatedCommission: k.estimatedCommissionKurus / 100,
      actualCommission: k.commissionKurus / 100,
      settlementRevenue: k.grossRevenueKurus / 100,
      vatRate,
    });
    if (!uygulanan.applied || uygulanan.profit == null) continue;
    sonuc.push({
      id: k.id,
      profitKurus: Math.round(uygulanan.profit * 100),
      // Komisyonun içindeki indirilecek KDV de gerçek tutara göre değişir (sipariş ekranıyla aynı).
      inputVatCreditKurus:
        k.inputVatCreditKurus == null
          ? null
          : k.inputVatCreditKurus +
            Math.round((k.commissionKurus - k.estimatedCommissionKurus) * vatFactor),
      actualCommissionKurus: k.commissionKurus,
    });
  }
  return sonuc;
}

/**
 * Netleşmiş gerçek komisyonu KAYITLI kârlara işle.
 *
 * Sipariş ekranı bunu yalnız son 60 günün siparişleri için yapabiliyor; daha eski siparişin
 * komisyonu indirilse de kâra hiç işlenmiyor ve Raporlar "komisyon kaydı var ama kâra
 * işlenemiyor" demeye devam ediyordu. Döndürdüğü sayı güncellenen sipariş adedidir.
 */
export async function gercekKomisyonlariKayitlaraIsle(): Promise<number> {
  const [satirlar, ayarlar] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT s."id", s."revenueKurus", s."profitKurus", s."estimatedCommissionKurus",
              s."inputVatCreditKurus", f."grossRevenueKurus", f."commissionKurus"
         FROM "OrderFinanceSnapshot" s
         JOIN "PlatformOrderFinancial" f
           ON f."platform" = 'trendyol' AND f."externalOrderId" = s."externalOrderId"
        WHERE s."platform" = 'trendyol' AND s."actualCommissionKurus" IS NULL
          AND s."statusKind" <> 'cancelled' AND s."profitKurus" IS NOT NULL
          AND s."profitPartial" = 0 AND s."estimatedCommissionKurus" IS NOT NULL`
    ),
    prisma.appSetting.findMany(),
  ]);
  const sayi = (v: unknown) => (typeof v === "bigint" ? Number(v) : Number(v));
  const guncellemeler = gercekKomisyonGuncellemeleri(
    satirlar.map((r) => ({
      id: String(r.id),
      revenueKurus: sayi(r.revenueKurus),
      profitKurus: sayi(r.profitKurus),
      estimatedCommissionKurus: sayi(r.estimatedCommissionKurus),
      inputVatCreditKurus: r.inputVatCreditKurus == null ? null : sayi(r.inputVatCreditKurus),
      grossRevenueKurus: sayi(r.grossRevenueKurus),
      commissionKurus: sayi(r.commissionKurus),
    })),
    vatRateOf(Object.fromEntries(ayarlar.map((row) => [row.key, row.value])))
  );
  if (guncellemeler.length === 0) return 0;

  // Koşul tekrar sorulur: arada sipariş ekranı aynı satırı yazdıysa ezilmez.
  const ifadeler = guncellemeler.map((g) => ({
    sql: `UPDATE "OrderFinanceSnapshot"
             SET "profitKurus" = ?, "inputVatCreditKurus" = ?, "actualCommissionKurus" = ?,
                 "profitSource" = 'platform'
           WHERE "id" = ? AND "actualCommissionKurus" IS NULL`,
    args: [g.profitKurus, g.inputVatCreditKurus, g.actualCommissionKurus, g.id],
  }));
  if (!(await batchWrite(ifadeler))) {
    for (const ifade of ifadeler) await prisma.$executeRawUnsafe(ifade.sql, ...ifade.args);
  }
  return guncellemeler.length;
}
