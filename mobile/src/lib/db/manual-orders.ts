import {
  MANUAL_ORDER_CALCULATION_VERSION,
  calculateManualOrder,
  type ManualOrderBreakdown,
  type ManualOrderCalculationInput,
  type ManualOrderMode,
  type ManualOrderResolvedItem,
  type ManualOrderStatusKind,
} from "@core/manual-order";

import { ensureManualOrderSchema } from "@/lib/db/schema";
import { tlToKurus } from "@/lib/db/finance";
import { execute, query } from "@/lib/turso";

interface ManualOrderRow {
  id: string;
  orderNumber: string;
  mode: string;
  orderedAt: string | number;
  statusKind: string;
  customerName: string | null;
  currency: string;
  revenueKurus: number;
  netRevenueKurus: number;
  totalCostKurus: number;
  inputVatCreditKurus: number;
  profitKurus: number | null;
  profitPartial: number | boolean;
  itemsJson: string;
  breakdownJson: string;
  calculationVersion: number;
  note: string | null;
  createdAt: string | number;
  updatedAt: string | number;
}

type ManualOrderStoredItem = ManualOrderResolvedItem & {
  kind?: ManualOrderMode;
};

interface ItemsEnvelope {
  version: 1;
  items: ManualOrderStoredItem[];
}

interface BreakdownEnvelope {
  version: 1;
  draft: ManualOrderCalculationInput;
  breakdown: ManualOrderBreakdown;
}

