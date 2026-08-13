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
import { readFinanceRecalcReadiness } from "@/lib/finance-recalc-readiness";
import {
  financeRecalcState,
  FinanceRecalcBusyError,
  startFinanceMonthRecalc,
} from "@/lib/order-finance-snapshots";
import { bustFinanceCaches } from "@/lib/cache-busting";
import { swr } from "@/lib/route-cache";
import { dbEpochMs, parseDbDate } from "@/lib/sqlite-date";
import {
  aggregateProductSales,
  parseProductSalesItems,
  productSalesItemsSql,
  type ProductSalesOrder,
} from "@/lib/finance-product-sales";
import {
  parseTrendyolCommissionStats,
  readFinanceSourceHealth,
  trendyolCommissionStatsSql,
} from "@/lib/finance-report-meta";

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
  /** Kalem geçmişini (OrderItemSnapshot) siparişe bağlayan anahtar — ürün bazlı kâr için. */
  externalOrderId: string;
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
    `SELECT "platform","externalOrderId","orderedAt","revenueKurus","profitKurus","profitPartial",
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
      externalOrderId: String(row.externalOrderId ?? ""),
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
  //
  // v7: KDV özeti yanıttan çıkarıldı (arayüzde kart yok), ürün bazlı satış özeti ve gerçek
  // komisyon sayıları eklendi. Anahtar artmazsa diskteki ESKİ gövde 30 güne kadar taze sayılır
  // ve yeni alanlar hiç görünmezdi.
  try {
    const data = await swr(
      `finance-monthly:v7:${monthCount}`,
      60_000,
      () => computeMonthlyFinance(monthCount)
    );
    // Kaynak sağlığı ÖNBELLEĞİN DIŞINDA okunur: 60 saniyelik bayat bir "her şey yolunda"
    // damgası, tam o sırada yanıt vermemiş bir pazaryerini gizlerdi. Okuma diskten/RAM'den
    // yapılır — ne veritabanı ne ağ maliyeti var.
    return NextResponse.json(
      { ...data, sources: readFinanceSourceHealth() },
      { headers: { "Cache-Control": "no-store" } }
    );
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
  let state;
  try {
    state = startFinanceMonthRecalc(month, { onDone: () => bustFinanceCaches() });
  } catch (error) {
    // Başka kapsamda/türde bir tur sürüyorsa onun durumunu bu isteğin sonucu gibi
    // DÖNDÜRMEYİZ: kullanıcı hiç yazılmamış bir turu "bitti" sanardı.
    if (error instanceof FinanceRecalcBusyError) {
      return NextResponse.json(
        { error: error.message, recalc: error.running },
        { status: 409, headers: { "Cache-Control": "no-store" } }
      );
    }
    throw error;
  }
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
    commissionStatRows,
    lastCommissionSync,
    snapshotBounds,
    firstManualOrder,
    itemRows,
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
    // Başlıktaki sayı "indirilen komisyon KAYDI" değil, "gerçek komisyonla HESAPLANMIŞ sipariş"
    // olmalı — ikisi aynı değil (canlı: 193 kayıt, 101 uygulanmış sipariş). Gerekçe ve ölçüm:
    // `src/lib/finance-report-meta.ts`.
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(trendyolCommissionStatsSql()),
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
    // Ürün bazlı satış geçmişi. Aylık pencerenin tamamı okunur (birkaç yüz satır); "en çok
    // satanlar" penceresi bunun içinden ayrılır, ikinci bir sorgu gerekmez.
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      productSalesItemsSql(),
      windowStart.getTime()
    ),
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

  // KDV özeti hesaplanır ama YANITA KONMAZ: Raporlar'da KDV kartı yok (kullanıcı istemedi) ve
  // gönderilen bölüm sayfada bir kez bile okunmuyordu. Kayıtlı `outputVatKurus` /
  // `inputVatCreditKurus` alanları YERİNDE DURUYOR — Siparişler ve dışa aktarma onları kullanıyor.
  const months = aggregateMonthlyFinance({
    snapshots,
    manualOrders,
    expenses,
    monthCount,
    now,
    timeZone: FINANCE_TIME_ZONE,
  }).map((full) => {
    const { vat, ...month } = full;
    void vat; // hesaplanır, yanıta konmaz (bkz. üstteki not)
    return { ...month, outdatedOrders: outdatedByMonth.get(month.month) ?? 0 };
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
  const lastOrderSyncAt = snapshotBounds.lastSyncedAt;
  const firstOrderedAt = [snapshotBounds.firstOrderedAt, firstManualOrder?.orderedAt]
    .filter((value): value is Date => value != null)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  const commission = parseTrendyolCommissionStats(commissionStatRows);

  // ── Ürün bazlı satış özeti ────────────────────────────────────────────────────────────────
  // Manuel siparişin kalem geçmişi tutulmuyor; kâr paylaştırması yalnız pazaryeri siparişleri
  // üzerinden yapılır (aynı satırlar aylık toplamlarda da bu şekilde sayılıyor).
  const salesOrders: ProductSalesOrder[] = snapshots.map((snapshot) => ({
    platform: snapshot.platform,
    externalOrderId: snapshot.externalOrderId,
    orderedAt: snapshot.orderedAt,
    revenueKurus: snapshot.revenueKurus,
    profitKurus: snapshot.profitKurus,
    profitPartial: snapshot.profitPartial,
    statusKind: snapshot.statusKind,
    currency: snapshot.currency,
  }));
  const items = parseProductSalesItems(itemRows);
  const soldProductIds = [
    ...new Set(items.map((item) => item.productId).filter((id): id is string => id != null)),
  ];
  // Ad ve görsel yalnız SATIŞ GÖRMÜŞ ürünler için okunur (canlıda 372 aktif ürünün ~107'si).
  // IN(...) parametre sayısı SQLite'ın 999 sınırına dayanmasın diye dilimlenir; satış hacmi
  // büyüdükçe 12 aylık pencerede bu sayı aşılabilir ve sorgu tümden patlardı.
  const productInfo: Array<{ id: string; name: string; imageUrl: string | null }> = [];
  for (let offset = 0; offset < soldProductIds.length; offset += 500) {
    productInfo.push(
      ...(await prisma.product.findMany({
        where: { id: { in: soldProductIds.slice(offset, offset + 500) } },
        select: { id: true, name: true, imageUrl: true },
      }))
    );
  }
  const products = aggregateProductSales({
    items,
    orders: salesOrders,
    productInfo,
    rangeFrom: windowStart,
    now,
  });

  // Tek sorgu (OrderFinanceSnapshot LEFT JOIN DISTINCT OrderItemSnapshot). Pencere aynı
  // tutulur ki sayfadaki toplam ile ay kartlarındaki sayılar aynı kümeden gelsin.
  const recalcReadiness = await readFinanceRecalcReadiness({
    since: windowStart,
    timeZone: FINANCE_TIME_ZONE,
  });

  return {
    currency: "TRY",
    timeZone: FINANCE_TIME_ZONE,
    generatedAt: now.toISOString(),
    dataFrom: firstOrderedAt?.toISOString() ?? null,
    lastOrderSyncAt: lastOrderSyncAt?.toISOString() ?? null,
    // Eski alan adı korunur ama artık DOĞRU sayıyı taşır: kârı gerçek komisyonla hesaplanmış
    // sipariş sayısı (indirilen kayıt sayısı değil).
    actualCommissionOrders: commission.applied,
    lastActualCommissionSyncAt: lastCommissionSync?.syncedAt?.toISOString() ?? null,
    commission,
    totals,
    months,
    quality,
    products,
    // "Kaç siparişin kârı eski hesaplamayla kayıtlı ve kaçı GERÇEKTEN düzeltilebilir?"
    // Ürün dökümü olmayan sipariş yeniden hesaplanamaz; bu ayrım olmadan sayfa 18 sipariş
    // için düğme gösteriyor ve düğmeye basılınca hiçbir şey değişmiyordu.
    recalcReadiness,
  };
}
