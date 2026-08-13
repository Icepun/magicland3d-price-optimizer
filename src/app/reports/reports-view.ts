/**
 * RAPORLAR — sayfanın SAF görünüm mantığı ve sunucu yanıtının yerel tipleri.
 *
 * Neden ayrı dosya:
 *  1. Sayfa bileşeni React'siz test edilemiyordu; kıyas/rozet/uyarı kuralları burada saf
 *     fonksiyon olarak durur ve `reports-view.test.ts` ile doğrulanır.
 *  2. Yerel tipler GERÇEK yanıta göre yazılır. Daha önce yerel tip "her zaman dolu" dediği
 *     için `tsc` kördü ve alan `null` gelince ekran çöküyordu; bu yüzden sunucunun sonradan
 *     eklediği bloklar (`products`, `commission`, `sources`, `recalcReadiness`) İSTEĞE BAĞLI
 *     tiplenir — eski bir gövde geldiğinde sayfa çökmek yerine o bölümü göstermez.
 */

/* ── Sunucu yanıtı ─────────────────────────────────────────────────────────────────────── */

export interface FinanceBucket {
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
  /** Eski hesapla kayıtlı sipariş sayısı — yeniden hesap uyarısının HAM sayısı. */
  outdatedOrders?: number;
  byPlatform: Record<string, unknown>;
}

export interface FinanceTotals {
  revenue: number;
  orderProfit: number;
  expenses: number;
  netProfit: number;
  orderCount: number;
}

export interface FinanceQuality {
  incompleteOrders: number;
  partialProfitOrders: number;
  missingProfitOrders: number;
  excludedOrders: number;
  unsupportedCurrencyOrders: number;
}

/** Ürün bazlı satış satırı — kâr `null` GELEBİLİR (bilinmiyor), sıfıra çevirme. */
export interface ProductSalesRow {
  productId: string;
  name: string;
  imageUrl: string | null;
  quantity: number;
  revenue: number;
  profit: number | null;
  profitPartial: boolean;
  profitUnknownLines: number;
  orderCount: number;
}

export interface UnmatchedSales {
  lines: number;
  quantity: number;
  revenue: number;
  titles: Array<{ name: string; quantity: number; revenue: number }>;
}

export interface SalesCoverage {
  ordersWithItems: number;
  ordersWithoutItems: number;
  revenueWithoutItems: number;
}

export interface ProductSalesSummary {
  recentDays: number;
  recentFrom: string;
  rangeFrom: string;
  topSellers: ProductSalesRow[];
  profitLeaders: ProductSalesRow[];
  soldUnits: Record<string, number>;
  unmatched: UnmatchedSales;
  recentUnmatched: UnmatchedSales;
  orphanItems?: { lines: number; quantity: number; revenue: number };
  coverage: SalesCoverage;
  recentCoverage: SalesCoverage;
}

export interface CommissionStats {
  records: number;
  orders: number;
  applied: number;
  pending: number;
}

export interface SourceHealth {
  /** null = bilinmiyor (hiç çekim yok ya da damga bayat) → UYARI BASILMAZ. */
  complete: boolean | null;
  missing: string[];
  computedAt: string | null;
}

export interface RecalcReadinessBucket {
  totalOrders: number;
  outdatedOrders: number;
  recalculableOrders: number;
  blockedOrders: number;
  blockedReasons: Partial<Record<string, number>>;
}

export interface RecalcMonthReadiness extends RecalcReadinessBucket {
  month: string;
}

export interface RecalcReadiness extends RecalcReadinessBucket {
  calculationVersion: number;
  months: RecalcMonthReadiness[];
}

/** Teorik kârlılık listesi — `/api/finance/monthly?section=profitability` gövdesi. */
export interface ProfitabilityRow {
  id: string;
  name: string;
  imageUrl: string | null;
  netProfit: number | null;
  profitMargin: number | null;
}

export interface ProductProfitability {
  leaders: ProfitabilityRow[];
  losers: ProfitabilityRow[];
  /** Maliyeti girilmediği için listeye hiç giremeyen ürün sayısı. */
  missingCostProducts: number;
  /** Kârı hesaplanabilen ürün sayısı. */
  countedProducts: number;
}

