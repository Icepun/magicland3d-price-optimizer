export const FINANCE_TIME_ZONE = "Europe/Istanbul";
// Tek kaynak çekirdekte — mobil de aynı sabiti kullanır (sürüm damgası sürüklenmesin).
export { FINANCE_CALCULATION_VERSION } from "@/core/finance-version";

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
  /**
   * Satıştan doğan (hesaplanan) KDV — kuruş.
   * null/undefined = bu sipariş için KDV ayrıştırılmış DEĞİL. Sıfır ile karıştırılmaz:
   * bilinmeyen siparişler toplama girmez, ayrıca "kapsam dışı" olarak sayılır.
   */
  outputVatKurus?: number | null;
  /** Girdilerden indirilecek KDV — kuruş. Yalnız outputVatKurus biliniyorsa anlamlıdır. */
  inputVatCreditKurus?: number | null;
};

type ManualOrderFinanceInput = {
  orderedAt: Date;
  revenueKurus: number;
  profitKurus: number | null;
  profitPartial: boolean;
  statusKind: string;
  currency: string;
  /**
   * Manuel siparişin KDV hariç cirosu (kayıtlı alan). Hesaplanan KDV bu iki kayıtlı
   * alanın farkıdır — motorun kendi çıktısıdır, burada yeni bir KDV formülü kurulmaz.
   */
  netRevenueKurus?: number | null;
  /** Manuel siparişin kayıtlı indirilecek KDV tutarı (motor çıktısı). */
  inputVatCreditKurus?: number | null;
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
  outputVatKurus: number;
  inputVatCreditKurus: number;
  vatKnownOrders: number;
  vatPartialOrders: number;
  vatUnknownOrders: number;
  vatUnknownRevenueKurus: number;
  byPlatform: Record<string, PlatformKurus>;
};

/**
 * Ayın KDV özeti. Rakamlar sipariş motorunun KENDİ çıktısından toplanır; burada
 * hiçbir KDV oranı uygulanmaz, hiçbir tutar yeniden hesaplanmaz.
 */
export interface MonthlyVatSummary {
  /** Satıştan doğan (hesaplanan) KDV. */
  outputVat: number;
  /** Girdilerden indirilecek KDV. */
  inputVatCredit: number;
  /** Fark. Eksi değer "sonraki aya devreden" demektir. */
  payable: number;
  /** KDV'si bilinen sipariş sayısı. */
  knownOrders: number;
  /** KDV'si bilinen ama maliyeti eksik olan sipariş sayısı (indirilecek KDV eksik kalmış olabilir). */
  partialOrders: number;
  /** Ciroya giren ama KDV'si ayrıştırılmamış sipariş sayısı. */
  unknownOrders: number;
  /** O siparişlerin cirosu — "ne kadarı bilinmiyor" sorusunun dürüst yanıtı. */
  unknownRevenue: number;
}

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
  vat: MonthlyVatSummary;
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

/** Bir anın, verilen saat diliminde UTC'ye göre kaç ms ileride/geride olduğu. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const pick = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    pick("year"),
    pick("month") - 1,
    pick("day"),
    pick("hour"),
    pick("minute"),
    pick("second")
  );
  return asUtc - instant.getTime();
}

/**
 * İstenen ay penceresinin ilk anı (UTC karşılığı).
 *
 * NEDEN: aylık finans sorgusu tarih sınırı olmadan TÜM geçmişi çekiyordu; oysa pencere
 * dışındaki satırlar zaten hiçbir aya düşmeden eleniyor. Sorguyu bu ana göre daraltmak
 * hiçbir rakamı değiştirmez, yalnız okunan satır sayısını sabitler.
 */
export function monthlyFinanceWindowStart(
  monthCount: number,
  now = new Date(),
  timeZone = FINANCE_TIME_ZONE
): Date {
  const [year, month] = recentMonthKeys(monthCount, now, timeZone)[0]
    .split("-")
    .map(Number);
  const naive = Date.UTC(year, month - 1, 1, 0, 0, 0);
  // İki adımda yakınsa: ilk tahminin bölge kayması ölçülür, düzeltilir ve doğrulanır.
  // (Yaz saati geçişi ayın ilk gününe denk gelse bile doğru sonuç verir.)
  let instant = naive;
  for (let pass = 0; pass < 2; pass++) {
    instant = naive - zoneOffsetMs(new Date(instant), timeZone);
  }
  return new Date(instant);
}

