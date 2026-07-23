export const FINANCE_TIME_ZONE = "Europe/Istanbul";
export const FINANCE_CALCULATION_VERSION = 1;

export function tlToKurus(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Geçersiz para tutarı");
  const sign = value < 0 ? -1 : 1;
  const [coefficient, exponent = "0"] = Math.abs(value).toString().split("e");
  const shifted = Number(`${coefficient}e${Number(exponent) + 2}`);
  const rounded = Math.round(shifted);
  const maxMagnitude = sign < 0 ? 2_147_483_648 : 2_147_483_647;
  if (!Number.isSafeInteger(rounded) || rounded > maxMagnitude) {
    throw new Error("Para tutarı desteklenen sınırı aşıyor");
  }
  return sign * rounded;
}

export function kurusToTl(value: number): number {
  return Number((value / 100).toFixed(2));
}

type SnapshotInput = {
  platform: string;
  orderedAt: Date;
  revenueKurus: number;
  profitKurus: number | null;
  profitPartial: boolean;
  statusKind: string;
  currency: string;
};

type ExpenseInput = {
  paidAt: Date;
  amountKurus: number;
};

type PlatformKurus = {
  revenueKurus: number;
  orderProfitKurus: number;
  orderCount: number;
};

type MonthKurus = {
  month: string;
  label: string;
  revenueKurus: number;
  orderProfitKurus: number;
  expensesKurus: number;
  orderCount: number;
  incompleteOrders: number;
  partialProfitOrders: number;
  missingProfitOrders: number;
  excludedOrders: number;
  unsupportedCurrencyOrders: number;
  byPlatform: Record<string, PlatformKurus>;
};

export interface MonthlyFinanceItem {
  month: string;
  label: string;
  revenue: number;
  orderProfit: number;
  expenses: number;
  netProfit: number;
  orderCount: number;
  incompleteOrders: number;
  partialProfitOrders: number;
  missingProfitOrders: number;
  excludedOrders: number;
  unsupportedCurrencyOrders: number;
  byPlatform: Record<
    string,
    { revenue: number; orderProfit: number; orderCount: number }
  >;
}

function dateParts(value: Date, timeZone: string): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(value);
  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
  };
}

export function monthKey(value: Date, timeZone = FINANCE_TIME_ZONE): string {
  const { year, month } = dateParts(value, timeZone);
  return `${year}-${String(month).padStart(2, "0")}`;
}

function monthLabel(key: string, timeZone: string): string {
  const [year, month] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("tr-TR", {
    timeZone,
    month: "short",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, 15, 12)));
}

export function recentMonthKeys(
  count: number,
  now = new Date(),
  timeZone = FINANCE_TIME_ZONE
): string[] {
  const safeCount = Math.max(1, Math.min(24, Math.trunc(count)));
  const current = dateParts(now, timeZone);
  const result: string[] = [];
  for (let offset = safeCount - 1; offset >= 0; offset--) {
    const zeroBased = current.year * 12 + (current.month - 1) - offset;
    const year = Math.floor(zeroBased / 12);
    const month = (zeroBased % 12) + 1;
    result.push(`${year}-${String(month).padStart(2, "0")}`);
  }
  return result;
}

export function aggregateMonthlyFinance({
  snapshots,
  expenses,
  monthCount,
  now = new Date(),
  timeZone = FINANCE_TIME_ZONE,
}: {
  snapshots: SnapshotInput[];
  expenses: ExpenseInput[];
  monthCount: number;
  now?: Date;
  timeZone?: string;
}): MonthlyFinanceItem[] {
  const keys = recentMonthKeys(monthCount, now, timeZone);
  const months = new Map<string, MonthKurus>(
    keys.map((key) => [
      key,
      {
        month: key,
        label: monthLabel(key, timeZone),
        revenueKurus: 0,
        orderProfitKurus: 0,
        expensesKurus: 0,
        orderCount: 0,
        incompleteOrders: 0,
        partialProfitOrders: 0,
        missingProfitOrders: 0,
        excludedOrders: 0,
        unsupportedCurrencyOrders: 0,
        byPlatform: {
          shopify: { revenueKurus: 0, orderProfitKurus: 0, orderCount: 0 },
          trendyol: { revenueKurus: 0, orderProfitKurus: 0, orderCount: 0 },
          hepsiburada: { revenueKurus: 0, orderProfitKurus: 0, orderCount: 0 },
        },
      },
    ])
  );

  for (const snapshot of snapshots) {
    const bucket = months.get(monthKey(snapshot.orderedAt, timeZone));
    if (!bucket) continue;
    if (snapshot.statusKind === "cancelled") {
      bucket.excludedOrders++;
      continue;
    }
    if ((snapshot.currency || "TRY").trim().toUpperCase() !== "TRY") {
      bucket.excludedOrders++;
      bucket.unsupportedCurrencyOrders++;
      continue;
    }

    bucket.revenueKurus += snapshot.revenueKurus;
    bucket.orderCount++;
    if (snapshot.profitKurus == null) {
      bucket.missingProfitOrders++;
    } else {
      bucket.orderProfitKurus += snapshot.profitKurus;
    }
    if (snapshot.profitPartial) {
      bucket.partialProfitOrders++;
    }
    if (snapshot.profitKurus == null || snapshot.profitPartial) bucket.incompleteOrders++;

    const platform = (bucket.byPlatform[snapshot.platform] ??= {
      revenueKurus: 0,
      orderProfitKurus: 0,
      orderCount: 0,
    });
    platform.revenueKurus += snapshot.revenueKurus;
    platform.orderProfitKurus += snapshot.profitKurus ?? 0;
    platform.orderCount++;
  }

  for (const expense of expenses) {
    const bucket = months.get(monthKey(expense.paidAt, timeZone));
    if (bucket) bucket.expensesKurus += expense.amountKurus;
  }

  return keys.map((key) => {
    const bucket = months.get(key)!;
    return {
      month: bucket.month,
      label: bucket.label,
      revenue: kurusToTl(bucket.revenueKurus),
      orderProfit: kurusToTl(bucket.orderProfitKurus),
      expenses: kurusToTl(bucket.expensesKurus),
      netProfit: kurusToTl(bucket.orderProfitKurus - bucket.expensesKurus),
      orderCount: bucket.orderCount,
      incompleteOrders: bucket.incompleteOrders,
      partialProfitOrders: bucket.partialProfitOrders,
      missingProfitOrders: bucket.missingProfitOrders,
      excludedOrders: bucket.excludedOrders,
      unsupportedCurrencyOrders: bucket.unsupportedCurrencyOrders,
      byPlatform: Object.fromEntries(
        Object.entries(bucket.byPlatform).map(([platform, values]) => [
          platform,
          {
            revenue: kurusToTl(values.revenueKurus),
            orderProfit: kurusToTl(values.orderProfitKurus),
            orderCount: values.orderCount,
          },
        ])
      ),
    };
  });
}