export interface FinanceResponse {
  currency: "TRY";
  timeZone: string;
  generatedAt: string;
  dataFrom: string | null;
  lastOrderSyncAt: string | null;
  actualCommissionOrders: number;
  lastActualCommissionSyncAt: string | null;
  totals: FinanceTotals;
  months: FinanceBucket[];
  quality: FinanceQuality;
  /** Sunucunun sonradan eklediği bloklar — eski bir gövdede yok olabilir. */
  commission?: CommissionStats;
  products?: ProductSalesSummary;
  sources?: SourceHealth;
  recalcReadiness?: RecalcReadiness;
}

/* ── Geçen ay kıyası ───────────────────────────────────────────────────────────────────── */

export interface StatDelta {
  /** Bu ay − geçen ay. */
  diff: number;
  /** Oransal değişim. Geçen ay 0 ise null: yüzde anlamsız olur, gösterilmez. */
  ratio: number | null;
}

/**
 * İki ayın aynı ölçüsünü kıyasla.
 *
 * BİLİNMEYEN ≠ SIFIR: taraflardan biri yoksa (geçmiş ay hiç yok, değer hesaplanamamış)
 * kıyas ÜRETİLMEZ — eksik veriyi "değişim yok" ya da "%100 artış" diye göstermek yanlış olur.
 */
export function statDelta(
  current: number | null | undefined,
  previous: number | null | undefined
): StatDelta | null {
  if (typeof current !== "number" || !Number.isFinite(current)) return null;
  if (typeof previous !== "number" || !Number.isFinite(previous)) return null;
  const diff = Number((current - previous).toFixed(2));
  // Negatif tabanda oranın İŞARETİ farktan gelmeli: −100 → −150 bir ARTIŞ değil, kötüleşmedir.
  const ratio = previous === 0 ? null : diff / Math.abs(previous);
  return { diff, ratio };
}

export type DeltaTone = "good" | "bad" | "neutral";

/** Artışın rengi ölçüye göre TERS dönebilir: ciro artışı iyi, gider artışı kötüdür. */
export function deltaTone(diff: number, higherIsBetter: boolean): DeltaTone {
  if (!Number.isFinite(diff) || diff === 0) return "neutral";
  return diff > 0 === higherIsBetter ? "good" : "bad";
}

/* ── Ürün rozetleri ────────────────────────────────────────────────────────────────────── */

/** Teorik kârlılık listesindeki satış rozeti. `sold=false` iken rozet gri basılır. */
export interface SoldUnitsBadge {
  text: string;
  sold: boolean;
}

/**
 * Teorik kârlılık listesindeki "satıldı mı?" rozeti.
 *
 * `soldUnits` hiç yoksa (eski gövde) rozet BASILMAZ.
 *
 * ⚠️ BİLİNMEYEN ≠ SIFIR: `soldUnits` yalnız ürün dökümü KAYITLI siparişlerden kurulur.
 * Dökümü olmayan sipariş varsa (canlıda 12 ayda 68 sipariş) o üründen satış yapılmış
 * olabilir — "hiç satılmadı" KESİN iddiası yalan olur. Bu durumda iddiasız metin basılır.
 */
export function soldUnitsBadge(
  soldUnits: Record<string, number> | undefined,
  productId: string,
  ordersWithoutItems = 0
): SoldUnitsBadge | null {
  if (!soldUnits) return null;
  const sold = soldUnits[productId];
  if (sold != null && sold > 0) return { text: `${sold} adet satıldı`, sold: true };
  return ordersWithoutItems > 0
    ? { text: "satış kaydı yok", sold: false }
    : { text: "hiç satılmadı", sold: false };
}

/**
 * "Bu satırın kârı eksik" uyarısı — yoksa null.
 *
 * ⚠️ `profitPartial` TEK BAŞINA yetmez: kârı hiç hesaplanamamış siparişten gelen satışlar
 * ürüne SIFIR kâr katar ve satır tertemiz bir rakam gösterir. Sunucu o satışları
 * `profitUnknownLines` ile ayrıca sayıyor; ikisi de aynı uyarıyı doğurur.
 */
