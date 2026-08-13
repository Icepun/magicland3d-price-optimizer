"use client";
/* eslint-disable @next/next/no-img-element */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  ResponsiveContainer,
  Cell,
  Legend,
  ReferenceLine,
} from "recharts";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  CalendarRange,
  Coins,
  Package,
  Receipt,
  RefreshCw,
  ShoppingCart,
  TrendingDown,
  TrendingUp,
  Trophy,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatCompactCurrency, formatCurrency, formatNumber, formatPercent } from "@/lib/format";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { usePageHidden, usePrefersReducedMotion } from "@/lib/client-state";
import { thumbUrl } from "@/lib/image";
import { fetchJson } from "@/lib/fetch-json";
import { toast } from "sonner";
import {
  blockedRecalcText,
  chartMonths,
  chartScopeText,
  deltaTone,
  freshnessLine,
  isMonthRangeKey,
  monthKeyOf,
  monthPeriodLabel,
  monthProgress,
  monthProjection,
  monthReadiness,
  monthsWithData,
  profitWarningLabel,
  soldUnitsBadge,
  statDelta,
  visibleRangeOptions,
  windowRecalcSummary,
  type FinanceResponse,
  type MonthRangeKey,
  type ProductProfitability,
  type ProductSalesRow,
  type ProfitabilityRow,
} from "./reports-view";

interface SummaryBucket {
  revenue: number;
  profit: number;
  orderCount: number;
}

interface OrdersResp {
  orders: {
    platform: "shopify" | "trendyol" | "hepsiburada" | "manual";
    statusKind: string;
    items: { name: string; quantity: number; image?: string | null }[];
    total: number;
  }[];
  /** Son çekimde HER kaynak yanıt verdi mi. Eski bir gövdede yok olabilir. */
  dataComplete?: boolean;
  summary: {
    days: number;
    shopify: SummaryBucket;
    trendyol: SummaryBucket;
    hepsiburada: SummaryBucket;
    manual?: SummaryBucket;
    total: SummaryBucket;
    quality?: { missingSources?: string[] };
  };
  financeHistory?: {
    ok: boolean;
    syncedOrders: number;
    syncDays: number;
    /** Finans geçmişi yazımı şu an arka planda sürüyor mu. */
    pending?: boolean;
    error?: string;
  };
}

/**
 * Sipariş yanıtının damgası MODÜL düzeyinde tutulur.
 *
 * Sayfadan çıkıp geri girmek bileşeni yeniden kurar; damga bileşenle birlikte sıfırlanınca
 * her girişte önbellekteki AYNI yanıt "yeni" sanılıyor ve boşuna bir finans isteği daha
 * atılıyordu (uzak veritabanında her sorgu ~96 ms ve sıralı).
 */
let sonSiparisDamgasi = 0;

/**
 * Grafik aralığı seçimi OTURUM BOYUNCA hatırlanır: kullanıcı "3 ay"a geçip başka bir ekrana
 * gidip döndüğünde seçimi duruyor olmalı. `sessionStorage` uygulama yeniden yüklense de tutar.
 *
 * Seçim React'in harici-store sözleşmesiyle okunur: sunucu çizimi her zaman varsayılanı görür,
 * kayıtlı değer istemciye geçilince uygulanır — böylece iki çizim ayrışmaz.
 */
const RANGE_STORAGE_KEY = "mlhub.reports.range";
const aralikDinleyiciler = new Set<() => void>();
let hatirlananAralik: MonthRangeKey | null = null;

function aralikAbone(onChange: () => void): () => void {
  aralikDinleyiciler.add(onChange);
  return () => {
    aralikDinleyiciler.delete(onChange);
  };
}

function aralikSnapshot(): MonthRangeKey {
  if (hatirlananAralik == null) {
    let saved: string | null = null;
    try {
      saved = window.sessionStorage.getItem(RANGE_STORAGE_KEY);
    } catch {
      // Depolama kapalı olabilir → varsayılan aralık kullanılır.
    }
    // Varsayılan "Tümü": 12 aylık pencerede "12 ay" düğmesi hiç görünmediği için varsayılan
    // olarak yazılması sessizce "Tümü"ye düşen ölü bir seçim demekti.
    hatirlananAralik = isMonthRangeKey(saved) ? saved : "all";
  }
  return hatirlananAralik;
}

const aralikSunucuSnapshot = (): MonthRangeKey => "all";

function aralikYaz(next: MonthRangeKey): void {
  hatirlananAralik = next;
  try {
    window.sessionStorage.setItem(RANGE_STORAGE_KEY, next);
  } catch {
    // Depolama kapalı → seçim yine de bu oturum boyunca bellekte durur.
  }
  for (const listener of aralikDinleyiciler) listener();
}

/** Yeniden hesap turunun anlık durumu. */
interface RecalcState {
  month: string;
  phase: "reading" | "calculating" | "writing" | "done" | "error";
  processed: number;
  total: number;
  startedAt: string;
  finishedAt: string | null;
  result: {
    month: string;
    totalOrders: number;
    recalculatedOrders: number;
    skippedOrders: number;
    changedOrders: number;
    profitDeltaKurus: number;
  } | null;
  error: string | null;
}

const RECALC_ACTIVE_PHASES = new Set(["reading", "calculating", "writing"]);

/** İlerleme yüzdesi: okuma/hesap/yazma aşamaları tek bir dolan çubuğa oturtulur. */
function recalcPercent(state: RecalcState | null): number {
  if (!state) return 0;
  if (state.phase === "done") return 100;
  if (state.phase === "error") return 100;
  if (state.phase === "writing") return 94;
  if (state.phase === "calculating") {
    const ratio = state.total > 0 ? state.processed / state.total : 0;
    return 14 + Math.min(1, ratio) * 78;
  }
  return 8;
}

interface TrendyolCommissionSyncResponse {
  fetchedTransactions: number;
  storedOrders: number;
  skippedTransactions: number;
  days: number;
  syncedAt: string;
}

/**
 * "En çok satanlar" çubukları sıfırdan dolar; kademeli giriş SATIRIN kendi soluk geçişinden
 * gelir, çubuğun genişliğinden değil.
 *
 * ⚠️ `animation-delay` ve `fill-mode` VERİLMEZ. Gerekçe ÖLÇÜLDÜ (gizli pencerede,
 * `getComputedStyle` ile): pencere gizliyken CSS animasyon saati 0'da duruyor ve çubuk
 * fill-mode olsun olmasın 0 genişlikte hesaplanıyor — yani fill-mode'un koruyuculuğu YOK.
 * Pencere öne gelince saat baştan işliyor ve çubuk doğru genişliğe büyüyor, dolayısıyla
 * kullanıcı hiçbir zaman sıfır çubuk görmüyor. Gecikme ve fill-mode yine de yazılmaz: satır
 * zaten kademeli giriyor, çubuğu ikinci kez geciktirmenin bir karşılığı yok.
 *
 * `transition` arka plan tazelemesi içindir: adetler değişince React aynı ögeyi yeniden
 * kullanır, mount animasyonu tekrar çalışmaz ve çubuk yeni genişliğine ZIPLARDI.
 */
const BAR_GROW_CSS = `
@keyframes ml-bar-grow { from { width: 0 } }
.ml-bar {
  animation: ml-bar-grow 700ms cubic-bezier(0.16, 1, 0.3, 1);
  transition: width 500ms cubic-bezier(0.16, 1, 0.3, 1);
}
@media (prefers-reduced-motion: reduce) {
  .ml-bar { animation: none; transition: none }
}
`;

/**
 * Listelerdeki tıklanabilir satırın ortak odak/hover geri bildirimi.
 *
 * ⚠️ `outline-hidden`, `outline-none` DEĞİL: Tailwind v4'te ikincisi outline'ı tümden
 * kaldırıyor ve Yüksek Kontrast kipinde halka (box-shadow) çizilmediği için odak GÖRÜNMEZ
 * oluyordu. Kaydırma rengi kart zeminidir — bu satırların hepsi bir kartın içinde durur.
 */
const ROW_FOCUS =
  "outline-hidden focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-1 focus-visible:ring-offset-card";

function MiniThumb({
  src,
  size = "h-6 w-6",
}: {
  src: string | null | undefined;
  size?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-md border bg-muted/40 overflow-hidden shrink-0",
        size
      )}
    >
      {src ? (
        <img
          src={thumbUrl(src) ?? undefined}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <Package className="h-3 w-3 text-muted-foreground/40" />
      )}
    </span>
  );
}

