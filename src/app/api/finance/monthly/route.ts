import { NextRequest, NextResponse } from "next/server";
import { prisma, remotePrisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import {
  aggregateMonthlyFinance,
  FINANCE_TIME_ZONE,
} from "@/lib/monthly-finance";
import { swr } from "@/lib/route-cache";

export async function GET(req: NextRequest) {
  const requested = Number(req.nextUrl.searchParams.get("months") ?? 12);
  const monthCount = Number.isFinite(requested)
    ? Math.max(1, Math.min(24, Math.trunc(requested)))
    : 12;
  const data = await swr(
    `finance-monthly:v1:${monthCount}`,
    60_000,
    () => computeMonthlyFinance(monthCount)
  );
  return NextResponse.json(data, {
    headers: { "Cache-Control": "no-store" },
  });
}

async function computeMonthlyFinance(monthCount: number) {
  await ensureRuntimeSchema();

  const [snapshots, manualOrders, expenses] = await Promise.all([
    prisma.orderFinanceSnapshot.findMany({
      where: { platform: { not: "manual" } },
      orderBy: { orderedAt: "asc" },
    }),
    remotePrisma.manualOrder.findMany({
      orderBy: { orderedAt: "asc" },
      select: {
        orderedAt: true,
        revenueKurus: true,
        profitKurus: true,
        profitPartial: true,
        statusKind: true,
        currency: true,
      },
    }),
    remotePrisma.actualExpense.findMany({
      orderBy: { paidAt: "asc" },
    }),
  ]);

  const months = aggregateMonthlyFinance({
    snapshots,
    manualOrders,
    expenses,
    monthCount,
    timeZone: FINANCE_TIME_ZONE,
  });
  const totals = months.reduce(
    (sum, month) => ({
      revenue: Number((sum.revenue + month.revenue).toFixed(2)),
      orderProfit: Number((sum.orderProfit + month.orderProfit).toFixed(2)),
      expenses: Number((sum.expenses + month.expenses).toFixed(2)),
      netProfit: Number((sum.netProfit + month.netProfit).toFixed(2)),
      orderCount: sum.orderCount + month.orderCount,
      incompleteOrders: sum.incompleteOrders + month.incompleteOrders,
      partialProfitOrders: sum.partialProfitOrders + month.partialProfitOrders,
      missingProfitOrders: sum.missingProfitOrders + month.missingProfitOrders,
      excludedOrders: sum.excludedOrders + month.excludedOrders,
      unsupportedCurrencyOrders:
        sum.unsupportedCurrencyOrders + month.unsupportedCurrencyOrders,
    }),
    {
      revenue: 0,
      orderProfit: 0,
      expenses: 0,
      netProfit: 0,
      orderCount: 0,
      incompleteOrders: 0,
      partialProfitOrders: 0,
      missingProfitOrders: 0,
      excludedOrders: 0,
      unsupportedCurrencyOrders: 0,
    }
  );
  const quality = {
    incompleteOrders: totals.incompleteOrders,
    partialProfitOrders: totals.partialProfitOrders,
    missingProfitOrders: totals.missingProfitOrders,
    excludedOrders: totals.excludedOrders,
    unsupportedCurrencyOrders: totals.unsupportedCurrencyOrders,
  };
  const lastOrderSyncAt = snapshots.reduce<Date | null>(
    (latest, row) => (!latest || row.syncedAt > latest ? row.syncedAt : latest),
    null
  );

  return {
    currency: "TRY",
    timeZone: FINANCE_TIME_ZONE,
    generatedAt: new Date().toISOString(),
    dataFrom:
      [...snapshots, ...manualOrders]
        .map((row) => row.orderedAt)
        .sort((a, b) => a.getTime() - b.getTime())[0]
        ?.toISOString() ?? null,
    lastOrderSyncAt: lastOrderSyncAt?.toISOString() ?? null,
    totals,
    months,
    quality,
  };
}