export function profitWarningLabel(row: {
  profitPartial: boolean;
  profitUnknownLines?: number;
}): string | null {
  if (!row.profitPartial && (row.profitUnknownLines ?? 0) <= 0) return null;
  return "Bu ürünün bazı satışlarında kâr hesaplanamadı";
}

/* ── Yeniden hesap ─────────────────────────────────────────────────────────────────────── */

/**
 * Düzeltilemeyen siparişin KISA sebebi.
 *
 * ⚠️ Metin sunucudaki `FINANCE_RECALC_BLOCK_LABELS` ile birebir aynı olmalıdır. O modül
 * `@/lib/prisma`'yı içe aktardığı için istemci paketine giremez; bu yüzden burada bir kopya
 * durur ve `reports-view.test.ts` iki tarafın ayrışmadığını doğrular.
 */
export const RECALC_BLOCK_LABELS: Record<string, string> = {
  "no-item-history": "Ürün geçmişi kayıtlı değil",
};

/**
 * Seçili ayın hazırlık dökümü.
 *
 * ⚠️ `months` dizi OLMAYABİLİR: yerel tip "her zaman dolu" dediği için sayfa bir kez
 * `undefined.find` ile komple çökmüştü. Tip söz veriyor diye gerçeğe güvenilmez.
 */
export function monthReadiness(
  readiness: RecalcReadiness | undefined,
  month: string
): RecalcMonthReadiness | null {
  if (!readiness || !month || !Array.isArray(readiness.months)) return null;
  return readiness.months.find((bucket) => bucket.month === month) ?? null;
}

/** Grafikte GÖRÜNEN ayların yeniden hesap özeti. */
export interface WindowRecalcSummary {
  /**
   * Penceredeki yeniden hesaplanabilir sipariş sayısı. Hazırlık dökümü gelmediyse `null` —
   * "0 sipariş" DEĞİL, "bilinmiyor".
   */
  recalculable: number | null;
  /** Yedek sayı: penceredeki eski hesapla kayıtlı sipariş (döküm gelmediğinde kullanılır). */
  outdated: number;
  /** Penceredeki düzeltilemeyenler — döküm yoksa null. */
  blocked: RecalcReadinessBucket | null;
}

/**
 * Toplam satırı YALNIZ ekranda görünen aylardan kurulur.
 *
 * ⚠️ Sunucunun toplamı tüm geçmişi kapsayabiliyor; "Son 12 ayda N sipariş" derken ay seçiciyi
 * tek tek toplayan kullanıcı bambaşka bir sayı buluyordu. Kapsam neyse cümle onu söyler.
 */
export function windowRecalcSummary(
  readiness: RecalcReadiness | undefined,
  months: Array<{ month: string; outdatedOrders?: number }>
): WindowRecalcSummary {
  const window = Array.isArray(months) ? months : [];
  const outdated = window.reduce((sum, month) => sum + (month.outdatedOrders ?? 0), 0);
  if (!readiness || !Array.isArray(readiness.months)) {
    return { recalculable: null, outdated, blocked: null };
  }
  const keys = new Set(window.map((month) => month.month));
  const blocked: RecalcReadinessBucket = {
    totalOrders: 0,
    outdatedOrders: 0,
    recalculableOrders: 0,
    blockedOrders: 0,
    blockedReasons: {},
  };
  for (const bucket of readiness.months) {
    if (!keys.has(bucket.month)) continue;
    blocked.totalOrders += bucket.totalOrders;
    blocked.outdatedOrders += bucket.outdatedOrders;
    blocked.recalculableOrders += bucket.recalculableOrders;
    blocked.blockedOrders += bucket.blockedOrders;
    for (const [reason, count] of Object.entries(bucket.blockedReasons ?? {})) {
      blocked.blockedReasons[reason] = (blocked.blockedReasons[reason] ?? 0) + (count ?? 0);
    }
  }
  return { recalculable: blocked.recalculableOrders, outdated, blocked };
}