export interface ManualOrder {
  id: string;
  orderNumber: string;
  mode: ManualOrderMode;
  orderedAt: string;
  statusKind: ManualOrderStatusKind;
  customerName: string | null;
  currency: "TRY";
  revenueKurus: number;
  netRevenueKurus: number;
  totalCostKurus: number;
  inputVatCreditKurus: number;
  profitKurus: number | null;
  profitPartial: boolean;
  items: ManualOrderResolvedItem[];
  draft: ManualOrderCalculationInput;
  breakdown: ManualOrderBreakdown;
  calculationVersion: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManualOrderWriteInput {
  orderNumber?: string | null;
  orderedAt: string;
  statusKind: ManualOrderStatusKind;
  customerName?: string | null;
  note?: string | null;
  draft: ManualOrderCalculationInput;
}

const STATUS_KINDS = new Set<ManualOrderStatusKind>([
  "pending",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
]);

const SELECT_COLUMNS = `
  "id", "orderNumber", "mode", "orderedAt", "statusKind", "customerName",
  "currency", "revenueKurus", "netRevenueKurus", "totalCostKurus",
  "inputVatCreditKurus", "profitKurus", "profitPartial", "itemsJson",
  "breakdownJson", "calculationVersion", "note", "createdAt", "updatedAt"
`;

function newId(prefix: string): string {
  return (
    prefix +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  );
}

function generatedOrderNumber(): string {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .replaceAll("-", "");
  return `M-${date}-${newId("").slice(-6).toUpperCase()}`;
}

function asIso(value: string | number): string {
  const numeric =
    typeof value === "number" ? value : /^\d+$/.test(String(value)) ? Number(value) : null;
  const date = new Date(
    numeric == null ? String(value) : numeric < 100_000_000_000 ? numeric * 1000 : numeric
  );
  if (!Number.isFinite(date.getTime())) throw new Error("Manuel sipariş tarihi geçersiz.");
  return date.toISOString();
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Manuel siparişin ${label} verisi okunamadı.`);
  }
}

function normalizeText(
  value: string | null | undefined,
  maxLength: number,
  label: string
): string | null {
  const normalized = value?.trim() || null;
  if (normalized && normalized.length > maxLength) {
    throw new Error(`${label} en fazla ${maxLength} karakter olabilir.`);
  }
  return normalized;
}

function validateDraft(draft: ManualOrderCalculationInput): void {
  if (draft.mode !== "catalog" && draft.mode !== "freeform") {
    throw new Error("Sipariş türü geçersiz.");
  }
  if (!Number.isFinite(draft.saleTotal) || draft.saleTotal < 0) {
    throw new Error("Satış tutarı negatif olamaz.");
  }
  if (!Number.isFinite(draft.vatRate) || draft.vatRate < 0 || draft.vatRate > 100) {
    throw new Error("KDV oranı 0 ile 100 arasında olmalı.");
  }
  for (const [label, amount] of [
    ["Komisyon", draft.commission.amount],
    ["Kargo", draft.cargo.amount],
  ] as const) {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`${label} tutarı negatif olamaz.`);
    }
  }
  if (draft.expenseRules.length > 100 || draft.customExpenses.length > 100) {
    throw new Error("Bir siparişte en fazla 100 ek gider olabilir.");
  }
  for (const expense of draft.expenseRules) {
    if (
      !expense.id.trim() ||
      !expense.name.trim() ||
      !Number.isFinite(expense.value) ||
      expense.value < 0 ||
      (expense.amount != null &&
        (!Number.isFinite(expense.amount) || expense.amount < 0))
    ) {
      throw new Error("Seçili gider kurallarından biri geçersiz.");
    }
  }
  for (const expense of draft.customExpenses) {
    if (
      !expense.id.trim() ||
      !expense.name.trim() ||
      !Number.isFinite(expense.amount) ||
      expense.amount < 0
    ) {
      throw new Error("Özel giderlerden biri geçersiz.");
    }
  }
  if (draft.items.length === 0) throw new Error("En az bir sipariş kalemi ekleyin.");
  if (draft.items.length > 250) throw new Error("Bir siparişte en fazla 250 kalem olabilir.");

  for (const item of draft.items) {
    if (!item.name.trim() || item.name.trim().length > 200) {
      throw new Error("Kalem adı 1-200 karakter olmalı.");
    }
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10_000) {
      throw new Error(`${item.name}: adet 1 ile 10.000 arasında olmalı.`);
    }
    const costs = [
      item.productionCost,
      item.packagingCost,
      item.filamentCost,
      ...(item.packagingComponents?.map((component) => component.cost) ?? []),
    ];
    if (costs.some((cost) => !Number.isFinite(cost) || cost < 0)) {
      throw new Error(`${item.name}: maliyet negatif olamaz.`);
    }
    if (
      item.manualUnitCost != null &&
      (!Number.isFinite(item.manualUnitCost) || item.manualUnitCost < 0)
    ) {
      throw new Error(`${item.name}: birim maliyet negatif olamaz.`);
    }
  }
}

function rowToManualOrder(row: ManualOrderRow): ManualOrder {
  const itemsEnvelope = parseJson<ItemsEnvelope>(row.itemsJson, "kalem");
  const breakdownEnvelope = parseJson<BreakdownEnvelope>(row.breakdownJson, "hesap");
  if (
    itemsEnvelope.version !== 1 ||
    !Array.isArray(itemsEnvelope.items) ||
    breakdownEnvelope.version !== 1 ||
    !breakdownEnvelope.draft ||
    !breakdownEnvelope.breakdown
  ) {
    throw new Error("Manuel sipariş veri sürümü desteklenmiyor.");
  }
  if (row.mode !== "catalog" && row.mode !== "freeform") {
    throw new Error("Manuel sipariş türü desteklenmiyor.");
  }
  if (!STATUS_KINDS.has(row.statusKind as ManualOrderStatusKind)) {
    throw new Error("Manuel sipariş durumu desteklenmiyor.");
  }

  return {
    id: row.id,
    orderNumber: row.orderNumber,
    mode: row.mode,
    orderedAt: asIso(row.orderedAt),
    statusKind: row.statusKind as ManualOrderStatusKind,
    customerName: row.customerName,
    currency: "TRY",
    revenueKurus: Number(row.revenueKurus) || 0,
    netRevenueKurus: Number(row.netRevenueKurus) || 0,
    totalCostKurus: Number(row.totalCostKurus) || 0,
    inputVatCreditKurus: Number(row.inputVatCreditKurus) || 0,
    profitKurus: row.profitKurus == null ? null : Number(row.profitKurus),
    profitPartial: Boolean(row.profitPartial),
    items: itemsEnvelope.items,
    draft: breakdownEnvelope.draft,
    breakdown: breakdownEnvelope.breakdown,
    calculationVersion: Number(row.calculationVersion) || 1,
    note: row.note,
    createdAt: asIso(row.createdAt),
    updatedAt: asIso(row.updatedAt),
  };
}

function normalizedWrite(input: ManualOrderWriteInput) {
  validateDraft(input.draft);
  if (!STATUS_KINDS.has(input.statusKind)) throw new Error("Sipariş durumu geçersiz.");
  const orderedAt = asIso(input.orderedAt);
  const customerName = normalizeText(input.customerName, 160, "Müşteri adı");
  const note = normalizeText(input.note, 1_000, "Not");
  const requestedOrderNumber = normalizeText(input.orderNumber, 80, "Sipariş numarası");
  const storedItems: ManualOrderStoredItem[] = input.draft.items.map((item) => ({
    ...item,
    kind: input.draft.mode,
  }));
  const storedDraft: ManualOrderCalculationInput = {
    ...input.draft,
    items: storedItems,
  };
  const breakdown = calculateManualOrder(storedDraft);
  const itemsJson = JSON.stringify({
    version: 1,
    items: storedItems,
  } satisfies ItemsEnvelope);
  const breakdownJson = JSON.stringify({
    version: 1,
    draft: storedDraft,
    breakdown,
  } satisfies BreakdownEnvelope);

  return {
    orderedAt,
    customerName,
    note,
    orderNumber: requestedOrderNumber,
    breakdown,
    itemsJson,
    breakdownJson,
  };
}

export async function getManualOrdersSince(cutoffMs: number): Promise<ManualOrder[]> {
  await ensureManualOrderSchema();
  const cutoff = new Date(cutoffMs).toISOString();
  const rows = await query<ManualOrderRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM "ManualOrder"
      WHERE "orderedAt" >= ?
      ORDER BY "orderedAt" DESC, "createdAt" DESC`,
    [cutoff]
  );
  const orders: ManualOrder[] = [];
  for (const row of rows) {
    try {
      orders.push(rowToManualOrder(row));
    } catch (error) {
      console.warn(`Bozuk manuel sipariş atlandı (${row.id}).`, error);
    }
  }
  return orders;
}

