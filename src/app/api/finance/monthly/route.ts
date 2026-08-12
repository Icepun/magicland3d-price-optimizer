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
import { dbEpochMs, parseDbDate } from "@/lib/sqlite-date";

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
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * ⚠️ AYNI AİLEDEN İKİNCİ HATA: TARİH KOLONUNDA TİP KARIŞIKLIĞI (v0.19.142).
 *
 * Sipariş geçmişine iki taraf yazıyor (masaüstünün ham SQL yolu + telefon). Biri epoch-ms
 * TAMSAYI, diğeri ISO METİN yazınca — SQLite'ta tamsayı her zaman metinden küçük sayıldığı
 * için — Prisma'nın `orderedAt >= …` filtresi uyumsuz tipteki satırların TAMAMINI sessizce
 * eledi: 359 siparişin 280'i Raporlar'a hiç girmedi, "geçmiş şu tarihten beri" yanlış tarih
 * gösterdi, hiçbir hata da verilmedi.
 *
 * Bu yüzden buradaki okumalar `dbEpochMs()` ile normalize edilmiş HAM SQL üzerinden yapılır:
 * depolama tipi ne olursa olsun hiçbir satır düşmez. (Normalize ifade indeksi kullanamaz —
 * tam tarama olur; sipariş geçmişi birkaç yüz satır olduğu için maliyeti ihmal edilebilir ve
 * doğruluk önce gelir.) Şema göçü v40 mevcut veriyi tek biçime çeker; buradaki koruma ikinci
 * emniyet kemeridir. Gerekçe ve ölçüm: `src/lib/sqlite-date.ts`,
 * test: `src/lib/mixed-date-storage.test.ts`.
 */
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Ham sorgu tamsayıları sürücüye göre BigInt gelebilir. */
function toInt(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

/** Ham sorgudan gelen nullable tamsayı — "yok" ile "sıfır" karıştırılmaz. */
function toNullableInt(value: unknown): number | null {
  if (value == null) return null;
  const parsed = toInt(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type SnapshotRow = {
  platform: string;
  orderedAt: Date;
  revenueKurus: number;
  profitKurus: number | null;
  profitPartial: boolean;
  statusKind: string;
  currency: string;
  outputVatKurus: number | null;
  inputVatCreditKurus: number | null;
  calculationVersion: number;
};

/** Pencere içindeki (manuel olmayan) sipariş özetleri — tarih tipi ne olursa olsun. */
async function readSnapshots(windowStart: Date): Promise<SnapshotRow[]> {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT "platform","orderedAt","revenueKurus","profitKurus","profitPartial",
            "statusKind","currency","outputVatKurus","inputVatCreditKurus","calculationVersion"
       FROM "OrderFinanceSnapshot"
      WHERE "platform" <> 'manual'
        AND ${dbEpochMs("orderedAt")} >= ?`,
    windowStart.getTime()
  );
  const snapshots: SnapshotRow[] = [];
  for (const row of rows) {
    const orderedAt = parseDbDate(row.orderedAt);
    // Tarihi hiç çözülemeyen satır hiçbir aya düşemez; sessizce yutmak yerine atlanır.
    if (!orderedAt) continue;
    snapshots.push({
      platform: String(row.platform ?? ""),
      orderedAt,
      revenueKurus: toInt(row.revenueKurus),
      profitKurus: toNullableInt(row.profitKurus),
      profitPartial: Boolean(toInt(row.profitPartial)),
      statusKind: String(row.statusKind ?? ""),
      currency: String(row.currency ?? "TRY"),
      outputVatKurus: toNullableInt(row.outputVatKurus),
      inputVatCreditKurus: toNullableInt(row.inputVatCreditKurus),
      calculationVersion: toInt(row.calculationVersion),
    });
  }
  return snapshots;
}

/**
 * "Geçmiş şu tarihten beri" + "son senkron" — TÜM geçmiş üzerinden, normalize edilmiş.
 *
 * Not: buradaki MIN/MAX HAM SQL'dir; yasak olan Prisma'nın `aggregate({_min/_max})` API'si
 * (dosya başındaki uyarı). Ham sonuç sayı olarak döner, Prisma DateTime'a çevirmeye çalışmaz.
 */
async function readSnapshotBounds(): Promise<{
  firstOrderedAt: Date | null;
  lastSyncedAt: Date | null;
}> {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT MIN(${dbEpochMs("orderedAt")}) AS "oldest",
            MAX(${dbEpochMs("syncedAt")})  AS "latest"
       FROM "OrderFinanceSnapshot"
      WHERE "platform" <> 'manual'`
  );
  const row = rows[0] ?? {};
  return {
    firstOrderedAt: parseDbDate(row.oldest),
    lastSyncedAt: parseDbDate(row.latest),
  };
}

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
  // v6: Tarih tipi karışıklığı yüzünden siparişlerin çoğu hiç okunmuyordu; artık hepsi okunuyor.
  // Sürüm artmazsa güncelleme sonrası diskteki ESKİ (eksik) yanıt 30 güne kadar taze sayılır ve
  // kullanıcı düzelmiş rakamı göremezdi.
  //
  // try/catch neden ŞART: bu uç eskiden sarmalanmamıştı ve hata olunca Next GÖVDESİZ bir 500
  // döndürüyordu. Raporlar "veri alınamadı" yazıyor, sebep ise hiçbir yere yazılmıyordu —
  // teşhis için uygulamayı çalışır hâlde tek tek uç yoklamak gerekti. Diğer uçların hepsi
  // `jsonError` kullanıyor; bu da artık kullanıyor.
  try {
    const data = await swr(
      `finance-monthly:v6:${monthCount}`,
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
    snapshotBounds,
    firstManualOrder,
  ] = await Promise.all([
    // Yalnız gösterilen ay aralığı okunur (satır sayısı sabit kalır); dışarıdaki satırlar
    // zaten hiçbir aya düşmüyordu. Tarih karşılaştırması tip-bağımsız (bkz. dosya başı).
    readSnapshots(windowStart),
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
    // `findFirst({ orderBy })` karışık tipli kolonda ÖNCE tüm tamsayıları sıralar → "en eski
    // sipariş" yanlış çıkıyordu (Raporlar 24 May yerine 12 Haz diyordu). Normalize okuma:
    readSnapshotBounds(),
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
  const lastOrderSyncAt = snapshotBounds.lastSyncedAt;
  const firstOrderedAt = [snapshotBounds.firstOrderedAt, firstManualOrder?.orderedAt]
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