/** "Düzeltilemeyenler" satırı — hiç yoksa null (boş satır basılmaz). */
export function blockedRecalcText(
  bucket: RecalcReadinessBucket | null | undefined
): string | null {
  if (!bucket || bucket.blockedOrders <= 0) return null;
  const reasons = Object.entries(bucket.blockedReasons ?? {})
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([key]) => RECALC_BLOCK_LABELS[key])
    .filter((label): label is string => Boolean(label));
  const suffix = reasons.length > 0 ? ` — ${reasons.join(", ")}` : "";
  return `${bucket.blockedOrders} sipariş düzeltilemiyor${suffix}.`;
}

/* ── Grafik penceresi ──────────────────────────────────────────────────────────────────── */

export type MonthRangeKey = "3" | "6" | "12" | "all";

/**
 * ⚠️ "12 ay" bugün GÖRÜNMEZ: sayfa sunucudan 12 kova istiyor, `visibleRangeOptions` ise
 * seçeneği ancak veri ondan UZUNSA basıyor. Listede kalır ki pencere büyütülürse anlam
 * kazansın; bu yüzden VARSAYILAN seçim "Tümü"dür (bkz. `page.tsx` aralık deposu).
 */
export const MONTH_RANGES: ReadonlyArray<{ key: MonthRangeKey; label: string }> = [
  { key: "3", label: "3 ay" },
  { key: "6", label: "6 ay" },
  { key: "12", label: "12 ay" },
  { key: "all", label: "Tümü" },
];

export function isMonthRangeKey(value: unknown): value is MonthRangeKey {
  return MONTH_RANGES.some((range) => range.key === value);
}

/**
 * Aralık düğmelerinden GÖSTERİLECEK olanlar.
 *
 * ⚠️ Aynı sonucu veren düğme basmayız: iş 4 ay önce başladıysa "6 ay", "12 ay" ve "Tümü"
 * birebir aynı grafiği çizer; üç ölü düğme kullanıcıya seçenek varmış gibi görünür.
 * Tek seçenek kalıyorsa grup hiç basılmaz (boş liste).
 */
export function visibleRangeOptions(
  monthCount: number
): ReadonlyArray<{ key: MonthRangeKey; label: string }> {
  const shown = MONTH_RANGES.filter(
    (range) => range.key === "all" || Number(range.key) < monthCount
  );
  return shown.length > 1 ? shown : [];
}

/** Bir tarihin verilen saat dilimindeki "YYYY-MM" anahtarı. Çözülemezse null. */
export function monthKeyOf(
  value: string | null | undefined,
  timeZone: string
): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = zonedParts(date.getTime(), timeZone);
  return parts ? `${parts.year}-${String(parts.month).padStart(2, "0")}` : null;
}

/** Kovada gösterilecek bir şey var mı? (Alan yoksa "yok" sayılır.) */
export interface MonthBucketLike {
  month: string;
  revenue?: number;
  expenses?: number;
  orderCount?: number;
  orderProfit?: number;
}

function bucketHasData(bucket: MonthBucketLike): boolean {
  return (
    (bucket.revenue ?? 0) !== 0 ||
    (bucket.expenses ?? 0) !== 0 ||
    (bucket.orderCount ?? 0) !== 0 ||
    (bucket.orderProfit ?? 0) !== 0
  );
}

/**
 * İlk veri ayından ÖNCEKİ boş aylar atılır.
 *
 * Sunucu her zaman 12 kova döndürür; iş 4 ay önce başladıysa bunun 8'i sıfır çubukla durur ve
 * gerçek aylar grafiğin sağ ucuna sıkışır.
 *
 * ⚠️ KESME NOKTASI İKİ ADAYIN ERKEN OLANI. `dataFrom` yalnız SİPARİŞ tarihlerinden kurulur;
 * gider ödemeleri o hesaba girmez. İlk siparişten önceki bir ayda ödenmiş gider varsa o ay
 * zarar çubuğuyla dolu olmasına rağmen tek başına `dataFrom`a bakılınca sessizce kesilirdi —
 * grafik ile kartlar birbiriyle çelişirdi.
 */