export async function getManualOrder(id: string): Promise<ManualOrder | null> {
  await ensureManualOrderSchema();
  const rows = await query<ManualOrderRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM "ManualOrder"
      WHERE "id" = ?
      LIMIT 1`,
    [id]
  );
  return rows[0] ? rowToManualOrder(rows[0]) : null;
}

export async function createManualOrder(input: ManualOrderWriteInput): Promise<string> {
  await ensureManualOrderSchema();
  const normalized = normalizedWrite(input);
  const id = newId("mo_");
  const orderNumber = normalized.orderNumber ?? generatedOrderNumber();
  const now = new Date().toISOString();
  await execute(
    `INSERT INTO "ManualOrder" (
       "id", "orderNumber", "mode", "orderedAt", "statusKind", "customerName",
       "currency", "revenueKurus", "netRevenueKurus", "totalCostKurus",
       "inputVatCreditKurus", "profitKurus", "profitPartial", "itemsJson",
       "breakdownJson", "calculationVersion", "note", "createdAt", "updatedAt"
     ) VALUES (?, ?, ?, ?, ?, ?, 'TRY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      orderNumber,
      input.draft.mode,
      normalized.orderedAt,
      input.statusKind,
      normalized.customerName,
      tlToKurus(normalized.breakdown.grossRevenue),
      tlToKurus(normalized.breakdown.netRevenue),
      tlToKurus(normalized.breakdown.totalCost),
      tlToKurus(normalized.breakdown.inputVatCredit),
      normalized.breakdown.netProfit == null
        ? null
        : tlToKurus(normalized.breakdown.netProfit),
      normalized.breakdown.profitPartial,
      normalized.itemsJson,
      normalized.breakdownJson,
      MANUAL_ORDER_CALCULATION_VERSION,
      normalized.note,
      now,
      now,
    ]
  );
  return id;
}

export async function updateManualOrder(
  id: string,
  input: ManualOrderWriteInput
): Promise<void> {
  await ensureManualOrderSchema();
  const normalized = normalizedWrite(input);
  const current = await getManualOrder(id);
  if (!current) throw new Error("Manuel sipariş bulunamadı.");
  const result = await execute(
    `UPDATE "ManualOrder"
        SET "orderNumber" = ?, "mode" = ?, "orderedAt" = ?, "statusKind" = ?,
            "customerName" = ?, "currency" = 'TRY', "revenueKurus" = ?,
            "netRevenueKurus" = ?, "totalCostKurus" = ?, "inputVatCreditKurus" = ?,
            "profitKurus" = ?, "profitPartial" = ?, "itemsJson" = ?,
            "breakdownJson" = ?, "calculationVersion" = ?, "note" = ?, "updatedAt" = ?
      WHERE "id" = ?`,
    [
      normalized.orderNumber ?? current.orderNumber,
      input.draft.mode,
      normalized.orderedAt,
      input.statusKind,
      normalized.customerName,
      tlToKurus(normalized.breakdown.grossRevenue),
      tlToKurus(normalized.breakdown.netRevenue),
      tlToKurus(normalized.breakdown.totalCost),
      tlToKurus(normalized.breakdown.inputVatCredit),
      normalized.breakdown.netProfit == null
        ? null
        : tlToKurus(normalized.breakdown.netProfit),
      normalized.breakdown.profitPartial,
      normalized.itemsJson,
      normalized.breakdownJson,
      MANUAL_ORDER_CALCULATION_VERSION,
      normalized.note,
      new Date().toISOString(),
      id,
    ]
  );
  if (result.rowsAffected === 0) throw new Error("Manuel sipariş bulunamadı.");
}

export async function deleteManualOrder(id: string): Promise<void> {
  await ensureManualOrderSchema();
  const result = await execute(`DELETE FROM "ManualOrder" WHERE "id" = ?`, [id]);
  if (result.rowsAffected === 0) throw new Error("Manuel sipariş bulunamadı.");
}
