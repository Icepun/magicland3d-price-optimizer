"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState } from "react";
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
import { thumbUrl } from "@/lib/image";
import { fetchJson } from "@/lib/fetch-json";
import { toast } from "sonner";
import {
  blockedRecalcText,
  deltaTone,
  missingCostCount,
  monthReadiness,
  profitWarningLabel,
  soldUnitsBadge,
  statDelta,
  windowRecalcSummary,
  type FinanceResponse,
  type ProductSalesRow,
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

interface ProductRow {
  id: string;
  name: string;
  imageUrl: string | null;
  currentNetProfit: number | null;
  currentProfitMargin: number | null;
  hasCost: boolean;
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
 * "En çok satanlar" çubukları sıfırdan dolar.
 *
 * Dolgu JS/rAF ile değil CSS ile yapılır ve `fill-mode` VERİLMEZ: animasyon hiç başlamasa
 * bile (gizli pencere) çubuk kendi gerçek genişliğinde durur, sıfırda donmaz.
 */
const BAR_GROW_CSS = `
@keyframes ml-bar-grow { from { width: 0 } }
.ml-bar { animation: ml-bar-grow 700ms cubic-bezier(0.16, 1, 0.3, 1); }
@media (prefers-reduced-motion: reduce) { .ml-bar { animation: none } }
`;

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

const SHOPIFY = "oklch(0.60 0.16 152)";
const TRENDYOL = "oklch(0.72 0.17 60)";
const HEPSIBURADA = "oklch(0.66 0.19 38)";
const MANUAL = "oklch(0.64 0.19 285)";
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

export default function ReportsPage() {
  const queryClient = useQueryClient();

  const ordersQuery = useQuery<OrdersResp>({
    queryKey: ["orders"],
    queryFn: () => fetchJson<OrdersResp>("/api/orders", { cache: "no-store" }),
    staleTime: 30_000,
    refetchOnMount: "always",
  });
  const productsQuery = useQuery<ProductRow[]>({
    queryKey: ["products", "active"],
    queryFn: () => fetchJson<ProductRow[]>("/api/products?filter=active"),
    staleTime: 60_000,
  });
  /**
   * Aylık finans — SİPARİŞ ÇEKİMİNDEN BAĞIMSIZ.
   *
   * ⚠️ Eskiden bu sorgu `enabled: ordersQuery.isSuccess` ile pazaryeri çekimine bağlıydı:
   * Trendyol/Shopify yanıt vermediğinde ekran "henüz satış verisi yok" diyordu, oysa yüzlerce
   * siparişlik geçmiş veritabanında duruyordu. Kayıtlı geçmiş her zaman gösterilir; çekim
   * bittiğinde (aşağıdaki etki) yalnızca tazelenir.
   */
  const financeQuery = useQuery<FinanceResponse>({
    queryKey: ["finance-monthly", 12],
    queryFn: () =>
      fetchJson<FinanceResponse>("/api/finance/monthly?months=12", {
        cache: "no-store",
      }),
    staleTime: 0,
    refetchOnMount: "always",
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
  const productList = useMemo(
    () => (Array.isArray(productsQuery.data) ? productsQuery.data : []),
    [productsQuery.data]
  );
  const financeMonths = useMemo(
    () => (Array.isArray(finance?.months) ? finance.months : []),
    [finance]
  );
  const currentMonth = financeMonths.at(-1);
  const previousMonth = financeMonths.at(-2);
  const sales = finance?.products;
  const commission = finance?.commission;
  const readiness = finance?.recalcReadiness;

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
    financeMonths.some((month) => month.month === recalcMonth)
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

  const profitLeaders = useMemo(
    () =>
      productList
        .filter((product) => product.hasCost && product.currentNetProfit != null)
        .sort((a, b) => (b.currentNetProfit ?? 0) - (a.currentNetProfit ?? 0))
        .slice(0, 6),
    [productList]
  );
  const lossMakers = useMemo(
    () =>
      productList
        .filter(
          (product) =>
            product.currentNetProfit != null && (product.currentNetProfit ?? 0) < 0
        )
        .sort((a, b) => (a.currentNetProfit ?? 0) - (b.currentNetProfit ?? 0))
        .slice(0, 6),
    [productList]
  );
  const noCostProducts = useMemo(() => missingCostCount(productList), [productList]);

  const platformChart = useMemo(
    () =>
      summary
        ? [
            {
              platform: "Shopify",
              Ciro: Math.round(summary.shopify.revenue),
              Kâr: Math.round(summary.shopify.profit),
              color: SHOPIFY,
            },
            {
              platform: "Trendyol",
              Ciro: Math.round(summary.trendyol.revenue),
              Kâr: Math.round(summary.trendyol.profit),
              color: TRENDYOL,
            },
            {
              platform: "Hepsiburada",
              Ciro: Math.round(summary.hepsiburada.revenue),
              Kâr: Math.round(summary.hepsiburada.profit),
              color: HEPSIBURADA,
            },
            {
              platform: "Manuel",
              Ciro: Math.round(summary.manual?.revenue ?? 0),
              Kâr: Math.round(summary.manual?.profit ?? 0),
              color: MANUAL,
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
  // Kayıtlı geçmiş sipariş çekimine bağlı değil: yalnız finans ilk kez yüklenirken iskelet.
  const loading = financeQuery.isLoading && !finance;

  const recentCoverage = sales?.recentCoverage;
  const recentUnmatched = sales?.recentUnmatched;

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-6xl">
      <style>{BAR_GROW_CSS}</style>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <BarChart3 className="h-6 w-6 text-primary" /> Raporlar
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Aylık ciro, net kâr ve satış performansının tek görünümü.
          </p>
          {finance && (
            <p className="text-xs text-muted-foreground mt-1">
              {(commission?.applied ?? finance.actualCommissionOrders) > 0
                ? `${commission?.applied ?? finance.actualCommissionOrders} Trendyol siparişinde gerçek komisyon kullanılıyor.`
                : "Trendyol komisyonları henüz alınmadı."}
            </p>
          )}
          {(commission?.pending ?? 0) > 0 && (
            <p className="text-xs text-muted-foreground">
              {commission?.pending} siparişin komisyonu geldi, kârı henüz güncellenmedi.
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2 self-start"
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
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-40 w-full rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          {financeQuery.isError && (
            <Card className="border-destructive/40">
              <CardContent className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-destructive">
                  Aylık rapor alınamadı.
                </p>
                <button
                  type="button"
                  className="text-sm font-medium text-primary hover:underline self-start"
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
                  className="text-sm font-medium text-primary hover:underline self-start"
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
                        <summary className="cursor-pointer select-none text-xs text-muted-foreground/70 hover:text-foreground transition-colors">
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
              label="Ciro (bu ay)"
              value={hasMonthlyData && currentMonth ? currentMonth.revenue : null}
              previous={hasMonthlyData && previousMonth ? previousMonth.revenue : null}
              format={fmtK}
              higherIsBetter
              color={PRIMARY}
              icon={ShoppingCart}
              delay={0}
            />
            <Stat
              label="Net kâr (bu ay)"
              value={hasMonthlyData && currentMonth ? currentMonth.netProfit : null}
              previous={hasMonthlyData && previousMonth ? previousMonth.netProfit : null}
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
              label="Gider ödemesi (bu ay)"
              value={hasMonthlyData && currentMonth ? currentMonth.expenses : null}
              previous={hasMonthlyData && previousMonth ? previousMonth.expenses : null}
              format={fmtK}
              /* Giderde ARTIŞ kötüdür — rengi ters döner. */
              higherIsBetter={false}
              color="oklch(0.70 0.16 60)"
              icon={Receipt}
              delay={140}
            />
            <Stat
              label="Sipariş (bu ay)"
              value={hasMonthlyData && currentMonth ? currentMonth.orderCount : null}
              previous={hasMonthlyData && previousMonth ? previousMonth.orderCount : null}
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
              <CardTitle className="text-sm flex items-center gap-2">
                <CalendarRange className="h-4 w-4 text-primary" />
                Aydan Aya Ciro ve Net Kâr
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              {hasMonthlyData ? (
                <div className="h-72 w-full text-muted-foreground">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={financeMonths}
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
                        contentStyle={{
                          background: "oklch(0.2 0.02 278)",
                          border: "1px solid oklch(1 0 0 / 12%)",
                          borderRadius: 8,
                          fontSize: 12,
                          color: "oklch(0.95 0 0)",
                        }}
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
                        fillOpacity={0.75}
                        radius={[4, 4, 0, 0]}
                      />
                      <Bar
                        dataKey="netProfit"
                        name="Net kâr"
                        fill={PROFIT}
                        radius={[4, 4, 0, 0]}
                      >
                        {financeMonths.map((month) => (
                          <Cell
                            key={month.month}
                            fill={month.netProfit < 0 ? LOSS : PROFIT}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="py-10 text-center">
                  <CalendarRange className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
                  {/* "Veri yok" ile "alınamadı" AYRI cümleler — ikisi aynı şey değil. */}
                  <p className="text-sm text-muted-foreground">
                    {financeQuery.isError
                      ? "Aylık rapor şu an alınamadı."
                      : "Henüz satış veya gider verisi yok."}
                  </p>
                </div>
              )}
              {hasMonthlyData && (
                <p className="mt-3 text-xs text-muted-foreground animate-in fade-in duration-500">
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
                      ayı seçip yeniden hesapla.
                    </span>
                  </p>
                )}
                {blockedTotalText && (
                  <p className="text-xs text-muted-foreground">Son 12 ayda {blockedTotalText}</p>
                )}

                {/* Düğme HER ZAMAN durur: "maliyeti düzelttim, geçmiş ayı güncelle" en sık
                    kullanılan yol ve o durumda güncellenecek eski kayıt sayısı 0'dır. */}
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={selectedRecalcMonth}
                    onChange={(event) => setRecalcMonth(event.target.value)}
                    disabled={recalcRunning || financeMonths.length === 0}
                    className="h-8 rounded-md border bg-background px-2 text-xs disabled:opacity-60"
                    title="Yeniden hesaplanacak ay"
                  >
                    {financeMonths.map((month) => (
                      <option key={month.month} value={month.month}>
                        {month.label}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 gap-2"
                    disabled={
                      recalcRunning || startRecalc.isPending || !selectedRecalcMonth
                    }
                    onClick={() => startRecalc.mutate(selectedRecalcMonth)}
                  >
                    <RefreshCw
                      className={cn("h-4 w-4", recalcRunning && "animate-spin")}
                    />
                    {recalcRunning ? "Yeniden hesaplanıyor..." : "Bu ayı yeniden hesapla"}
                  </Button>
                  {!recalcRunning && selectedWarnCount > 0 && (
                    <span className="inline-flex items-center gap-1.5 text-xs text-amber-500 animate-in fade-in duration-500">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      Bu ayda {selectedWarnCount} sipariş güncellenebilir.
                    </span>
                  )}
                </div>
                {!recalcRunning && blockedMonthText && (
                  <p className="text-xs text-muted-foreground">Bu ayda {blockedMonthText}</p>
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

                {finance?.dataFrom && (
                  <p className="text-xs text-muted-foreground">
                    Grafik {formatHistoryDate(finance.dataFrom)} tarihinden bu yana
                    toplanan verilerle çiziliyor.
                  </p>
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
              {ordersQuery.isLoading ? (
                <Skeleton className="h-56 w-full rounded-lg" />
              ) : platformChart.length > 0 && summary && summary.total.orderCount > 0 ? (
                <div className="h-56 w-full text-muted-foreground">
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
                        contentStyle={{
                          background: "oklch(0.2 0.02 278)",
                          border: "1px solid oklch(1 0 0 / 12%)",
                          borderRadius: 8,
                          fontSize: 12,
                          color: "oklch(0.95 0 0)",
                        }}
                        formatter={(value: number) => formatCurrency(Number(value))}
                      />
                      <Bar dataKey="Ciro" radius={[4, 4, 0, 0]}>
                        {platformChart.map((item, index) => (
                          <Cell key={index} fill={item.color} />
                        ))}
                      </Bar>
                      <Bar
                        dataKey="Kâr"
                        radius={[4, 4, 0, 0]}
                        fill={PRIMARY}
                        fillOpacity={0.55}
                      />
                    </BarChart>
                  </ResponsiveContainer>
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
                        className="group block space-y-1 rounded-md px-1 -mx-1 py-0.5 transition-colors hover:bg-muted/40 animate-in fade-in slide-in-from-left-1 duration-300"
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
                            style={{
                              width: `${(seller.quantity / topSellerMax) * 100}%`,
                            }}
                          />
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
                {(recentUnmatched?.lines ?? 0) > 0 && (
                  <p className="mt-3 text-[11px] text-muted-foreground">
                    Ürüne bağlanmamış {recentUnmatched?.quantity} satış bu listede yok (
                    {formatCurrency(recentUnmatched?.revenue)}).
                  </p>
                )}
                {(recentCoverage?.ordersWithoutItems ?? 0) > 0 && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {recentCoverage?.ordersWithoutItems} siparişin ürün dökümü yok (
                    {formatCurrency(recentCoverage?.revenueWithoutItems)} ciro) — bu liste
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
                        className="group flex items-center gap-2 text-xs py-0.5 rounded-md px-1 -mx-1 transition-colors hover:bg-muted/40 animate-in fade-in slide-in-from-left-1 duration-300"
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
              <CardTitle className="text-sm">Ürün Kârlılığı</CardTitle>
              <p className="text-xs text-muted-foreground">
                Bugünkü fiyat ve maliyetle bir adet satılsa ne kalır — satış adedinden bağımsız.
              </p>
            </CardHeader>
            <CardContent className="pt-3 space-y-3">
              {productsQuery.isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <Skeleton key={index} className="h-5 w-full rounded" />
                  ))}
                </div>
              ) : (
                <>
                  <div>
                    <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                      <TrendingUp className="h-3.5 w-3.5 text-green-500" /> En kârlı
                    </p>
                    {profitLeaders.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {productsQuery.isError
                          ? "Ürün listesi alınamadı."
                          : "Maliyeti girilmiş ürün yok."}
                      </p>
                    ) : (
                      profitLeaders.map((product) => {
                        const sold = soldUnitsBadge(
                          sales?.soldUnits,
                          product.id,
                          sales?.coverage.ordersWithoutItems ?? 0
                        );
                        return (
                          <Link
                            key={product.id}
                            href={`/products/${product.id}`}
                            className="group flex items-center gap-2 text-xs py-0.5 rounded-md px-1 -mx-1 transition-colors hover:bg-muted/40"
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
                              {formatCurrency(product.currentNetProfit)}
                              <span className="text-muted-foreground font-normal ml-1">
                                ({formatPercent(product.currentProfitMargin)})
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
                      {lossMakers.map((product) => {
                        const sold = soldUnitsBadge(
                          sales?.soldUnits,
                          product.id,
                          sales?.coverage.ordersWithoutItems ?? 0
                        );
                        return (
                          <Link
                            key={product.id}
                            href={`/products/${product.id}`}
                            className="group flex items-center gap-2 text-xs py-0.5 rounded-md px-1 -mx-1 transition-colors hover:bg-muted/40"
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
                              {formatCurrency(product.currentNetProfit)}
                            </span>
                          </Link>
                        );
                      })}
                    </div>
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
 * Özet kartı. Rakam SNAP ETMEZ, akar (AnimatedNumber) — kartlar da sırayla belirir.
 * Veri henüz yokken `value` null verilir ve animasyon yerine "—" gösterilir; 0'dan 0'a
 * anlamsız bir sayaç dönmesin.
 *
 * Gizli pencerede rakamın 0'da donması `AnimatedNumber`'ın içinde çözülür — düzeltme orada
 * durunca aynı sayacı kullanan bütün ekranlar (Panel, Siparişler, Planlayıcı…) payını alır.
 */
function Stat({
  label,
  value,
  previous,
  format,
  higherIsBetter,
  color,
  icon: Icon,
  delay = 0,
}: {
  label: string;
  value: number | null;
  previous?: number | null;
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
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Icon className="h-4 w-4 shrink-0" style={{ color }} />
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
              <span className="text-muted-foreground">Geçen ayın tamamıyla aynı</span>
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
                <span className="text-muted-foreground truncate">geçen ayın tamamına göre</span>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