export function monthsWithData<T extends MonthBucketLike>(
  months: T[] | undefined,
  dataFrom: string | null | undefined,
  timeZone: string
): T[] {
  const list = Array.isArray(months) ? months : [];
  const first = monthKeyOf(dataFrom, timeZone);
  const adaylar = [
    first ? list.findIndex((bucket) => bucket.month >= first) : -1,
    list.findIndex(bucketHasData),
  ].filter((index) => index >= 0);
  if (adaylar.length === 0) return list;
  const index = Math.min(...adaylar);
  return index > 0 ? list.slice(index) : list;
}

/** Grafikte çizilecek aylar: veri başlangıcından itibaren, seçili aralık kadar SON ay. */
export function chartMonths<T extends MonthBucketLike>(
  months: T[] | undefined,
  dataFrom: string | null | undefined,
  range: MonthRangeKey,
  timeZone: string
): T[] {
  const withData = monthsWithData(months, dataFrom, timeZone);
  if (range === "all") return withData;
  const count = Number(range);
  if (!Number.isFinite(count) || count <= 0) return withData;
  return withData.length > count ? withData.slice(-count) : withData;
}

/**
 * Aralık daraltılmışsa grafiğin altındaki KAPSAM cümlesi; tamamı çiziliyorsa null.
 *
 * ⚠️ Kapsam neyse cümle onu söyler. "Grafik {ilk veri tarihi} tarihinden bu yana çiziliyor"
 * cümlesi seçili aralıktan habersiz basılınca, "3 ay"a geçen kullanıcıya ekrandan kalkmış
 * ayın hiç satışı olmadığını söylemiş oluyordu.
 */
export function chartScopeText(shownMonths: number, totalMonths: number): string | null {
  if (shownMonths <= 0 || shownMonths >= totalMonths) return null;
  return `Grafikte son ${shownMonths} ay var — tamamı için Tümü'ne bas.`;
}

/* ── Devam eden ay ─────────────────────────────────────────────────────────────────────── */

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** Bir anın verilen saat dilimindeki yıl/ay/gün/saat/dakika değerleri. */
function zonedParts(timestamp: number, timeZone: string): ZonedParts | null {
  if (!Number.isFinite(timestamp)) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(timestamp));
  } catch {
    // Tanınmayan saat dilimi → tarih uydurmaktansa hiçbir şey iddia etme.
    return null;
  }
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  const hour = pick("hour");
  const minute = pick("minute");
  return {
    year,
    month,
    day,
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0,
  };
}

export interface MonthProgress {
  /** Bu ay HENÜZ SÜRÜYOR mu (takvimde içinde bulunulan ay). */
  ongoing: boolean;
  /** Ayın kaçıncı günündeyiz — bitmiş ayda ayın tamamı. Etiket ("1–13 Ağustos") bunu kullanır. */
  elapsedDays: number;
  /**
   * GERÇEKTEN geçen süre, gün cinsinden kesirli (ayın 2'sinde saat 00:30 → 1,02).
   *
   * ⚠️ Tahminin böleni budur, `elapsedDays` DEĞİL: başlamış günü tam gün saymak günlük
   * ortalamayı ayın başında neredeyse yarıya indiriyor, tahmini sistemli olarak düşük
   * gösteriyordu.
   */
  elapsed: number;
  /** Ayın toplam gün sayısı. */
  totalDays: number;
}

/**
 * Bir ayın ne kadarının geçtiği.
 *
 * ⚠️ Ay sınırı `Europe/Istanbul` (finans saat dilimi) — sunucunun ay kovalarıyla aynı sınır.
 */
export function monthProgress(
  month: string,
  nowMs: number,
  timeZone: string
): MonthProgress | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month ?? "");
  if (!match) return null;
  const year = Number(match[1]);
  const monthNo = Number(match[2]);
  if (monthNo < 1 || monthNo > 12) return null;
  const totalDays = new Date(Date.UTC(year, monthNo, 0)).getUTCDate();
  const now = zonedParts(nowMs, timeZone);
  if (!now) {
    return { ongoing: false, elapsedDays: totalDays, elapsed: totalDays, totalDays };
  }
  const ongoing = now.year === year && now.month === monthNo;
  if (!ongoing) {
    return { ongoing: false, elapsedDays: totalDays, elapsed: totalDays, totalDays };
  }
  const elapsedDays = Math.min(Math.max(now.day, 1), totalDays);
  const gununKesri = (now.hour * 60 + now.minute) / 1440;
  return {
    ongoing: true,
    elapsedDays,
    elapsed: Math.min(elapsedDays - 1 + gununKesri, totalDays),
    totalDays,
  };
}

