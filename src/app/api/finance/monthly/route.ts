import { NextRequest, NextResponse } from "next/server";
import { prisma, remotePrisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import {
  aggregateMonthlyFinance,
  FINANCE_TIME_ZONE,
  monthKey,
  monthlyFinanceWindowStart,
} from "@/lib/monthly-finance";
import { isFinanceSnapshotOutdated } from "@/core/finance-version";
import {
  financeRecalcState,
  startFinanceMonthRecalc,
} from "@/lib/order-finance-snapshots";
import { bustFinanceCaches } from "@/lib/cache-busting";
import { swr } from "@/lib/route-cache";

/**
 * ⚠️ TARİH ALANINDA `aggregate({ _min / _max })` KULLANMA.
 *
 * Uygulama Prisma'yı libSQL driver adapter'ı üzerinden çalıştırıyor. Toplama ifadesi
 * (MIN/MAX) kolonun tipini kaybettiği için Prisma dönen ham epoch-ms sayısını DateTime'a
 * çeviremiyor ve TÜM sorgu şu hatayla düşüyor:
 *
 *   Inconsistent column data: Could not convert value 1786394653611 to type `DateTime`
 *
 * `_count` ve SAYISAL `_min/_max` sorunsuz; kırılan yalnız tarih. Bunun yerine
 * `findFirst({ orderBy: { <tarih>: "asc" | "desc" }, select: { <tarih>: true } })` kullan —
 * doğru `Date` döner ve maliyeti aynıdır (LIMIT 1).
 *
 * Bu hata Raporlar sayfasını komple boş bıraktı (v0.19.139); regresyon testi:
 * `src/lib/date-aggregate.test.ts`.
 */
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function GET(req: NextRequest) {
  // Yeniden hesap ilerlemesi: ağır aylık toplama hiç çalıştırılmadan anında yanıtlanır
  // (arayüz bunu saniyede birkaç kez yokluyor).
  if (req.nextUrl.searchParams.get("recalc") === "status") {
    return NextResponse.json(
      { recalc: financeRecalcState() },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const requested = Number(req.nextUrl.searchParams.get("months") ?? 12);
  const monthCount = Number.isFinite(requested)
    ? Math.max(1, Math.min(24, Math.trunc(requested)))
    : 12;
  // v5: KDV özeti artık pazaryeri siparişlerini de kapsıyor (snapshot'ta kayıtlı KDV kolonları).
  // Sürüm artmazsa güncelleme sonrası diskteki eski yanıt (eksik kapsamlı) taze sayılırdı.
  //
  // try/catch neden ŞART: bu uç eskiden sarmalanmamıştı ve hata olunca Next GÖVDESİZ bir 500
  // döndürüyordu. Raporlar "veri alınamadı" yazıyor, sebep ise hiçbir yere yazılmıyordu —
  // teşhis için uygulamayı çalışır hâlde tek tek uç yoklamak gerekti. Diğer uçların hepsi
  // `jsonError` kullanıyor; bu da artık kullanıyor.
  try {
    const data = await swr(
      `finance-monthly:v5:${monthCount}`,
      60_000,
      () => computeMonthlyFinance(monthCount)
    );
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Bir ayı güncel maliyet/kural/oranlarla yeniden hesapla.
 *
 * Uzun sürebildiği için burada BEKLETMEYİZ: tur arka planda başlar, arayüz ilerlemeyi
 * `?recalc=status` ile okur. Tur bitince aylık yanıt önbelleği düşürülür ki yeni rakam
 * bir sonraki okumada görünsün.
 */
export async function POST(req: NextRequest) {
  const month = req.nextUrl.searchParams.get("month") ?? "";
  if (!MONTH_PATTERN.test(month)) {
    return NextResponse.json(
      { error: "Hangi ayın yeniden hesaplanacağı anlaşılmadı." },
      { status: 400 }
    );
  }
  await ensureRuntimeSchema();
  const state = startFinanceMonthRecalc(month, { onDone: () => bustFinanceCaches() });
  return NextResponse.json(
    { recalc: state },
    { headers: { "Cache-Control": "no-store" } }
  );
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
    actualCommissionCount,
    lastCommissionSync,
    firstSnapshot,
    lastSnapshotSync,
    firstManualOrder,
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
        // KDV motorun kayıtlı çıktısı; null = bu sipariş için henüz ayrıştırılmadı.
        outputVatKurus: true,
        inputVatCreditKurus: true,
        // "Bu ayın hesabı güncel değil" rozeti için — ayrı sorgu açmadan aynı satırlardan sayılır.
        calculationVersion: true,
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
    prisma.platformOrderFinancial.count({ where: { platform: "trendyol" } }),
    // ⚠️ TARİH alanında `aggregate({_min/_max})` KULLANMA — bkz. dosya başındaki uyarı.
    // "Geçmiş şu tarihten beri" ve "son senkron" TÜM geçmişi kapsar; satırları çekmeden
    // uçtaki tek satır okunur (LIMIT 1 + index) — maliyeti aggregate ile aynı.
    prisma.platformOrderFinancial.findFirst({
      where: { platform: "trendyol" },
      orderBy: { syncedAt: "desc" },
      select: { syncedAt: true },
    }),
    prisma.orderFinanceSnapshot.findFirst({
      where: { platform: { not: "manual" } },
      orderBy: { orderedAt: "asc" },
      select: { orderedAt: true },
    }),
    prisma.orderFinanceSnapshot.findFirst({
      where: { platform: { not: "manual" } },
      orderBy: { syncedAt: "desc" },
      select: { syncedAt: true },
    }),
    remotePrisma.manualOrder.findFirst({
      orderBy: { orderedAt: "asc" },
      select: { orderedAt: true },
    }),
  ]);

  // Eski hesap sürümüyle yazılmış siparişler ay ay sayılır: kullanıcı hangi ayın yeniden
  // hesaplanması gerektiğini görebilsin. İptal/yabancı para satırları da sayılır — onlar da
  // yeniden hesap kapsamındadır.
  const outdatedByMonth = new Map<string, number>();
  for (const snapshot of snapshots) {
    if (!isFinanceSnapshotOutdated(snapshot.calculationVersion)) continue;
    const key = monthKey(snapshot.orderedAt, FINANCE_TIME_ZONE);
    outdatedByMonth.set(key, (outdatedByMonth.get(key) ?? 0) + 1);
  }

  const months = aggregateMonthlyFinance({
    snapshots,
    manualOrders,
    expenses,
    monthCount,
    now,
    timeZone: FINANCE_TIME_ZONE,
  }).map((month) => ({
    ...month,
    outdatedOrders: outdatedByMonth.get(month.month) ?? 0,
  }));
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
    // KDV kapsamı AÇIKÇA bildirilir: özet kaç siparişi kapsamıyor ve o siparişlerin cirosu ne?
    vatUnknownOrders: vat.unknownOrders,
    vatUnknownRevenue: vat.unknownRevenue,
    vatPartialOrders: vat.partialOrders,
  };
  const lastOrderSyncAt = lastSnapshotSync?.syncedAt ?? null;
  const firstOrderedAt = [firstSnapshot?.orderedAt, firstManualOrder?.orderedAt]
    .filter((value): value is Date => value != null)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return {
    currency: "TRY",
    timeZone: FINANCE_TIME_ZONE,
    generatedAt: now.toISOString(),
    dataFrom: firstOrderedAt?.toISOString() ?? null,
    lastOrderSyncAt: lastOrderSyncAt?.toISOString() ?? null,
    actualCommissionOrders: actualCommissionCount,
    lastActualCommissionSyncAt: lastCommissionSync?.syncedAt?.toISOString() ?? null,
    totals: { ...totals, vat },
    months,
    quality,
  };
}
