import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { tlToKurus } from "@/lib/monthly-finance";
import {
  TrendyolApiError,
  TrendyolClient,
  type TrendyolCargoInvoiceItem,
  type TrendyolOtherFinancialItem,
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

export interface TrendyolCargoInvoiceRecord {
  invoiceSerialNumber: string;
  parcelUniqueId: string;
  orderNumber: string;
  shipmentType: "dispatch" | "return";
  amount: number;
  desi: number | null;
  sourceUpdatedAt: Date | null;
}

export interface TrendyolCostSyncResult {
  fetchedTransactions: number;
  storedOrders: number;
  skippedTransactions: number;
  cargoInvoiceRecords: number;
  cargoInvoices: number;
  cargoItems: number;
  cargoOrders: number;
  skippedCargoInvoices: number;
  skippedCargoItems: number;
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

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

export function isTrendyolCargoInvoice(
  item: TrendyolOtherFinancialItem
): boolean {
  const text = normalizeText(
    `${item.transactionType ?? ""} ${item.transactionSubType ?? ""} ${item.description ?? ""}`
  );
  return (
    (text.includes("kargo") && text.includes("fatura")) ||
    (text.includes("cargo") && text.includes("invoice"))
  );
}

export function normalizeTrendyolCargoInvoiceItems(
  invoiceSerialNumber: string,
  items: TrendyolCargoInvoiceItem[],
  sourceUpdatedAt: Date | null
): {
  records: TrendyolCargoInvoiceRecord[];
  skippedItems: number;
} {
  const records = new Map<string, TrendyolCargoInvoiceRecord>();
  let skippedItems = 0;

  for (const item of items) {
    const parcelUniqueId = cleanId(item.parcelUniqueId);
    const orderNumber = cleanId(item.orderNumber);
    const amount = finiteNumber(item.amount);
    const shipmentText = normalizeText(item.shipmentPackageType);
    if (!parcelUniqueId || !orderNumber || amount == null || amount < 0) {
      skippedItems++;
      continue;
    }

    const shipmentType =
      shipmentText.includes("iade") || shipmentText.includes("return")
        ? "return"
        : "dispatch";
    const desiValue = finiteNumber(item.desi);
    const record: TrendyolCargoInvoiceRecord = {
      invoiceSerialNumber,
      parcelUniqueId,
      orderNumber,
      shipmentType,
      // Kargo faturasındaki kalem tutarı KDV hariç net maliyettir. KDV ayrıca
      // indirilecek KDV olduğundan kâra etki eden tutar doğrudan bu değerdir.
      amount,
      desi: desiValue != null && desiValue >= 0 ? desiValue : null,
      sourceUpdatedAt,
    };
    records.set(`${parcelUniqueId}:${shipmentType}`, record);
  }

  return { records: [...records.values()], skippedItems };
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

async function fetchDeductionInvoices(
  client: TrendyolClient,
  startDate: number,
  endDate: number
): Promise<TrendyolOtherFinancialItem[]> {
  const items: TrendyolOtherFinancialItem[] = [];

  for (
    let windowStart = startDate;
    windowStart <= endDate;
    windowStart += MAX_WINDOW_MS
  ) {
    const windowEnd = Math.min(endDate, windowStart + MAX_WINDOW_MS - 1);
    for (let pageNo = 0; pageNo < 100; pageNo++) {
      const page = await client.listOtherFinancials({
        startDate: windowStart,
        endDate: windowEnd,
        page: pageNo,
        size: PAGE_SIZE,
        transactionType: "DeductionInvoices",
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

async function fetchCargoInvoiceItems(
  client: TrendyolClient,
  invoiceSerialNumber: string
): Promise<TrendyolCargoInvoiceItem[]> {
  const items: TrendyolCargoInvoiceItem[] = [];
  for (let pageNo = 0; pageNo < 100; pageNo++) {
    const page = await client.listCargoInvoiceItems(invoiceSerialNumber, {
      page: pageNo,
      size: 500,
    });
    const content = page.content ?? [];
    items.push(...content);
    const totalPages = Number(page.totalPages);
    if (
      content.length < 500 ||
      (Number.isFinite(totalPages) && pageNo + 1 >= totalPages)
    ) {
      break;
    }
  }
  return items;
}

export async function syncTrendyolActualCosts(
  requestedDays = 60
): Promise<TrendyolCostSyncResult> {
  const days = Math.max(1, Math.min(180, Math.trunc(requestedDays)));
  await ensureRuntimeSchema();

  const client = new TrendyolClient(await getTrendyolCredentials());
  const endDate = Date.now();
  const startDate = endDate - days * DAY_MS;
  const [fetched, deductionInvoices] = await Promise.all([
    fetchSaleSettlements(client, startDate, endDate),
    fetchDeductionInvoices(client, startDate, endDate),
  ]);

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

  const cargoInvoiceFinancials = deductionInvoices.filter(isTrendyolCargoInvoice);
  const cargoInvoiceSerials = new Set<string>();
  const cargoRecords: TrendyolCargoInvoiceRecord[] = [];
  let cargoInvoices = 0;
  let skippedCargoInvoices = 0;
  let skippedCargoItems = 0;

  for (const financial of cargoInvoiceFinancials) {
    const invoiceSerialNumber = cleanId(financial.id);
    if (!invoiceSerialNumber || cargoInvoiceSerials.has(invoiceSerialNumber)) {
      if (!invoiceSerialNumber) skippedCargoInvoices++;
      continue;
    }
    cargoInvoiceSerials.add(invoiceSerialNumber);

    const transactionDate = finiteNumber(financial.transactionDate);
    const sourceUpdatedAt =
      transactionDate == null ? null : new Date(transactionDate);
    try {
      const items = await fetchCargoInvoiceItems(client, invoiceSerialNumber);
      const normalized = normalizeTrendyolCargoInvoiceItems(
        invoiceSerialNumber,
        items,
        sourceUpdatedAt &&
          Number.isFinite(sourceUpdatedAt.getTime())
          ? sourceUpdatedAt
          : null
      );
      skippedCargoItems += normalized.skippedItems;
      if (normalized.records.length === 0) {
        skippedCargoInvoices++;
        continue;
      }
      cargoInvoices++;
      cargoRecords.push(...normalized.records);
    } catch (error) {
      // Cari ekstre kaydı oluşup detay henüz hazır değilse bir sonraki manuel
      // senkron deneyecek. Yetki/ağ hatalarını ise kullanıcıya göster.
      if (
        error instanceof TrendyolApiError &&
        (error.status === 400 || error.status === 404)
      ) {
        skippedCargoInvoices++;
        continue;
      }
      throw error;
    }
  }

  for (let offset = 0; offset < cargoRecords.length; offset += 50) {
    const chunk = cargoRecords.slice(offset, offset + 50);
    await prisma.$transaction(
      chunk.map((row) =>
        prisma.platformOrderCargoItem.upsert({
          where: {
            platform_invoiceSerialNumber_parcelUniqueId_shipmentType: {
              platform: "trendyol",
              invoiceSerialNumber: row.invoiceSerialNumber,
              parcelUniqueId: row.parcelUniqueId,
              shipmentType: row.shipmentType,
            },
          },
          create: {
            id: `poci:trendyol:${row.invoiceSerialNumber}:${row.parcelUniqueId}:${row.shipmentType}`,
            platform: "trendyol",
            invoiceSerialNumber: row.invoiceSerialNumber,
            parcelUniqueId: row.parcelUniqueId,
            orderNumber: row.orderNumber,
            shipmentType: row.shipmentType,
            amountKurus: tlToKurus(row.amount),
            desi: row.desi,
            sourceUpdatedAt: row.sourceUpdatedAt,
            syncedAt,
          },
          update: {
            orderNumber: row.orderNumber,
            amountKurus: tlToKurus(row.amount),
            desi: row.desi,
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
    cargoInvoiceRecords: cargoInvoiceFinancials.length,
    cargoInvoices,
    cargoItems: cargoRecords.length,
    cargoOrders: new Set(cargoRecords.map((row) => row.orderNumber)).size,
    skippedCargoInvoices,
    skippedCargoItems,
    days,
    syncedAt: syncedAt.toISOString(),
  };
}