/**
 * Ay sonu tahmini: günlük ortalama × ayın gün sayısı.
 *
 * ⚠️ Ayın İLK GÜNLERİNDE tahmin ÜRETİLMEZ: bir-iki günlük satıştan ay çıkarmak saçma bir
 * rakam verir. Bitmiş ayda da üretilmez — orada tahmine gerek yok, gerçek rakam var.
 * Değer SIFIRKEN de üretilmez: henüz hiç hareket yokken "ay sıfırla kapanacak" demek olurdu.
 */
export function monthProjection(
  value: number | null | undefined,
  progress: MonthProgress | null
): number | null {
  if (!progress || !progress.ongoing) return null;
  if (progress.totalDays <= 0) return null;
  if (progress.elapsed < 3) return null;
  if (progress.elapsedDays >= progress.totalDays) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0) return null;
  return (value / progress.elapsed) * progress.totalDays;
}

const AY_ADLARI = [
  "Ocak",
  "Şubat",
  "Mart",
  "Nisan",
  "Mayıs",
  "Haziran",
  "Temmuz",
  "Ağustos",
  "Eylül",
  "Ekim",
  "Kasım",
  "Aralık",
];

/**
 * Kartın dönem etiketi: süren ayda "1–13 Ağustos", bitmiş ayda "Temmuz".
 *
 * NEDEN: 13 günlük ay ile 31 günlük ay aynı etiketle ("bu ay") gösterilince kıyas yanlış
 * okunuyordu.
 */
export function monthPeriodLabel(
  month: string,
  progress: MonthProgress | null
): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month ?? "");
  if (!match) return null;
  const name = AY_ADLARI[Number(match[2]) - 1];
  if (!name) return null;
  if (progress?.ongoing && progress.elapsedDays < progress.totalDays) {
    return progress.elapsedDays <= 1 ? `1 ${name}` : `1–${progress.elapsedDays} ${name}`;
  }
  return name;
}

/* ── Tazelik satırı ────────────────────────────────────────────────────────────────────── */

/** Sade Türkçe bağıl süre — "12 dakika önce", "3 saat önce", "dün". */
export function relativeAge(diffMs: number): string {
  const safe = Number.isFinite(diffMs) ? Math.max(0, diffMs) : 0;
  const minutes = Math.round(safe / 60_000);
  if (minutes < 1) return "az önce";
  if (minutes < 60) return `${minutes} dakika önce`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} saat önce`;
  const days = Math.round(hours / 24);
  return days === 1 ? "dün" : `${days} gün önce`;
}

export interface FreshnessLine {
  text: string;
  /** Rakam gözle görülür ölçüde eskiyse (1 saatten fazla) satır hafifçe vurgulanır. */
  stale: boolean;
}

/**
 * "Rakamlar ne zamanki?" satırı.
 *
 * Önbellek katmanları bilerek biraz eski rakam döndürebiliyor; ekranda tarih olmadan kullanıcı
 * gördüğü sayının ne kadar taze olduğunu bilemiyordu.
 */
export function freshnessLine(
  generatedAt: string | null | undefined,
  lastOrderSyncAt: string | null | undefined,
  nowMs: number
): FreshnessLine | null {
  const generated = generatedAt ? new Date(generatedAt).getTime() : Number.NaN;
  if (!Number.isFinite(generated)) return null;
  const age = nowMs - generated;
  const parts = [`Rakamlar ${relativeAge(age)} güncellendi`];
  const synced = lastOrderSyncAt ? new Date(lastOrderSyncAt).getTime() : Number.NaN;
  if (Number.isFinite(synced)) {
    parts.push(`son siparişler ${relativeAge(nowMs - synced)} alındı`);
  }
  return { text: `${parts.join(" · ")}.`, stale: age > 60 * 60_000 };
}
