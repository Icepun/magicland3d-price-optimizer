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

/** Maliyeti girilmediği için kârlılık listesine hiç giremeyen ürün sayısı. */
export function missingCostCount(products: Array<{ hasCost: boolean }>): number {
  return products.reduce((count, product) => (product.hasCost ? count : count + 1), 0);
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
