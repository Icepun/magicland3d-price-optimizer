import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { tlToKurus } from "@/lib/monthly-finance";
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

export function aggregateTrendyolSaleSettlements(
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

async function fetchSaleSettlements(
  client: TrendyolClient,
  startDate: number,
  endDate: number
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
        transactionType: "Sale",
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
  const fetched = await fetchSaleSettlements(client, startDate, endDate);

  // Pencere sınırında aynı finans hareketi dönerse iki kez saymayalım.
  const seen = new Set<string>();
  const unique = fetched.filter((item) => {
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
        item.sellerRevenue,
      ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const { aggregates, skippedTransactions } =
    aggregateTrendyolSaleSettlements(unique);
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

  return {
    fetchedTransactions: unique.length,
    storedOrders: aggregates.length,
    skippedTransactions,
    days,
    syncedAt: syncedAt.toISOString(),
  };
}