export function aggregateMonthlyFinance({
  snapshots,
  manualOrders = [],
  expenses,
  monthCount,
  now = new Date(),
  timeZone = FINANCE_TIME_ZONE,
}: {
  snapshots: SnapshotInput[];
  manualOrders?: ManualOrderFinanceInput[];
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
        outputVatKurus: 0,
        inputVatCreditKurus: 0,
        vatKnownOrders: 0,
        vatPartialOrders: 0,
        vatUnknownOrders: 0,
        vatUnknownRevenueKurus: 0,
        byPlatform: {
          shopify: { revenueKurus: 0, orderProfitKurus: 0, orderCount: 0 },
          trendyol: { revenueKurus: 0, orderProfitKurus: 0, orderCount: 0 },
          hepsiburada: { revenueKurus: 0, orderProfitKurus: 0, orderCount: 0 },
          manual: { revenueKurus: 0, orderProfitKurus: 0, orderCount: 0 },
        },
      },
    ])
  );

  const addOrder = (snapshot: SnapshotInput) => {
    const bucket = months.get(monthKey(snapshot.orderedAt, timeZone));
    if (!bucket) return;
    if (snapshot.statusKind === "cancelled") {
      bucket.excludedOrders++;
      return;
    }
    if ((snapshot.currency || "TRY").trim().toUpperCase() !== "TRY") {
      bucket.excludedOrders++;
      bucket.unsupportedCurrencyOrders++;
      return;
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

    // KDV yalnız ciroya GİREN siparişlerden toplanır (iptal ve yabancı para yukarıda elendi).
    // Ayrıştırılmamış siparişin KDV'si SIFIR sayılmaz; "bilinmeyen" olarak ayrı sayılır ki
    // arayüz özetin ne kadarını kapsamadığını dürüstçe söyleyebilsin.
    if (snapshot.outputVatKurus == null) {
      bucket.vatUnknownOrders++;
      bucket.vatUnknownRevenueKurus += snapshot.revenueKurus;
    } else {
      bucket.outputVatKurus += snapshot.outputVatKurus;
      bucket.inputVatCreditKurus += snapshot.inputVatCreditKurus ?? 0;
      bucket.vatKnownOrders++;
      // Maliyeti eksik siparişte indirilecek KDV de eksik kalır → kullanıcı uyarılmalı.
      if (snapshot.profitPartial || snapshot.profitKurus == null) bucket.vatPartialOrders++;
    }

    const platform = (bucket.byPlatform[snapshot.platform] ??= {
      revenueKurus: 0,
      orderProfitKurus: 0,
      orderCount: 0,
    });
    platform.revenueKurus += snapshot.revenueKurus;
    platform.orderProfitKurus += snapshot.profitKurus ?? 0;
    platform.orderCount++;
  };

  for (const snapshot of snapshots) {
    // ManualOrder kendi kalıcı finans kaynağıdır; eski/yanlışlıkla üretilmiş manual
    // snapshot satırı varsa bile burada ikinci kez sayılmaz.
    if (snapshot.platform === "manual") continue;
    addOrder(snapshot);
  }
  for (const order of manualOrders) {
    // Hesaplanan KDV = kayıtlı brüt ciro − kayıtlı KDV hariç ciro. Bu, manuel sipariş
    // motorunun (calculateManualOrder) ürettiği `outputVat` değerinin ta kendisidir;
    // burada yeni bir oran uygulanmaz.
    addOrder({
      ...order,
      platform: "manual",
      outputVatKurus:
        order.netRevenueKurus == null ? null : order.revenueKurus - order.netRevenueKurus,
      inputVatCreditKurus: order.inputVatCreditKurus ?? null,
    });
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
      vat: {
        outputVat: kurusToTl(bucket.outputVatKurus),
        inputVatCredit: kurusToTl(bucket.inputVatCreditKurus),
        payable: kurusToTl(bucket.outputVatKurus - bucket.inputVatCreditKurus),
        knownOrders: bucket.vatKnownOrders,
        partialOrders: bucket.vatPartialOrders,
        unknownOrders: bucket.vatUnknownOrders,
        unknownRevenue: kurusToTl(bucket.vatUnknownRevenueKurus),
      },
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

/**
 * Geçen ayın, ŞU ANA karşılık gelen anı (finans saat diliminde aynı gün ve saat). Geçen ay daha
 * kısaysa son gününe kırpılır (31 Mart → 28/29 Şubat aynı saat).
 *
 * NEDEN: Raporlar kartları süren ayı geçen ayın TAMAMIYLA kıyaslıyordu — 9 günlük Ekim cirosu
 * 30 günlük Eylül'e göre "-%55" kırmızı görünüyordu (9 Eki 2026 denetimi).
 */
export function previousMonthSameMoment(now = new Date(), timeZone = FINANCE_TIME_ZONE): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const zeroBased = pick("year") * 12 + (pick("month") - 1) - 1;
  const year = Math.floor(zeroBased / 12);
  const month = zeroBased % 12; // 0-11
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const naive = Date.UTC(year, month, Math.min(pick("day"), lastDay), pick("hour"), pick("minute"), pick("second"));
  let instant = naive;
  for (let pass = 0; pass < 2; pass++) {
    instant = naive - zoneOffsetMs(new Date(instant), timeZone);
  }
  return new Date(instant);
}

/**
 * Geçen ayın BUGÜNE KADARKİ kısmı — aylık toplamla AYNI kurallarla (aynı fonksiyon, yalnız girdi
 * geçen ayın aynı anına kadar süzülür). Bitmiş ayla kıyas için değil, SÜREN ay için.
 */
export function previousMonthToDate({
  snapshots,
  manualOrders = [],
  expenses,
  now = new Date(),
  timeZone = FINANCE_TIME_ZONE,
}: {
  snapshots: SnapshotInput[];
  manualOrders?: ManualOrderFinanceInput[];
  expenses: ExpenseInput[];
  now?: Date;
  timeZone?: string;
}): { item: MonthlyFinanceItem; until: Date } | null {
  const until = previousMonthSameMoment(now, timeZone);
  const key = monthKey(until, timeZone);
  const months = aggregateMonthlyFinance({
    snapshots: snapshots.filter((row) => row.orderedAt.getTime() < until.getTime()),
    manualOrders: manualOrders.filter((row) => row.orderedAt.getTime() < until.getTime()),
    expenses: expenses.filter((row) => row.paidAt.getTime() < until.getTime()),
    monthCount: 2,
    now,
    timeZone,
  });
  const item = months.find((month) => month.month === key);
  return item ? { item, until } : null;
}

export interface WeeklyFinanceItem {
  /** Haftanın pazartesisi (finans saat diliminde), "2026-10-05". */
  week: string;
  /** "5–11 Eki". */
  label: string;
  revenue: number;
  orderProfit: number;
  expenses: number;
  netProfit: number;
  orderCount: number;
  ongoing: boolean;
}

const GUN_MS = 86_400_000;

function localDayNaive(value: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(pick("year"), pick("month") - 1, pick("day"));
}

/** Yerel takvimde o günün bulunduğu haftanın pazartesisi (UTC-naive gün, ms). */
function weekStartNaive(value: Date, timeZone: string): number {
  const day = localDayNaive(value, timeZone);
  return day - ((new Date(day).getUTCDay() + 6) % 7) * GUN_MS;
}

/**
 * HAFTALIK görünüm — Raporlar'da ayın ilk günlerinde aylık grafik neredeyse boş kalıyordu.
 * Satır kuralları aylık toplamla AYNI: iptal ve TRY dışı sipariş ciroya girmez, manuel sipariş
 * kendi tablosundan bir kez sayılır, gider ödendiği haftaya düşer.
 */
export function aggregateWeeklyFinance({
  snapshots,
  manualOrders = [],
  expenses,
  weekCount,
  now = new Date(),
  timeZone = FINANCE_TIME_ZONE,
}: {
  snapshots: SnapshotInput[];
  manualOrders?: ManualOrderFinanceInput[];
  expenses: ExpenseInput[];
  weekCount: number;
  now?: Date;
  timeZone?: string;
}): WeeklyFinanceItem[] {
  const count = Math.max(1, Math.min(26, Math.trunc(weekCount)));
  const current = weekStartNaive(now, timeZone);
  const starts = Array.from({ length: count }, (_, i) => current - (count - 1 - i) * 7 * GUN_MS);
  const buckets = new Map(
    starts.map((start) => [start, { revenueKurus: 0, orderProfitKurus: 0, expensesKurus: 0, orderCount: 0 }])
  );
  const gunFmt = new Intl.DateTimeFormat("tr-TR", { timeZone: "UTC", day: "numeric", month: "short" });
  const addOrder = (row: { orderedAt: Date; revenueKurus: number; profitKurus: number | null; statusKind: string; currency: string | null }) => {
    const bucket = buckets.get(weekStartNaive(row.orderedAt, timeZone));
    if (!bucket) return;
    if (row.statusKind === "cancelled") return;
    if ((row.currency || "TRY").trim().toUpperCase() !== "TRY") return;
    bucket.revenueKurus += row.revenueKurus;
    bucket.orderProfitKurus += row.profitKurus ?? 0;
    bucket.orderCount++;
  };
  for (const snapshot of snapshots) {
    if (snapshot.platform === "manual") continue;
    addOrder(snapshot);
  }
  for (const order of manualOrders) addOrder(order);
  for (const expense of expenses) {
    const bucket = buckets.get(weekStartNaive(expense.paidAt, timeZone));
    if (bucket) bucket.expensesKurus += expense.amountKurus;
  }
  return starts.map((start) => {
    const b = buckets.get(start)!;
    const bas = new Date(start);
    const son = new Date(start + 6 * GUN_MS);
    const ayniAy = bas.getUTCMonth() === son.getUTCMonth();
    return {
      week: bas.toISOString().slice(0, 10),
      label: ayniAy
        ? `${bas.getUTCDate()}–${gunFmt.format(son)}`
        : `${gunFmt.format(bas)} – ${gunFmt.format(son)}`,
      revenue: kurusToTl(b.revenueKurus),
      orderProfit: kurusToTl(b.orderProfitKurus),
      expenses: kurusToTl(b.expensesKurus),
      netProfit: kurusToTl(b.orderProfitKurus - b.expensesKurus),
      orderCount: b.orderCount,
      ongoing: start === current,
    };
  });
}