const PRIMARY = "oklch(0.62 0.20 278)";
const PROFIT = "oklch(0.68 0.17 145)";
const LOSS = "oklch(0.63 0.22 25)";

/** Özet kartları: kuruş göstermeye gerek yok, ondalıksız daha okunaklı. */
const fmtK = (value: number) => formatCurrency(value, { decimals: 0 });
const fmtCount = (value: number) => formatNumber(Math.round(value));

function formatHistoryDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("tr-TR", {
        timeZone: "Europe/Istanbul",
        day: "2-digit",
        month: "long",
        year: "numeric",
      }).format(date);
}

const TOOLTIP_STYLE = {
  background: "oklch(0.2 0.02 278)",
  border: "1px solid oklch(1 0 0 / 12%)",
  borderRadius: 8,
  fontSize: 12,
  color: "oklch(0.95 0 0)",
} as const;

export default function ReportsPage() {
  const queryClient = useQueryClient();
  const reduceMotion = usePrefersReducedMotion();
  /**
   * Grafik çubukları gizli pencerede animasyonsuz çizilir.
   *
   * Recharts çubuğu `requestAnimationFrame` ile 0'dan büyütüyor; pencere arka plandayken o
   * kare hiç gelmiyor ve çubuklar sıfır yükseklikte kalıyor. Sayaçlarda aynı sınıf hata bu
   * projede ÖLÇÜLDÜ ve KALICI çıkmıştı (bkz. `AnimatedNumber`), bu yüzden aynı korumayı
   * grafiğe de takıyoruz: gizliyken çubuklar son hâlleriyle çizilir.
   */
  const sayfaGizli = usePageHidden();
  const grafikAnimasyonu = !reduceMotion && !sayfaGizli;

  /**
   * "Şimdi" tek yerden gelir ve dakikada iki kez ilerler: tazelik satırı ("12 dakika önce")
   * ve devam eden ayın kaçıncı gününde olduğumuz buradan hesaplanır.
   */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const ordersQuery = useQuery<OrdersResp>({
    queryKey: ["orders"],
    queryFn: () => fetchJson<OrdersResp>("/api/orders", { cache: "no-store" }),
    staleTime: 30_000,
    // "always" her girişte pazaryeri çekimini yeniden tetikliyordu; elde 30 saniyeden taze
    // yanıt varken beklemenin karşılığı yok.
    refetchOnMount: true,
  });
  /**
   * Aylık finans — SİPARİŞ ÇEKİMİNDEN BAĞIMSIZ.
   *
   * ⚠️ Eskiden bu sorgu `enabled: ordersQuery.isSuccess` ile pazaryeri çekimine bağlıydı:
   * Trendyol/Shopify yanıt vermediğinde ekran "henüz satış verisi yok" diyordu, oysa yüzlerce
   * siparişlik geçmiş veritabanında duruyordu. Kayıtlı geçmiş her zaman gösterilir; çekim
   * bittiğinde (aşağıdaki etki) yalnızca tazelenir.
   *
   * ⚠️ ÖNBELLEK EKRANDA KALIR: `staleTime: 0` + `refetchOnMount: "always"` her girişte gereksiz
   * bir istek atıyordu; iskelet yalnız SOĞUK açılışta (uygulama yeniden başladığında ya da
   * önbellek toplandıktan sonra) çıkıyordu. Kazanç o fazladan isteğin kalkması; artık elde veri
   * varken tazeleme ARKA PLANDA olur ve ekrandaki rakamlar yerinde durur.
   */
  const financeQuery = useQuery<FinanceResponse>({
    queryKey: ["finance-monthly", 12],
    queryFn: () =>
      fetchJson<FinanceResponse>("/api/finance/monthly?months=12", {
        cache: "no-store",
      }),
    staleTime: 60_000,
    gcTime: 30 * 60_000,
    refetchOnMount: true,
  });

  /**
   * Teorik ürün kârlılığı — SAYFAYI BEKLETMEZ.
   *
   * Eskiden bu kart `/api/products?filter=active` ile besleniyordu: 372 ürünün tam kaydı
   * (536.058 bayt) iniyor, ekrana ~4 KB'lık 12 satır çıkıyordu. Artık yalnız o satırlar gelir
   * ve kart kendi küçük yükleme durumunda bekler.
   *
   * ⚠️ ÖLÇÜM DÜRÜSTLÜĞÜ: kazanç İNDİRİLEN BAYTTADIR. Sunucudaki beş okuma + ürün başına
   * simülasyon aynı kaldı; üstelik ürün listesi gövdesiyle paylaşılmadığı için kâr girdisi
   * değişince o hesap iki ayrı önbellek için iki kez yapılır.
   *
   * ⚠️ ANAHTAR `["products", …]` OLMAK ZORUNDA. Maliyet/komisyon/kargo/fiyat değiştiren ~20
   * yer `invalidateQueries({ queryKey: ["products"] })` çağırıyor; ön ek eşleşmesi bu kartı da
   * kapsasın diye anahtar o ailenin altında durur. `refetchOnMount` da ZORUNLU: genel
   * varsayılan `false` (QueryProvider) olduğu için mount'ta bayatlık hiç sorulmaz ve
   * düşürülen sorgu ekrana eski rakamla geri gelirdi.
   *
   * Gövde bir ürün DİZİSİ değil; ürün listelerini yamalayan iyimser güncellemeler
   * `Array.isArray(old)` süzgeciyle bu girdiye dokunmaz.
   */
  const profitabilityQuery = useQuery<ProductProfitability>({
    queryKey: ["products", "profitability"],
    queryFn: () =>
      fetchJson<ProductProfitability>("/api/finance/monthly?section=profitability"),
    staleTime: 2 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnMount: true,
  });

  /**
   * Sipariş çekimi bitince finansı TAZELE.
   *
   * Sunucu sipariş yazımından sonra kendi önbelleğini düşürüyor; üçüncü katman burada. Bu
   * olmadan sunucu taze rakamı hazırlar ama ekran eski sayıyı göstermeye devam eder.
   */
  const ordersHistory = ordersQuery.data?.financeHistory;
  useEffect(() => {
    const stamp = ordersQuery.dataUpdatedAt;
    if (!stamp || sonSiparisDamgasi === stamp) return;
    sonSiparisDamgasi = stamp;
    // Yeni bir şey yazılmadıysa yeniden çekmenin anlamı yok (her sorgu ~96ms ve sıralı).
    if (!ordersHistory?.ok || ordersHistory.syncedOrders <= 0) return;
    void queryClient.invalidateQueries({ queryKey: ["finance-monthly"] });
    // Yazım hâlâ sürüyorsa şu an okunan rakam yeni siparişleri İÇERMEZ; yazım bitince
    // ekranın eski sayıda kalmaması için kısa bir süre sonra bir kez daha tazelenir.
    if (!ordersHistory.pending) return;
    const timer = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ["finance-monthly"] });
    }, 5_000);
    return () => clearTimeout(timer);
  }, [ordersQuery.dataUpdatedAt, ordersHistory, queryClient]);

  const trendyolCommissionSync = useMutation({
    mutationFn: () =>
      fetchJson<TrendyolCommissionSyncResponse>(
        "/api/finance/trendyol-commissions?days=60",
        { method: "POST" }
      ),
    onSuccess: async (result) => {
      toast.success(
        result.storedOrders > 0
          ? `${result.storedOrders} Trendyol siparişinin gerçek komisyonu alındı.`
          : "Yeni Trendyol komisyon kaydı bulunamadı."
      );
      await queryClient.invalidateQueries({ queryKey: ["orders"] });
      await queryClient.invalidateQueries({ queryKey: ["finance-monthly"] });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "Trendyol komisyonları alınamadı."
      );
    },
  });

  // ── Ayı yeniden hesapla ──────────────────────────────────────────────────────────────
  // Maliyet/komisyon/kargo düzeltmesi geçmiş ayın kayıtlı rakamını kendiliğinden oynatmaz;
  // kullanıcı bunu isteyince yapılır. Tur sunucuda sürer, ilerleme yoklanır.
  const [recalcMonth, setRecalcMonth] = useState<string>("");
  const recalcStatusQuery = useQuery<{ recalc: RecalcState | null }>({
    queryKey: ["finance-recalc-status"],
    queryFn: () =>
      fetchJson<{ recalc: RecalcState | null }>(
        "/api/finance/monthly?recalc=status",
        { cache: "no-store" }
      ),
    refetchInterval: (query) =>
      RECALC_ACTIVE_PHASES.has(query.state.data?.recalc?.phase ?? "") ? 400 : false,
    staleTime: 0,
  });
  const recalc = recalcStatusQuery.data?.recalc ?? null;
  const recalcRunning = recalc != null && RECALC_ACTIVE_PHASES.has(recalc.phase);
  // Bu ekranda başlatılıp biten turun özeti görünür kalır; günler önce yapılmış bir tur
  // sayfayı açanı yanıltmasın diye eskiler sessizce geçilir.
  const [finishedRecalc, setFinishedRecalc] = useState<string | null>(null);
  const recalcStamp = recalc?.finishedAt
    ? `${recalc.startedAt}|${recalc.finishedAt}`
    : null;
  const recalcJustFinished =
    recalc?.phase === "done" && recalcStamp != null && finishedRecalc === recalcStamp;
  const startRecalc = useMutation({
    mutationFn: (month: string) =>
      fetchJson<{ recalc: RecalcState }>(
        `/api/finance/monthly?month=${encodeURIComponent(month)}`,
        { method: "POST" }
      ),
    onSuccess: (data) => {
      queryClient.setQueryData(["finance-recalc-status"], data);
      void recalcStatusQuery.refetch();
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Yeniden hesaplama başlatılamadı."
      );
    },
  });

  // Biten turu BİR KEZ bildir: yoklama sürdüğü için aynı sonuç tekrar tekrar gelir.
  const reportedRecalcRef = useRef<string | null>(null);
  const seenRecalcRef = useRef(false);
  useEffect(() => {
    if (!recalc) return;
    const wasSeen = seenRecalcRef.current;
    seenRecalcRef.current = true;
    if (!recalc.finishedAt) return;
    const stamp = `${recalc.startedAt}|${recalc.finishedAt}`;
    if (reportedRecalcRef.current === stamp) return;
    reportedRecalcRef.current = stamp;
    // Sayfa açılmadan ÖNCE bitmiş tur: sonucu şimdi duyurmak yanıltıcı olurdu.
    if (!wasSeen) return;
    setFinishedRecalc(stamp);
    if (recalc.phase === "error") {
      toast.error("Ay yeniden hesaplanamadı.", { description: recalc.error ?? undefined });
      return;
    }
    const result = recalc.result;
    if (!result) return;
    const delta = result.profitDeltaKurus / 100;
    toast.success(
      result.changedOrders === 0
        ? "Bu ayda değişen bir rakam yok."
        : `${result.changedOrders} siparişin kârı güncellendi (${
            delta >= 0 ? "+" : "−"
          }${formatCurrency(Math.abs(delta))}).`,
      {
        description:
          result.skippedOrders > 0
            ? `${result.skippedOrders} siparişin ürün bilgisi kayıtlı değil, dokunulmadı.`
            : undefined,
      }
    );
    void queryClient.invalidateQueries({ queryKey: ["finance-monthly"] });
  }, [recalc, queryClient]);

  const summary = ordersQuery.data?.summary;
  const finance = financeQuery.data;
  const timeZone = finance?.timeZone || "Europe/Istanbul";
  const financeMonths = useMemo(
    () => (Array.isArray(finance?.months) ? finance.months : []),
    [finance]
  );
  const currentMonth = financeMonths.at(-1);
  const previousMonth = financeMonths.at(-2);
  const sales = finance?.products;
  const commission = finance?.commission;
  const readiness = finance?.recalcReadiness;

  // ── Grafik aralığı ──────────────────────────────────────────────────────────────────────
  const range = useSyncExternalStore(
    aralikAbone,
    aralikSnapshot,
    aralikSunucuSnapshot
  );

  // Veri BAŞLAMADAN önceki boş aylar hem grafikten hem ay listesinden düşer.
  const dataMonths = useMemo(
    () => monthsWithData(financeMonths, finance?.dataFrom, timeZone),
    [financeMonths, finance?.dataFrom, timeZone]
  );
  const rangeOptions = useMemo(
    () => visibleRangeOptions(dataMonths.length),
    [dataMonths.length]
  );
  const activeRange: MonthRangeKey = rangeOptions.some((option) => option.key === range)
    ? range
    : "all";

  const currentProgress = currentMonth
    ? monthProgress(currentMonth.month, nowMs, timeZone)
    : null;
  const periodLabel = currentMonth
    ? monthPeriodLabel(currentMonth.month, currentProgress)
    : null;
  const previousPeriodLabel = previousMonth
    ? monthPeriodLabel(previousMonth.month, null)
    : null;
  const ongoingKey = monthKeyOf(new Date(nowMs).toISOString(), timeZone);

  const chartData = useMemo(
    () =>
      chartMonths(financeMonths, finance?.dataFrom, activeRange, timeZone).map((month) => ({
        ...month,
        ongoing: month.month === ongoingKey,
      })),
    [financeMonths, finance?.dataFrom, activeRange, timeZone, ongoingKey]
  );
  const showsOngoing = chartData.some((month) => month.ongoing);
  const showsLoss = chartData.some((month) => month.netProfit < 0);
  // Grafik daraltıldıysa altındaki cümle bunu SÖYLER; tamamı çiziliyorsa ilk veri tarihini yazar.
  const chartScope = chartScopeText(chartData.length, dataMonths.length);

  /**
   * Kaynak sağlığı ÖNCE canlı sipariş yanıtından okunur.
   *
   * Finans yanıtındaki blok sipariş çekiminin önbelleğine bakıyor ve damga bayatsa hiçbir şey
   * iddia etmiyor; finans sorgusu çekimden çok önce döndüğü için uyarı tam da hedeflediği
   * durumda (pazaryeri yanıt vermiyor) hiç görünmüyordu. Sipariş yanıtı bu bilgiyi kendi
   * içinde taze taşır.
   */
  const ordersData = ordersQuery.data;
  const ordersMissingSources = ordersData?.summary?.quality?.missingSources;
  const sources = ordersData
    ? {
        complete:
          typeof ordersData.dataComplete === "boolean"
            ? ordersData.dataComplete
            : Array.isArray(ordersMissingSources)
              ? ordersMissingSources.length === 0
              : null,
        missing: Array.isArray(ordersMissingSources) ? ordersMissingSources : [],
      }
    : finance?.sources;

  // Kullanıcı bir ay seçmediyse "bu ay" — düzeltmeler en sık içinde bulunulan ayda yapılıyor.
  const selectedRecalcMonth =
    dataMonths.some((month) => month.month === recalcMonth)
      ? recalcMonth
      : currentMonth?.month ?? "";
  const selectedReadiness = monthReadiness(readiness, selectedRecalcMonth);
  const recalcSummary = useMemo(
    () => windowRecalcSummary(readiness, financeMonths),
    [readiness, financeMonths]
  );
  // Hazırlık dökümü gelmediyse ham "eski hesapla kayıtlı" sayısına düşülür — uyarı büsbütün
  // kaybolmasın (bir tur boyunca tam bu oldu: sayfa gösterebildiği tek uyarıyı yitirdi).
  const recalcWarnCount = recalcSummary.recalculable ?? recalcSummary.outdated;
  const selectedMonthBucket = financeMonths.find(
    (month) => month.month === selectedRecalcMonth
  );
  const selectedWarnCount =
    selectedReadiness?.recalculableOrders ?? selectedMonthBucket?.outdatedOrders ?? 0;
  const blockedTotalText = blockedRecalcText(recalcSummary.blocked);
  const blockedMonthText = blockedRecalcText(selectedReadiness);

  // ── En çok satanlar: ürün KİMLİĞİNE göre (ilan başlığına göre değil) ────────────────────
  const topSellers: ProductSalesRow[] = useMemo(() => sales?.topSellers ?? [], [sales]);
  const topSellerMax = topSellers[0]?.quantity || 1;

  const earners: ProductSalesRow[] = sales?.profitLeaders ?? [];

  const profitability = profitabilityQuery.data;
  const profitLeaders: ProfitabilityRow[] = profitability?.leaders ?? [];
  const lossMakers: ProfitabilityRow[] = profitability?.losers ?? [];
  const noCostProducts = profitability?.missingCostProducts ?? 0;
  const countedProducts = profitability?.countedProducts ?? 0;

  const platformChart = useMemo(
    () =>
      summary
        ? [
            {
              platform: "Shopify",
              Ciro: Math.round(summary.shopify.revenue),
              Kâr: Math.round(summary.shopify.profit),
            },
            {
              platform: "Trendyol",
              Ciro: Math.round(summary.trendyol.revenue),
              Kâr: Math.round(summary.trendyol.profit),
            },
            {
              platform: "Hepsiburada",
              Ciro: Math.round(summary.hepsiburada.revenue),
              Kâr: Math.round(summary.hepsiburada.profit),
            },
            {
              platform: "Manuel",
              Ciro: Math.round(summary.manual?.revenue ?? 0),
              Kâr: Math.round(summary.manual?.profit ?? 0),
            },
          ]
        : [],
    [summary]
  );

  const hasMonthlyData = financeMonths.some(
    (month) =>
      month.orderCount > 0 ||
      month.expenses !== 0 ||
      month.revenue !== 0 ||
      month.orderProfit !== 0
  );
  const incompleteTotal = finance?.quality.incompleteOrders ?? 0;
  // Kayıtlı geçmiş sipariş çekimine bağlı değil: iskelet YALNIZ gerçekten hiç veri yokken.
  // ⚠️ `isPending` DEĞİL `isLoading`: ağ kopukken sorgu duraklatılır ve `isPending` sonsuza
  // kadar true kalır — ekran kalıcı olarak gri kutularda donardı.
  const loading = !finance && financeQuery.isLoading;
  // Elde veri varken tazeleme sessizce arka planda döner; kullanıcı yine de görsün.
  const refreshing = Boolean(finance) && financeQuery.isFetching;
  /**
   * Rakamlar GELMEDİ mi (hata ya da ağ yok), yoksa gelip GERÇEKTEN boş mu?
   *
   * ⚠️ Ağ kopukken sorgu duraklar: `isError` false, `isFetching` false. Bu ayrım olmadan ekran
   * yüzlerce siparişi olan kullanıcıya "Henüz satış veya gider verisi yok" diyor ve yeniden
   * deneme yolu da göstermiyordu. "Veri yok" cümlesi YALNIZ yanıt eldeyken basılır.
   */
  const financeUnavailable =
    !finance && (financeQuery.isError || financeQuery.fetchStatus === "paused");

  const freshness = finance
    ? freshnessLine(finance.generatedAt, finance.lastOrderSyncAt, nowMs)
    : null;

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-6xl min-w-0">
      <style>{BAR_GROW_CSS}</style>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <BarChart3 className="h-6 w-6 text-primary" /> Raporlar
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Aylık ciro, net kâr ve satış performansının tek görünümü.
          </p>
          {freshness && (
            <p
              /* Arka plan tazelemesinin başladığı/bittiği ekran okuyucuya da duyurulur. */
              aria-live="polite"
              className={cn(
                "text-xs mt-1 flex items-center gap-1.5 animate-in fade-in duration-500",
                freshness.stale ? "text-amber-500" : "text-muted-foreground"
              )}
            >
              {refreshing && <RefreshCw className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />}
              <span>{refreshing ? "Rakamlar tazeleniyor..." : freshness.text}</span>
            </p>
          )}
          {finance && (
            <p className="text-xs text-muted-foreground mt-1">
              {(commission?.applied ?? finance.actualCommissionOrders) > 0
                ? `${commission?.applied ?? finance.actualCommissionOrders} Trendyol siparişinde gerçek komisyon kullanılıyor.`
                : "Trendyol komisyonları henüz alınmadı."}
            </p>
          )}
          {/*
            ⚠️ "HENÜZ güncellenmedi" DEME. Bu siparişlerin komisyonu kâra HİÇ işlenemez:
            `applyActualCommissionToProfit` maliyeti eksik olan ya da ödeme tutarı sipariş
            tutarından %1'den fazla sapan siparişlerde gerçek komisyonu bilerek reddediyor —
            tutmayan bir ödemeyi işlemek yanlış kâr üretirdi. 2026-08-13'te dört ayın tamamı
            yeniden hesaplandı ve bu sayı 89'da KALDI; "henüz" demek tutulmayacak bir söz.
          */}
          {(commission?.pending ?? 0) > 0 && (
            <p className="text-xs text-muted-foreground">
              {commission?.pending} siparişte komisyon kaydı var ama kâra işlenemiyor —
              maliyeti eksik ya da ödeme tutarı siparişle tutmuyor.
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2 self-start transition-transform active:scale-[0.97]"
          disabled={trendyolCommissionSync.isPending}
          onClick={() => trendyolCommissionSync.mutate()}
        >
          <RefreshCw
            className={cn(
              "h-4 w-4",
              trendyolCommissionSync.isPending && "animate-spin"
            )}
          />
          {trendyolCommissionSync.isPending
            ? "Komisyonlar alınıyor..."
            : "Trendyol Komisyonlarını Güncelle"}
        </Button>
      </div>

      {loading ? (
        <ReportsSkeleton />
      ) : (
        <>
          {(financeQuery.isError || financeUnavailable) && (
            <Card className="border-destructive/40">
              <CardContent className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-destructive">
                  Aylık rapor alınamadı.
                </p>
                <button
                  type="button"
                  className={cn(
                    "text-sm font-medium text-primary hover:underline self-start rounded-md px-1",
                    ROW_FOCUS
                  )}
                  onClick={() => financeQuery.refetch()}
                >
                  Yeniden dene
                </button>
              </CardContent>
            </Card>
          )}

          {ordersQuery.isError && (
            <Card className="border-destructive/40">
              <CardContent className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-destructive">
                  Yeni siparişler alınamadı. Aşağıdaki rakamlar kayıtlı geçmişten geliyor.
                </p>
                <button
                  type="button"
                  className={cn(
                    "text-sm font-medium text-primary hover:underline self-start rounded-md px-1",
                    ROW_FOCUS
                  )}
                  onClick={() => ordersQuery.refetch()}
                >
                  Yeniden dene
                </button>
              </CardContent>
            </Card>
          )}

          {/* Kaynak sağlığı: `complete === null` iken HİÇBİR iddia yok, uyarı basılmaz. */}
          {sources?.complete === false && (
            <Card className="border-amber-500/40 bg-amber-500/5">
              <CardContent className="p-4 flex gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                <div className="text-sm min-w-0">
                  <p className="font-medium">
                    {sources.missing.length > 0
                      ? `${sources.missing.join(", ")} verisi alınamadı.`
                      : "Bazı satış kaynaklarının verisi alınamadı."}
                  </p>
                  <p className="text-muted-foreground mt-0.5">
                    O satışlar bu rakamlara girmemiş olabilir.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {ordersQuery.data?.financeHistory &&
            !ordersQuery.data.financeHistory.ok && (
              <Card className="border-amber-500/40 bg-amber-500/5">
                <CardContent className="p-4 flex gap-3">
                  <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                  <div className="text-sm min-w-0">
                    <p className="font-medium">Bu yenileme kaydedilemedi.</p>
                    <p className="text-muted-foreground mt-0.5">
                      Aylık grafik önceki kayıtları gösteriyor — siparişleri yeniden yenile.
                    </p>
                    {/* Cihazın/servisin ham hata metni kullanıcıya hitap etmiyor → istenirse açılır. */}
                    {ordersQuery.data.financeHistory.error && (
                      <details className="group mt-1">
                        <summary
                          className={cn(
                            "cursor-pointer select-none text-xs text-muted-foreground/70 hover:text-foreground transition-colors rounded",
                            ROW_FOCUS
                          )}
                        >
                          Ayrıntı
                        </summary>
                        <p className="mt-1 text-xs text-muted-foreground break-words">
                          {ordersQuery.data.financeHistory.error}
                        </p>
                      </details>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {/* BİLİNMEYEN ≠ SIFIR: hiç veri yokken kartlar ₺0 değil "—" gösterir; sunucu 12
                boş kova döndürdüğünde grafik "veri yok" derken kartların 0 yazması iki
                çelişkili iddia demekti. */}
            <Stat
              label="Ciro"
              period={periodLabel}
              value={hasMonthlyData && currentMonth ? currentMonth.revenue : null}
              previous={hasMonthlyData && previousMonth ? previousMonth.revenue : null}
              previousPeriod={previousPeriodLabel}
              /* Ay sonu tahmini YALNIZ günü gününe biriken ölçülerde: ciro ve sipariş adedi.
                 Gider toplu ödeniyor (kira bir günde düşer) → giderde ve ona bağlı net kârda
                 günlük ortalamayla ay sonu çıkarmak yanlış rakam üretir. */
              projection={
                hasMonthlyData && currentMonth
                  ? monthProjection(currentMonth.revenue, currentProgress)
                  : null
              }
              format={fmtK}
              higherIsBetter
              color={PRIMARY}
              icon={ShoppingCart}
              delay={0}
            />
            <Stat
              label="Net kâr"
              period={periodLabel}
              value={hasMonthlyData && currentMonth ? currentMonth.netProfit : null}
              previous={hasMonthlyData && previousMonth ? previousMonth.netProfit : null}
              previousPeriod={previousPeriodLabel}
              format={fmtK}
              higherIsBetter
              color={
                currentMonth && currentMonth.netProfit < 0
                  ? LOSS
                  : PROFIT
              }
              icon={currentMonth && currentMonth.netProfit < 0 ? TrendingDown : TrendingUp}
              delay={70}
            />
            <Stat
              label="Gider ödemesi"
              period={periodLabel}
              value={hasMonthlyData && currentMonth ? currentMonth.expenses : null}
              previous={hasMonthlyData && previousMonth ? previousMonth.expenses : null}
              previousPeriod={previousPeriodLabel}
              format={fmtK}
              /* Giderde ARTIŞ kötüdür — rengi ters döner. */
              higherIsBetter={false}
              color="oklch(0.70 0.16 60)"
              icon={Receipt}
              delay={140}
            />
            <Stat
              label="Sipariş"
              period={periodLabel}
              value={hasMonthlyData && currentMonth ? currentMonth.orderCount : null}
              previous={hasMonthlyData && previousMonth ? previousMonth.orderCount : null}
              previousPeriod={previousPeriodLabel}
              projection={
                hasMonthlyData && currentMonth
                  ? monthProjection(currentMonth.orderCount, currentProgress)
                  : null
              }
              format={fmtCount}
              higherIsBetter
              color={PRIMARY}
              icon={Trophy}
              delay={210}
            />
          </div>

          {incompleteTotal > 0 && (
            <Card className="border-amber-500/40 bg-amber-500/5">
              <CardContent className="p-4 flex gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium">
                    Son 12 ayda {incompleteTotal} siparişin kâr hesabı tam değil.
                  </p>
                  {/* Bu ay temizse üç sıfırlı bir cümle yazmak yerine 12 aylık döküm verilir. */}
                  <p className="text-muted-foreground mt-0.5">
                    {currentMonth && currentMonth.incompleteOrders > 0
                      ? `Bu ay ${currentMonth.incompleteOrders} sipariş: ${currentMonth.missingProfitOrders} tanesinde maliyet eksik, ${currentMonth.partialProfitOrders} tanesinde kâr kısmi.`
                      : `${finance?.quality.missingProfitOrders ?? 0} siparişte maliyet eksik, ${finance?.quality.partialProfitOrders ?? 0} siparişte kâr kısmi.`}
                  </p>
                  <p className="text-muted-foreground mt-0.5">
                    Bu siparişlerin cirosu toplamda var, kârda yok.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {(finance?.quality.unsupportedCurrencyOrders ?? 0) > 0 && (
            <Card className="border-amber-500/40 bg-amber-500/5">
              <CardContent className="p-4 flex gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium">
                    {finance?.quality.unsupportedCurrencyOrders} sipariş farklı para
                    biriminde olduğu için toplama katılmadı.
                  </p>
                  <p className="text-muted-foreground mt-0.5">
                    Bu siparişler TL toplamlarına eklenmedi.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-2 border-b border-border/50">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <CalendarRange className="h-4 w-4 text-primary" />
                  Aydan Aya Ciro ve Net Kâr
                </CardTitle>
                {rangeOptions.length > 0 && (
                  <div
                    role="group"
                    aria-label="Grafik aralığı"
                    className="flex items-center gap-0.5 rounded-lg border border-border/60 bg-muted/25 p-0.5"
                  >
                    {rangeOptions.map((option) => (
                      <button
                        key={option.key}
                        type="button"
                        aria-pressed={activeRange === option.key}
                        onClick={() => aralikYaz(option.key)}
                        className={cn(
                          "h-7 rounded-md px-2.5 text-xs font-medium transition-all duration-200 active:scale-[0.96]",
                          ROW_FOCUS,
                          activeRange === option.key
                            ? "bg-primary/15 text-primary"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                        )}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="pt-4">
              {hasMonthlyData && chartData.length > 0 ? (
                <div className="overflow-x-auto">
                  <div className="h-72 min-w-[480px] text-muted-foreground">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={chartData}
                        margin={{ top: 10, right: 10, bottom: 0, left: 0 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="currentColor"
                          strokeOpacity={0.12}
                          vertical={false}
                        />
                        <XAxis
                          dataKey="label"
                          tick={{ fontSize: 11, fill: "currentColor" }}
                          tickLine={false}
                          axisLine={{ stroke: "currentColor", strokeOpacity: 0.15 }}
                        />
                        <YAxis
                          tick={{ fontSize: 10, fill: "currentColor" }}
                          tickLine={false}
                          axisLine={false}
                          width={58}
                          tickFormatter={(value) => formatCompactCurrency(Number(value))}
                        />
                        <ReferenceLine y={0} stroke="currentColor" strokeOpacity={0.4} />
                        <RTooltip
                          contentStyle={TOOLTIP_STYLE}
                          cursor={{ fill: "currentColor", fillOpacity: 0.06 }}
                          formatter={(value: number, name: string) => [
                            formatCurrency(Number(value)),
                            name,
                          ]}
                        />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Bar
                          dataKey="revenue"
                          name="Ciro"
                          fill={PRIMARY}
                          radius={[4, 4, 0, 0]}
                          isAnimationActive={grafikAnimasyonu}
                        >
                          {chartData.map((month) => (
                            <Cell
                              key={month.month}
                              fill={PRIMARY}
                              /* Süren ay ekrandaki EN ÖNEMLİ ay; ayrımı asıl kesikli kenar
                                 taşır. Dolgu çok düşürülünce koyu zeminde çubuk kayboluyordu. */
                              fillOpacity={month.ongoing ? 0.5 : 0.75}
                              stroke={PRIMARY}
                              strokeOpacity={month.ongoing ? 0.9 : 0}
                              strokeDasharray={month.ongoing ? "4 3" : undefined}
                            />
                          ))}
                        </Bar>
                        <Bar
                          dataKey="netProfit"
                          name="Net kâr"
                          fill={PROFIT}
                          radius={[4, 4, 0, 0]}
                          isAnimationActive={grafikAnimasyonu}
                        >
                          {chartData.map((month) => {
                            const color = month.netProfit < 0 ? LOSS : PROFIT;
                            return (
                              <Cell
                                key={month.month}
                                fill={color}
                                fillOpacity={month.ongoing ? 0.55 : 1}
                                stroke={color}
                                strokeOpacity={month.ongoing ? 0.9 : 0}
                                strokeDasharray={month.ongoing ? "4 3" : undefined}
                              />
                            );
                          })}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              ) : (
                <div className="py-10 text-center">
                  <CalendarRange className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
                  {/* "Veri yok" ile "alınamadı" AYRI cümleler — ikisi aynı şey değil. */}
                  <p className="text-sm text-muted-foreground">
                    {financeQuery.isError || financeUnavailable
                      ? "Aylık rapor şu an alınamadı."
                      : "Henüz satış veya gider verisi yok."}
                  </p>
                </div>
              )}
              {hasMonthlyData && showsOngoing && (
                <p className="mt-3 text-xs text-muted-foreground animate-in fade-in duration-500">
                  Kesikli çubuk {periodLabel ?? "bu ay"} — ay henüz bitmedi, çubuk büyümeye
                  devam edecek.
                </p>
              )}
              {/* Renk tek başına anlam taşıyordu: efsanede yalnız yeşil kutucuk var. */}
              {hasMonthlyData && showsLoss && (
                <p className="mt-2 text-xs text-muted-foreground animate-in fade-in duration-500">
                  Kırmızı çubuk o ayın zararda olduğunu gösterir.
                </p>
              )}
              {hasMonthlyData && (
                <p className="mt-2 text-xs text-muted-foreground animate-in fade-in duration-500">
                  Shopify, Trendyol, Hepsiburada ve elle eklediğin siparişler dahil; iptal,
                  iade ve TL dışı siparişler sayılmaz. Net kâr = sipariş kârı (maliyet, komisyon
                  ve kargo düşülmüş) eksi o ay ödediğin giderler. Maliyeti girilmemiş ürünler
                  ciroya girer ama kâra katkı vermez.
                </p>
              )}
              <div className="mt-3 border-t border-border/50 pt-3 space-y-2">
                {/* Toplam üstte — ay ay dökümü aşağıda. İki cümle de KAPSAMINI söyler. */}
                {recalcWarnCount > 0 && (
                  <p className="flex items-start gap-1.5 text-xs text-amber-500 animate-in fade-in duration-500">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
                    <span>
                      Son 12 ayda {recalcWarnCount} siparişin kârı eski hesaplamayla kayıtlı —
                      aşağıdan ayı seçip yeniden hesapla.
                    </span>
                  </p>
                )}
                {blockedTotalText && (
                  <p className="text-xs text-muted-foreground">Son 12 ayda {blockedTotalText}</p>
                )}

                {/* Ay seçici düğmenin KENDİ kutusunda durur: seçim yalnız bu işlemi ilgilendirir,
                    sayfanın geri kalanı her zaman içinde bulunulan ayı gösterir. */}
                <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-2">
                  <p className="text-xs font-medium">Bir ayı yeniden hesapla</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={selectedRecalcMonth}
                      onChange={(event) => setRecalcMonth(event.target.value)}
                      disabled={recalcRunning || dataMonths.length === 0}
                      aria-label="Yeniden hesaplanacak ay"
                      className={cn(
                        "h-8 rounded-md border bg-background px-2 text-xs transition-colors hover:border-primary/40 disabled:opacity-60",
                        ROW_FOCUS
                      )}
                    >
                      {dataMonths.map((month) => (
                        <option key={month.month} value={month.month}>
                          {month.label}
                        </option>
                      ))}
                    </select>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-2 transition-transform active:scale-[0.97]"
                      disabled={
                        recalcRunning || startRecalc.isPending || !selectedRecalcMonth
                      }
                      onClick={() => startRecalc.mutate(selectedRecalcMonth)}
                    >
                      <RefreshCw
                        className={cn("h-4 w-4", recalcRunning && "animate-spin")}
                      />
                      {recalcRunning ? "Yeniden hesaplanıyor..." : "Yeniden hesapla"}
                    </Button>
                    {!recalcRunning && selectedWarnCount > 0 && (
                      <span className="inline-flex items-center gap-1.5 text-xs text-amber-500 animate-in fade-in duration-500">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        Seçili ayda {selectedWarnCount} sipariş güncellenebilir.
                      </span>
                    )}
                  </div>
                  {!recalcRunning && blockedMonthText && (
                    <p className="text-xs text-muted-foreground">
                      Seçili ayda {blockedMonthText}
                    </p>
                  )}

                  {recalc && (recalcRunning || recalcJustFinished) && (
                    <div className="space-y-1.5 animate-in fade-in slide-in-from-bottom-1 duration-300">
                      <Progress value={recalcPercent(recalc)} className="h-1.5" />
                      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span>
                          {recalc.phase === "reading" && "Satış geçmişi okunuyor"}
                          {recalc.phase === "calculating" &&
                            `${recalc.processed}/${recalc.total} sipariş yeniden hesaplanıyor`}
                          {recalc.phase === "writing" && "Yeni rakamlar kaydediliyor"}
                          {recalc.phase === "done" &&
                            `${recalc.result?.changedOrders ?? 0} siparişin kârı güncellendi`}
                        </span>
                        <span className="tabular-nums">
                          {Math.round(recalcPercent(recalc))}%
                        </span>
                      </div>
                    </div>
                  )}

                  <p className="text-xs text-muted-foreground">
                    Maliyet, komisyon veya kargoyu düzelttiysen o ayı yeniden hesapla.
                  </p>
                </div>

                {chartScope ? (
                  <p className="text-xs text-muted-foreground animate-in fade-in duration-300">
                    {chartScope}
                  </p>
                ) : (
                  finance?.dataFrom && (
                    <p className="text-xs text-muted-foreground">
                      Grafik {formatHistoryDate(finance.dataFrom)} tarihinden bu yana
                      toplanan verilerle çiziliyor.
                    </p>
                  )
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2 border-b border-border/50">
              <CardTitle className="text-sm">
                Platform Karşılaştırması — Ciro ve Sipariş Kârı (son{" "}
                {summary?.days ?? 30} gün)
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              {ordersQuery.isLoading && !summary ? (
                <Skeleton className="h-56 w-full rounded-lg" />
              ) : platformChart.length > 0 && summary && summary.total.orderCount > 0 ? (
                <div className="overflow-x-auto">
                  <div className="h-56 min-w-[420px] text-muted-foreground">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={platformChart}
                        margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="currentColor"
                          strokeOpacity={0.12}
                          vertical={false}
                        />
                        <XAxis
                          dataKey="platform"
                          tick={{ fontSize: 12, fill: "currentColor" }}
                          tickLine={false}
                          axisLine={{ stroke: "currentColor", strokeOpacity: 0.15 }}
                        />
                        <YAxis
                          tick={{ fontSize: 11, fill: "currentColor" }}
                          tickLine={false}
                          axisLine={false}
                          width={56}
                          tickFormatter={(value) => formatCompactCurrency(Number(value))}
                        />
                        <ReferenceLine y={0} stroke="currentColor" strokeOpacity={0.4} />
                        <RTooltip
                          contentStyle={TOOLTIP_STYLE}
                          cursor={{ fill: "currentColor", fillOpacity: 0.06 }}
                          formatter={(value: number, name: string) => [
                            formatCurrency(Number(value)),
                            name,
                          ]}
                        />
                        {/* Hangi çubuğun ciro hangisinin kâr olduğu ancak açıklamayla anlaşılır;
                            renkler aydan aya grafiğiyle AYNI dili konuşur (mor = ciro, yeşil = kâr). */}
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Bar
                          dataKey="Ciro"
                          name="Ciro"
                          fill={PRIMARY}
                          fillOpacity={0.75}
                          radius={[4, 4, 0, 0]}
                          isAnimationActive={grafikAnimasyonu}
                        />
                        <Bar
                          dataKey="Kâr"
                          name="Sipariş kârı"
                          fill={PROFIT}
                          radius={[4, 4, 0, 0]}
                          isAnimationActive={grafikAnimasyonu}
                        >
                          {platformChart.map((item) => (
                            <Cell
                              key={item.platform}
                              fill={item.Kâr < 0 ? LOSS : PROFIT}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  {/* Renk tek başına anlam taşıyordu: efsanede yalnız yeşil kutucuk var. */}
                  {platformChart.some((item) => item.Kâr < 0) && (
                    <p className="mt-3 text-xs text-muted-foreground animate-in fade-in duration-500">
                      Kırmızı çubuk o platformun zararda olduğunu gösterir.
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground py-6 text-center">
                  {ordersQuery.isError
                    ? "Sipariş verisi şu an alınamadı."
                    : "Son 30 günde sipariş yok."}
                </p>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* ── En çok satanlar: adet sırasına göre, ürün KİMLİĞİYLE gruplanmış ────────── */}
            <Card>
              <CardHeader className="pb-2 border-b border-border/50">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Trophy className="h-4 w-4 text-amber-500" /> En Çok Satanlar
                </CardTitle>
                <p className="text-xs text-muted-foreground">Son 30 gün, satış adedine göre.</p>
              </CardHeader>
              <CardContent className="pt-3">
                {topSellers.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    {/* "Gelmedi" ile "yok" AYRI: satış özeti bu yanıtta hiç yoksa
                        "satış yok" demek düpedüz yanlış bilgi olur. */}
                    {financeQuery.isError || !sales
                      ? "Satış listesi alınamadı."
                      : "Son 30 günde satış yok."}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {topSellers.map((seller, index) => (
                      <Link
                        key={seller.productId}
                        href={`/products/${seller.productId}`}
                        className={cn(
                          "group block space-y-1 rounded-md px-1 -mx-1 py-0.5 transition-colors hover:bg-muted/40 animate-in fade-in slide-in-from-left-1 duration-300",
                          ROW_FOCUS
                        )}
                        style={{
                          animationDelay: `${index * 40}ms`,
                          animationFillMode: "both",
                        }}
                      >
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground tabular-nums w-4 shrink-0">
                            {index + 1}.
                          </span>
                          <MiniThumb src={seller.imageUrl} />
                          <span className="truncate flex-1 min-w-0 group-hover:text-primary transition-colors">
                            {seller.name}
                          </span>
                          <span className="text-muted-foreground tabular-nums shrink-0">
                            {formatCurrency(seller.revenue, { decimals: 0 })}
                          </span>
                          <span className="font-semibold tabular-nums ml-1 shrink-0">
                            {seller.quantity} adet
                          </span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                          <div
                            className="ml-bar h-full rounded-full bg-primary"
                            style={{ width: `${(seller.quantity / topSellerMax) * 100}%` }}
                          />
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
                {(sales?.recentUnmatched?.lines ?? 0) > 0 && (
                  <p className="mt-3 text-[11px] text-muted-foreground">
                    Ürüne bağlanmamış {sales?.recentUnmatched.quantity} satış bu listede yok (
                    {formatCurrency(sales?.recentUnmatched.revenue)}).
                  </p>
                )}
                {(sales?.recentCoverage?.ordersWithoutItems ?? 0) > 0 && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {sales?.recentCoverage.ordersWithoutItems} siparişin ürün dökümü yok (
                    {formatCurrency(sales?.recentCoverage.revenueWithoutItems)} ciro) — bu liste
                    onları saymıyor.
                  </p>
                )}
                {/* Elle eklenen siparişlerin kalem geçmişi tutulmuyor; liste onları
                    içermiyor ve bunu söylemezsek kullanıcı listeyi "satışın tamamı" sanıyor. */}
                {(summary?.manual?.orderCount ?? 0) > 0 && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Elle eklediğin {summary?.manual?.orderCount} sipariş bu listede yok (
                    {formatCurrency(summary?.manual?.revenue)} ciro).
                  </p>
                )}
              </CardContent>
            </Card>

            {/* ── Gerçekleşen kâr: satılan üründen kalan para ───────────────────────────── */}
            <Card>
              <CardHeader className="pb-2 border-b border-border/50">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Coins className="h-4 w-4 text-emerald-500" /> En Çok Para Getirenler
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Son 12 ayda gerçekten satılan üründen kalan kâr.
                </p>
              </CardHeader>
              <CardContent className="pt-3">
                {earners.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    {financeQuery.isError || !sales
                      ? "Liste alınamadı."
                      : "Kârı hesaplanmış satış yok."}
                  </p>
                ) : (
                  <div className="space-y-1">
                    {earners.map((row, index) => {
                      const warning = profitWarningLabel(row);
                      return (
                      <Link
                        key={row.productId}
                        href={`/products/${row.productId}`}
                        className={cn(
                          "group flex items-center gap-2 text-xs py-0.5 rounded-md px-1 -mx-1 transition-colors hover:bg-muted/40 animate-in fade-in slide-in-from-left-1 duration-300",
                          ROW_FOCUS
                        )}
                        style={{
                          animationDelay: `${index * 40}ms`,
                          animationFillMode: "both",
                        }}
                      >
                        <MiniThumb src={row.imageUrl} />
                        <span className="truncate flex-1 min-w-0 group-hover:text-primary transition-colors">
                          {row.name}
                        </span>
                        <span className="text-muted-foreground tabular-nums shrink-0">
                          {row.quantity} adet
                        </span>
                        {/* Zararına satılan ürün de bu listeye girebiliyor; renk İŞARETE göre. */}
                        <span
                          className={cn(
                            "tabular-nums font-medium ml-1 shrink-0",
                            (row.profit ?? 0) < 0 ? "text-destructive" : "text-emerald-500"
                          )}
                        >
                          {formatCurrency(row.profit)}
                        </span>
                        {warning && (
                          <span
                            role="img"
                            title={warning}
                            aria-label={warning}
                            className="inline-flex shrink-0"
                          >
                            <AlertTriangle
                              className="h-3 w-3 text-amber-500"
                              aria-hidden="true"
                            />
                          </span>
                        )}
                      </Link>
                      );
                    })}
                  </div>
                )}
                {(sales?.coverage?.ordersWithoutItems ?? 0) > 0 && (
                  <p className="mt-3 text-[11px] text-muted-foreground">
                    {sales?.coverage.ordersWithoutItems} siparişin ürün dökümü yok (
                    {formatCurrency(sales?.coverage.revenueWithoutItems)} ciro) — bu
                    satışların kârı listede yok.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ── Teorik kârlılık: bugünkü fiyat ve maliyetle ──────────────────────────────── */}
          <Card>
            <CardHeader className="pb-2 border-b border-border/50">
              <CardTitle className="text-sm flex items-center gap-2">
                Ürün Kârlılığı
                {profitabilityQuery.isFetching && profitability && (
                  <RefreshCw className="h-3 w-3 text-muted-foreground animate-spin" />
                )}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Bugünkü fiyat ve maliyetle bir adet satılsa ne kalır — satış adedinden bağımsız.
              </p>
            </CardHeader>
            <CardContent className="pt-3 space-y-3">
              {!profitability ? (
                /* Beklerken ÖLÜ EKRAN YOK: ya "hesaplanıyor" satırları döner, ya da çekim
                   durmuşsa (hata / bağlantı yok) elle yeniden deneme çıkar. */
                profitabilityQuery.isFetching ? (
                  <div className="space-y-2">
                    <p className="text-[11px] text-muted-foreground">
                      Ürün kârlılığı hesaplanıyor...
                    </p>
                    {/* Soluk giriş DIŞ kutuda: `Skeleton` kendi `animate-pulse`ını taşıyor ve
                        iki sınıf aynı `animation` kısayolunu yazınca kademeli giriş hiç
                        çalışmıyordu. */}
                    {Array.from({ length: 5 }).map((_, index) => (
                      <div
                        key={index}
                        className="animate-in fade-in duration-300"
                        style={{ animationDelay: `${index * 50}ms`, animationFillMode: "both" }}
                      >
                        <Skeleton className="h-5 w-full rounded" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs text-muted-foreground">Ürün listesi alınamadı.</p>
                    <button
                      type="button"
                      className={cn(
                        "text-xs font-medium text-primary hover:underline self-start rounded-md px-1",
                        ROW_FOCUS
                      )}
                      onClick={() => profitabilityQuery.refetch()}
                    >
                      Yeniden dene
                    </button>
                  </div>
                )
              ) : (
                <>
                  <div>
                    <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                      <TrendingUp className="h-3.5 w-3.5 text-green-500" /> En kârlı
                    </p>
                    {profitLeaders.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        Maliyeti girilmiş ürün yok.
                      </p>
                    ) : (
                      profitLeaders.map((product, index) => {
                        const sold = soldUnitsBadge(
                          sales?.soldUnits,
                          product.id,
                          sales?.coverage.ordersWithoutItems ?? 0
                        );
                        return (
                          <Link
                            key={product.id}
                            href={`/products/${product.id}`}
                            className={cn(
                              "group flex items-center gap-2 text-xs py-0.5 rounded-md px-1 -mx-1 transition-colors hover:bg-muted/40 animate-in fade-in slide-in-from-left-1 duration-300",
                              ROW_FOCUS
                            )}
                            style={{
                              animationDelay: `${index * 40}ms`,
                              animationFillMode: "both",
                            }}
                          >
                            <MiniThumb src={product.imageUrl} />
                            <span className="truncate flex-1 min-w-0 group-hover:text-primary transition-colors">
                              {product.name}
                            </span>
                            {sold && (
                              <span
                                className={cn(
                                  "shrink-0 rounded-full px-1.5 py-px text-[10px] tabular-nums",
                                  sold.sold
                                    ? "bg-primary/15 text-primary"
                                    : "bg-muted text-muted-foreground"
                                )}
                              >
                                {sold.text}
                              </span>
                            )}
                            <span className="tabular-nums font-medium text-green-500 ml-1 shrink-0">
                              {formatCurrency(product.netProfit)}
                              <span className="text-muted-foreground font-normal ml-1">
                                ({formatPercent(product.profitMargin)})
                              </span>
                            </span>
                          </Link>
                        );
                      })
                    )}
                  </div>
                  {lossMakers.length > 0 && (
                    <div className="border-t border-border/40 pt-2">
                      <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                        <TrendingDown className="h-3.5 w-3.5 text-destructive" /> Zarar
                        edenler
                      </p>
                      {lossMakers.map((product, index) => {
                        const sold = soldUnitsBadge(
                          sales?.soldUnits,
                          product.id,
                          sales?.coverage.ordersWithoutItems ?? 0
                        );
                        return (
                          <Link
                            key={product.id}
                            href={`/products/${product.id}`}
                            className={cn(
                              "group flex items-center gap-2 text-xs py-0.5 rounded-md px-1 -mx-1 transition-colors hover:bg-muted/40 animate-in fade-in slide-in-from-left-1 duration-300",
                              ROW_FOCUS
                            )}
                            style={{
                              animationDelay: `${index * 40}ms`,
                              animationFillMode: "both",
                            }}
                          >
                            <MiniThumb src={product.imageUrl} />
                            <span className="truncate flex-1 min-w-0 group-hover:text-primary transition-colors">
                              {product.name}
                            </span>
                            {sold && (
                              <span
                                className={cn(
                                  "shrink-0 rounded-full px-1.5 py-px text-[10px] tabular-nums",
                                  sold.sold
                                    ? "bg-destructive/15 text-destructive"
                                    : "bg-muted text-muted-foreground"
                                )}
                              >
                                {sold.text}
                              </span>
                            )}
                            <span className="tabular-nums font-medium text-destructive ml-1 shrink-0">
                              {formatCurrency(product.netProfit)}
                            </span>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                  {countedProducts > 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      {countedProducts} ürünün kârı hesaplandı.
                    </p>
                  )}
                  {noCostProducts > 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      {noCostProducts} ürünün maliyeti girilmemiş, bu listede yok.
                    </p>
                  )}
                  {/* Satış rozeti bu siparişleri göremiyor — düzeltici bilgi burada da dursun. */}
                  {(sales?.coverage?.ordersWithoutItems ?? 0) > 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      {sales?.coverage.ordersWithoutItems} siparişin ürün dökümü yok, satış
                      rozetleri onları saymıyor.
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/**
 * Yükleme iskeleti GERÇEK düzeni taklit eder.
 *
 * Eskiden altı eşit gri kutu (~512 piksel) basılıyordu; gerçek sayfa çok daha uzun olduğu için
 * veri gelince içerik aşağı ZIPLIYORDU. Aynı sıradaki aynı yükseklikteki kutular bu sıçramayı
 * bitirir.
 */
function SkeletonRows({ count, bar = false }: { count: number; bar?: boolean }) {
  return (
    <>
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className={bar ? "space-y-1 py-0.5" : "py-1"}>
          <div className="flex items-center gap-2">
            <Skeleton className="h-6 w-6 rounded-md shrink-0" />
            <Skeleton className="h-3 flex-1 rounded" />
            <Skeleton className="h-3 w-14 rounded shrink-0" />
          </div>
          {bar && <Skeleton className="h-1.5 w-full rounded-full" />}
        </div>
      ))}
    </>
  );
}

function ReportsSkeleton() {
  return (
    /* Ekran okuyucu için sayfanın hazırlandığı DUYURULUR; gri kutuların kendisi gizlenir. */
    <div role="status" aria-busy="true">
      <span className="sr-only">Rapor hazırlanıyor…</span>
      <div className="space-y-5" aria-hidden="true">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <Card
              key={index}
              className="overflow-hidden animate-in fade-in duration-500"
              style={{ animationDelay: `${index * 60}ms`, animationFillMode: "both" }}
            >
              <CardContent className="p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1">
                    <Skeleton className="h-3 w-16 rounded" />
                    <Skeleton className="h-2.5 w-20 rounded" />
                  </div>
                  <Skeleton className="h-4 w-4 rounded" />
                </div>
                <Skeleton className="h-6 w-28 rounded mt-2" />
                <Skeleton className="h-3 w-32 rounded mt-2" />
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="animate-in fade-in duration-500">
          <CardHeader className="pb-2 border-b border-border/50">
            <div className="flex items-center justify-between gap-2">
              <Skeleton className="h-4 w-52 rounded" />
              <Skeleton className="h-8 w-40 rounded-lg" />
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            <Skeleton className="h-72 w-full rounded-lg" />
            <Skeleton className="h-3 w-3/4 rounded mt-3" />
            <Skeleton className="h-3 w-full rounded mt-2" />
            <Skeleton className="h-3 w-5/6 rounded mt-1" />
            <div className="mt-3 border-t border-border/50 pt-3 space-y-2">
              <Skeleton className="h-[104px] w-full rounded-lg" />
              <Skeleton className="h-3 w-64 rounded" />
            </div>
          </CardContent>
        </Card>

        <Card className="animate-in fade-in duration-500">
          <CardHeader className="pb-2 border-b border-border/50">
            <Skeleton className="h-4 w-72 rounded" />
          </CardHeader>
          <CardContent className="pt-4">
            <Skeleton className="h-56 w-full rounded-lg" />
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          {[true, false].map((withBar) => (
            <Card key={String(withBar)} className="animate-in fade-in duration-500">
              <CardHeader className="pb-2 border-b border-border/50">
                <Skeleton className="h-4 w-40 rounded" />
                <Skeleton className="h-3 w-52 rounded mt-1" />
              </CardHeader>
              <CardContent className="pt-3">
                <SkeletonRows count={withBar ? 6 : 8} bar={withBar} />
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="animate-in fade-in duration-500">
          <CardHeader className="pb-2 border-b border-border/50">
            <Skeleton className="h-4 w-32 rounded" />
            <Skeleton className="h-3 w-80 max-w-full rounded mt-1" />
          </CardHeader>
          <CardContent className="pt-3 space-y-3">
            <div>
              <Skeleton className="h-2.5 w-20 rounded mb-1.5" />
              <SkeletonRows count={6} />
            </div>
            <div className="border-t border-border/40 pt-2">
              <Skeleton className="h-2.5 w-24 rounded mb-1.5" />
              <SkeletonRows count={3} />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * Özet kartı. Rakam SNAP ETMEZ, akar (AnimatedNumber) — kartlar da sırayla belirir.
 * Veri henüz yokken `value` null verilir ve animasyon yerine "—" gösterilir; 0'dan 0'a
 * anlamsız bir sayaç dönmesin.
 *
 * Gizli pencerede rakamın 0'da donması `AnimatedNumber`'ın içinde çözülür — düzeltme orada
 * durunca aynı sayacı kullanan bütün ekranlar (Panel, Siparişler, Planlayıcı…) payını alır.
 */
function Stat({
  label,
  period,
  value,
  previous,
  previousPeriod,
  projection,
  format,
  higherIsBetter,
  color,
  icon: Icon,
  delay = 0,
}: {
  label: string;
  /** "1–13 Ağustos" gibi — kartın hangi dönemi anlattığı. */
  period?: string | null;
  value: number | null;
  previous?: number | null;
  /** Kıyaslanan ayın adı. */
  previousPeriod?: string | null;
  /** Ay sonu tahmini — yalnız süren ayda ve günü gününe biriken ölçülerde. */
  projection?: number | null;
  format: (n: number) => string;
  higherIsBetter: boolean;
  color: string;
  icon: React.ElementType;
  delay?: number;
}) {
  const delta = statDelta(value, previous);
  const tone = delta ? deltaTone(delta.diff, higherIsBetter) : "neutral";
  const toneClass =
    tone === "good"
      ? "text-emerald-500"
      : tone === "bad"
        ? "text-destructive"
        : "text-muted-foreground";
  const Arrow = delta && delta.diff > 0 ? ArrowUpRight : ArrowDownRight;

  return (
    <Card
      className="overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-500 transition-transform hover:-translate-y-0.5"
      style={{
        borderTop: `2px solid ${color}`,
        animationDelay: `${delay}ms`,
        animationFillMode: "both",
      }}
    >
      <CardContent className="p-3.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <span className="block text-xs text-muted-foreground truncate">{label}</span>
            {period && (
              <span className="block text-[10px] text-muted-foreground/70 truncate">
                {period}
              </span>
            )}
          </div>
          <Icon className="h-4 w-4 shrink-0 mt-0.5" style={{ color }} />
        </div>
        <div className="text-xl font-bold tabular-nums mt-1" style={{ color }}>
          {value === null ? "—" : <AnimatedNumber value={value} format={format} />}
        </div>
        {delta && (
          <div
            className="mt-1 flex items-center gap-1 text-[11px] animate-in fade-in duration-500"
            style={{ animationDelay: `${delay + 260}ms`, animationFillMode: "both" }}
          >
            {delta.diff === 0 ? (
              <span className="text-muted-foreground truncate">
                {previousPeriod ? `${previousPeriod} ayıyla aynı` : "Geçen ayın tamamıyla aynı"}
              </span>
            ) : (
              <>
                <Arrow className={cn("h-3 w-3 shrink-0", toneClass)} />
                <span className={cn("tabular-nums font-medium", toneClass)}>
                  {delta.diff > 0 ? "+" : "−"}
                  {format(Math.abs(delta.diff))}
                  {delta.ratio != null && ` · ${formatPercent(Math.abs(delta.ratio), 0)}`}
                </span>
                {/* Bu ay HENÜZ SÜRÜYOR; kıyas geçen ayın TAMAMINA karşı yapılıyor. Ayın
                    başında büyük bir düşüş görünmesi bundandır — cümle bunu söyler. */}
                <span className="text-muted-foreground truncate">
                  {previousPeriod ? `${previousPeriod} ayının tamamına göre` : "geçen ayın tamamına göre"}
                </span>
              </>
            )}
          </div>
        )}
        {projection != null && (
          <div
            className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground/70 animate-in fade-in duration-500"
            style={{ animationDelay: `${delay + 360}ms`, animationFillMode: "both" }}
          >
            <span className="tabular-nums">≈ {format(projection)}</span>
            <span className="truncate">ay sonu tahmini</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
