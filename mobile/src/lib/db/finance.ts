import { batch, execute, query } from "@/lib/turso";
import { ensureFinanceSchema } from "@/lib/db/schema";

const ISTANBUL_TZ = "Europe/Istanbul";

export interface OrderFinanceSnapshotInput {
  platform: string;
  externalOrderId: string;
  orderNumber: string;
  orderedAt: number | string | Date;
  revenue: number;
  profit: number | null;
  profitPartial: boolean;
  statusKind: string;
  currency?: string;
}

export interface ActualExpense {
  id: string;
  name: string;
  category: string | null;
  amountKurus: number;
  paidAt: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActualExpenseInput {
  name: string;
  category?: string | null;
  amountKurus: number;
  paidAt: string;
  note?: string | null;
}

export interface MonthlyFinance {
  month: string;
  label: string;
  revenueKurus: number;
  orderProfitKurus: number;
  expensesKurus: number;
  netProfitKurus: number;
  orderCount: number;
  unknownProfitOrders: number;
  partialProfitOrders: number;
  incompleteOrders: number;
  unsupportedCurrencyOrders: number;
}

export interface MonthlyFinanceSummary {
  periods: MonthlyFinance[];
  historyStartedAt: string | null;
  lastSyncedAt: string | null;
}

interface SnapshotRow {
  orderedAt: string | number;
  revenueKurus: number;
  profitKurus: number | null;
  profitPartial: number | boolean;
  statusKind: string;
  currency: string;
  syncedAt: string | number;
}

interface ExpenseRow {
  paidAt: string | number;
  amountKurus: number;
}

function genId(prefix: string): string {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function tlToKurus(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Geçersiz para tutarı.");
  const sign = value < 0 ? -1 : 1;
  const [coefficient, exponent = "0"] = Math.abs(value).toString().split("e");
  const shifted = Number(`${coefficient}e${Number(exponent) + 2}`);
  const rounded = Math.round(shifted);
  const maxMagnitude = sign < 0 ? 2_147_483_648 : 2_147_483_647;
  if (!Number.isSafeInteger(rounded) || rounded > maxMagnitude) {
    throw new Error("Para tutarı desteklenen sınırı aşıyor.");
  }
  return sign * rounded;
}

function validateExpenseInput(input: ActualExpenseInput): void {
  if (!input.name.trim() || input.name.trim().length > 120) {
    throw new Error("Gider adı 1-120 karakter olmalı.");
  }
  if (
    !Number.isSafeInteger(input.amountKurus) ||
    input.amountKurus <= 0 ||
    input.amountKurus > 2_147_483_647
  ) {
    throw new Error("Gider tutarı geçersiz.");
  }
  if (!Number.isFinite(asDate(input.paidAt).getTime())) {
    throw new Error("Ödeme tarihi geçersiz.");
  }
  if ((input.category?.trim().length ?? 0) > 60) {
    throw new Error("Kategori en fazla 60 karakter olabilir.");
  }
  if ((input.note?.trim().length ?? 0) > 500) {
    throw new Error("Not en fazla 500 karakter olabilir.");
  }
}

function asDate(value: string | number | Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") {
    return new Date(value < 100_000_000_000 ? value * 1000 : value);
  }
  const numeric = /^\d+$/.test(value) ? Number(value) : null;
  return new Date(
    numeric == null ? value : numeric < 100_000_000_000 ? numeric * 1000 : numeric
  );
}

function monthKey(value: string | number | Date): string | null {
  const date = asDate(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ISTANBUL_TZ,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : null;
}

function currentMonthParts(now: Date): { year: number; month: number } {
  const key = monthKey(now) ?? now.toISOString().slice(0, 7);
  const [year, month] = key.split("-").map(Number);
  return { year, month };
}

function lastMonthKeys(count: number, now = new Date()): string[] {
  const { year, month } = currentMonthParts(now);
  const keys: string[] = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const serial = year * 12 + (month - 1) - offset;
    keys.push(`${Math.floor(serial / 12)}-${String((serial % 12) + 1).padStart(2, "0")}`);
  }
  return keys;
}

function monthLabel(key: string): string {
  return new Intl.DateTimeFormat("tr-TR", {
    month: "short",
    year: "2-digit",
    timeZone: ISTANBUL_TZ,
  }).format(new Date(`${key}-15T12:00:00.000Z`));
}

function isoOrNull(value: string | number | undefined): string | null {
  if (value == null) return null;
  const date = asDate(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Erişilebilen platform verisini kuruş cinsinden kalıcı finans geçmişine işler. */
export async function syncOrderFinanceSnapshots(
  snapshots: OrderFinanceSnapshotInput[]
): Promise<void> {
  await ensureFinanceSchema();
  if (snapshots.length === 0) return;
  const now = new Date().toISOString();
  const statements = snapshots
    .filter((snapshot) => Number.isFinite(asDate(snapshot.orderedAt).getTime()))
    .map((snapshot) => ({
      sql: `INSERT INTO "OrderFinanceSnapshot"
              ("id", "platform", "externalOrderId", "orderNumber", "orderedAt",
               "revenueKurus", "profitKurus", "profitPartial", "statusKind",
               "currency", "syncedAt", "calculationVersion")
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT ("platform", "externalOrderId") DO UPDATE SET
              "orderNumber" = excluded."orderNumber",
              "orderedAt" = excluded."orderedAt",
              "profitKurus" = CASE
                WHEN "OrderFinanceSnapshot"."revenueKurus" <> excluded."revenueKurus"
                  OR ("OrderFinanceSnapshot"."profitKurus" IS NULL
                      AND excluded."profitKurus" IS NOT NULL)
                  OR ("OrderFinanceSnapshot"."profitPartial" = 1
                      AND excluded."profitPartial" = 0
                      AND excluded."profitKurus" IS NOT NULL)
                THEN excluded."profitKurus"
                ELSE "OrderFinanceSnapshot"."profitKurus"
              END,
              "profitPartial" = CASE
                WHEN "OrderFinanceSnapshot"."revenueKurus" <> excluded."revenueKurus"
                  OR ("OrderFinanceSnapshot"."profitKurus" IS NULL
                      AND excluded."profitKurus" IS NOT NULL)
                  OR ("OrderFinanceSnapshot"."profitPartial" = 1
                      AND excluded."profitPartial" = 0
                      AND excluded."profitKurus" IS NOT NULL)
                THEN excluded."profitPartial"
                ELSE "OrderFinanceSnapshot"."profitPartial"
              END,
              "calculationVersion" = CASE
                WHEN "OrderFinanceSnapshot"."revenueKurus" <> excluded."revenueKurus"
                  OR ("OrderFinanceSnapshot"."profitKurus" IS NULL
                      AND excluded."profitKurus" IS NOT NULL)
                  OR ("OrderFinanceSnapshot"."profitPartial" = 1
                      AND excluded."profitPartial" = 0
                      AND excluded."profitKurus" IS NOT NULL)
                THEN excluded."calculationVersion"
                ELSE "OrderFinanceSnapshot"."calculationVersion"
              END,
              "revenueKurus" = excluded."revenueKurus",
              "statusKind" = excluded."statusKind",
              "currency" = excluded."currency",
              "syncedAt" = excluded."syncedAt"`,
      args: [
        `ofs:${snapshot.platform}:${snapshot.externalOrderId}`,
        snapshot.platform,
        snapshot.externalOrderId,
        snapshot.orderNumber,
        asDate(snapshot.orderedAt).toISOString(),
        tlToKurus(snapshot.revenue),
        snapshot.profit == null ? null : tlToKurus(snapshot.profit),
        snapshot.profitPartial,
        snapshot.statusKind,
        snapshot.currency ?? "TRY",
        now,
      ],
    }));
  for (let offset = 0; offset < statements.length; offset += 50) {
    await batch(statements.slice(offset, offset + 50));
  }
}

export async function getActualExpenses(): Promise<ActualExpense[]> {
  await ensureFinanceSchema();
  return query<ActualExpense>(
    `SELECT "id", "name", "category", "amountKurus", "paidAt", "note", "createdAt", "updatedAt"
       FROM "ActualExpense"
      ORDER BY "paidAt" DESC, "createdAt" DESC`
  );
}

export async function createActualExpense(input: ActualExpenseInput): Promise<void> {
  await ensureFinanceSchema();
  validateExpenseInput(input);
  const now = new Date().toISOString();
  await execute(
    `INSERT INTO "ActualExpense"
       ("id", "name", "category", "amountKurus", "paidAt", "note", "createdAt", "updatedAt")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      genId("ae:"),
      input.name.trim(),
      input.category?.trim() || null,
      Math.round(input.amountKurus),
      input.paidAt,
      input.note?.trim() || null,
      now,
      now,
    ]
  );
}

export async function updateActualExpense(
  id: string,
  input: ActualExpenseInput
): Promise<void> {
  await ensureFinanceSchema();
  validateExpenseInput(input);
  await execute(
    `UPDATE "ActualExpense"
        SET "name" = ?, "category" = ?, "amountKurus" = ?, "paidAt" = ?,
            "note" = ?, "updatedAt" = ?
      WHERE "id" = ?`,
    [
      input.name.trim(),
      input.category?.trim() || null,
      Math.round(input.amountKurus),
      input.paidAt,
      input.note?.trim() || null,
      new Date().toISOString(),
      id,
    ]
  );
}

export async function deleteActualExpense(id: string): Promise<void> {
  await ensureFinanceSchema();
  await execute(`DELETE FROM "ActualExpense" WHERE "id" = ?`, [id]);
}

export async function getMonthlyFinanceSummary(
  monthCount = 12,
  now = new Date()
): Promise<MonthlyFinanceSummary> {
  await ensureFinanceSchema();
  const [snapshots, expenses] = await Promise.all([
    query<SnapshotRow>(
      `SELECT "orderedAt", "revenueKurus", "profitKurus", "profitPartial",
              "statusKind", "currency", "syncedAt"
         FROM "OrderFinanceSnapshot"
        ORDER BY "orderedAt" ASC`
    ),
    query<ExpenseRow>(
      `SELECT "paidAt", "amountKurus"
         FROM "ActualExpense"
        ORDER BY "paidAt" ASC`
    ),
  ]);

  const keys = lastMonthKeys(Math.max(1, Math.min(24, monthCount)), now);
  const byMonth = new Map<string, MonthlyFinance>(
    keys.map((key) => [
      key,
      {
        month: key,
        label: monthLabel(key),
        revenueKurus: 0,
        orderProfitKurus: 0,
        expensesKurus: 0,
        netProfitKurus: 0,
        orderCount: 0,
        unknownProfitOrders: 0,
        partialProfitOrders: 0,
        incompleteOrders: 0,
        unsupportedCurrencyOrders: 0,
      },
    ])
  );

  for (const snapshot of snapshots) {
    if (snapshot.statusKind === "cancelled") continue;
    const bucket = byMonth.get(monthKey(snapshot.orderedAt) ?? "");
    if (!bucket) continue;
    if ((snapshot.currency || "TRY").trim().toUpperCase() !== "TRY") {
      bucket.unsupportedCurrencyOrders++;
      continue;
    }
    bucket.revenueKurus += Number(snapshot.revenueKurus) || 0;
    bucket.orderCount++;
    if (snapshot.profitKurus == null) bucket.unknownProfitOrders++;
    else bucket.orderProfitKurus += Number(snapshot.profitKurus) || 0;
    if (!!snapshot.profitPartial) bucket.partialProfitOrders++;
    if (snapshot.profitKurus == null || !!snapshot.profitPartial) bucket.incompleteOrders++;
  }
  for (const expense of expenses) {
    const bucket = byMonth.get(monthKey(expense.paidAt) ?? "");
    if (bucket) bucket.expensesKurus += Number(expense.amountKurus) || 0;
  }

  const periods = keys.map((key) => {
    const bucket = byMonth.get(key)!;
    bucket.netProfitKurus = bucket.orderProfitKurus - bucket.expensesKurus;
    return bucket;
  });
  return {
    periods,
    historyStartedAt: isoOrNull(snapshots[0]?.orderedAt),
    lastSyncedAt:
      snapshots.reduce<string | null>((latest, snapshot) => {
        const iso = isoOrNull(snapshot.syncedAt);
        return !iso || (latest && latest >= iso) ? latest : iso;
      }, null),
  };
}
