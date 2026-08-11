import { NextRequest, NextResponse } from "next/server";
import { prisma, remotePrisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import {
  aggregateMonthlyFinance,
  FINANCE_TIME_ZONE,
  monthlyFinanceWindowStart,
} from "@/lib/monthly-finance";
import { swr } from "@/lib/route-cache";

export async function GET(req: NextRequest) {
  const requested = Number(req.nextUrl.searchParams.get("months") ?? 12);
  const monthCount = Number.isFinite(requested)
    ? Math.max(1, Math.min(24, Math.trunc(requested)))
    : 12;
  // v3: yanıta KDV özeti eklendi. Sürüm artmazsa güncelleme sonrası diskteki eski yanıt
  // (KDV alanı olmayan) taze sayılıp gösterilirdi.
  const data = await swr(
    `finance-monthly:v3:${monthCount}`,
    60_000,
    () => computeMonthlyFinance(monthCount)
  );
  return NextResponse.json(data, {
    headers: { "Cache-Control": "no-store" },
  });
}

async function computeMonthlyFinance(monthCount: number) {
  await ensureRuntimeSchema();

  // Pencere ve toplama AYNI "şimdi"yi kullanmalı; yoksa istek tam ay dönümüne denk gelirse
  // çekilen aralık ile toplanan aylar bir ay kayabilir.
  const now = new Date();
  const windowStart = monthlyFinanceWindowStart(monthCount, now, FINANCE_TIME_ZONE);

  const [
    snapshots,
    manualOrders,
    expenses,
    actualCommissionSummary,
    snapshotSummary,
    manualOrderSummary,
  ] = await Promise.all([
    // Yalnız gösterilen ay aralığı okunur (satır sayısı sabit kalır); dışarıdaki satırlar
    // zaten hiçbir aya düşmüyordu.
    prisma.orderFinanceSnapshot.findMany({
      where: { platform: { not: "manual" }, orderedAt: { gte: windowStart } },
      select: {
        platform: true,
        orderedAt: true,
        revenueKurus: true,
        profitKurus: true,
        profitPartial: true,
        statusKind: true,
        currency: true,
      },
    }),
    remotePrisma.manualOrder.findMany({
      where: { orderedAt: { gte: windowStart } },
      select: {
        orderedAt: true,
        revenueKurus: true,
        // KDV özeti bu iki kayıtlı alandan çıkar (motorun kendi çıktısı) — yeni hesap yok.
        netRevenueKurus: true,
        inputVatCreditKurus: true,
        profitKurus: true,
        profitPartial: true,
        statusKind: true,
        currency: true,
      },
    }),
    remotePrisma.actualExpense.findMany({
      where: { paidAt: { gte: windowStart } },
      select: { paidAt: true, amountKurus: true },
    }),
    prisma.platformOrderFinancial.aggregate({
      where: { platform: "trendyol" },
      _count: { _all: true },
      _max: { syncedAt: true },
    }),
    // "Geçmiş şu tarihten beri" ve "son senkron" bilgisi TÜM geçmişi kapsar → satırları
    // çekmeden özetten okunur.
    prisma.orderFinanceSnapshot.aggregate({
      where: { platform: { not: "manual" } },
      _min: { orderedAt: true },
      _max: { syncedAt: true },
    }),
    remotePrisma.manualOrder.aggregate({ _min: { orderedAt: true } }),
  ]);

  const months = aggregateMonthlyFinance({
    snapshots,
    manualOrders,
    expenses,
    monthCount,
    now,
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
  // KDV toplamı ay ay toplanır (ay içindeki kuruş yuvarlaması tek kaynakta kalsın diye
  // ayrıca hesaplanmaz, aylık çıktılar üst üste eklenir).
  const vat = months.reduce(
    (sum, month) => ({
      outputVat: Number((sum.outputVat + month.vat.outputVat).toFixed(2)),
      inputVatCredit: Number((sum.inputVatCredit + month.vat.inputVatCredit).toFixed(2)),
      payable: Number((sum.payable + month.vat.payable).toFixed(2)),
      knownOrders: sum.knownOrders + month.vat.knownOrders,
      partialOrders: sum.partialOrders + month.vat.partialOrders,
      unknownOrders: sum.unknownOrders + month.vat.unknownOrders,
      unknownRevenue: Number((sum.unknownRevenue + month.vat.unknownRevenue).toFixed(2)),
    }),
    {
      outputVat: 0,
      inputVatCredit: 0,
      payable: 0,
      knownOrders: 0,
      partialOrders: 0,
      unknownOrders: 0,
      unknownRevenue: 0,
    }
  );
  const quality = {
    incompleteOrders: totals.incompleteOrders,
    partialProfitOrders: totals.partialProfitOrders,
    missingProfitOrders: totals.missingProfitOrders,
    excludedOrders: totals.excludedOrders,
    unsupportedCurrencyOrders: totals.unsupportedCurrencyOrders,
  };
  const lastOrderSyncAt = snapshotSummary._max.syncedAt ?? null;
  const firstOrderedAt = [
    snapshotSummary._min.orderedAt,
    manualOrderSummary._min.orderedAt,
  ]
    .filter((value): value is Date => value != null)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return {
    currency: "TRY",
    timeZone: FINANCE_TIME_ZONE,
    generatedAt: now.toISOString(),
    dataFrom: firstOrderedAt?.toISOString() ?? null,
    lastOrderSyncAt: lastOrderSyncAt?.toISOString() ?? null,
    actualCommissionOrders: actualCommissionSummary._count._all,
    lastActualCommissionSyncAt:
      actualCommissionSummary._max.syncedAt?.toISOString() ?? null,
    totals: { ...totals, vat },
    months,
    quality,
  };
}
