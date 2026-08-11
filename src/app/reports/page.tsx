"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState } from "react";
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
  BarChart3,
  CalendarRange,
  Landmark,
  Package,
  Percent,
  Receipt,
  RefreshCw,
  ShoppingCart,
  TrendingDown,
  TrendingUp,
  Trophy,
  Undo2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatCompactCurrency, formatCurrency, formatNumber, formatPercent } from "@/lib/format";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { thumbUrl } from "@/lib/image";
import { fetchJson } from "@/lib/fetch-json";
import { toast } from "sonner";

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
  summary: {
    days: number;
    shopify: SummaryBucket;
    trendyol: SummaryBucket;
    hepsiburada: SummaryBucket;
    manual?: SummaryBucket;
    total: SummaryBucket;
  };
  financeHistory?: {
    ok: boolean;
    syncedOrders: number;
    syncDays: number;
    error?: string;
  };
}

interface ProductRow {
  id: string;
  name: string;
  imageUrl: string | null;
  currentNetProfit: number | null;
  currentProfitMargin: number | null;
  hasCost: boolean;
}

/** Ayın KDV özeti. Eski bir yanıt gelirse alan hiç olmayabilir → her yerde savunmacı okunur. */
interface VatSummary {
  outputVat: number;
  inputVatCredit: number;
  payable: number;
  knownOrders: number;
  partialOrders: number;
  unknownOrders: number;
  unknownRevenue: number;
}

interface FinanceBucket {
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
  vat?: VatSummary;
  /** Eski hesapla kaydedilmiş sipariş sayısı — "bu ayın rakamı güncel değil" uyarısı için. */
  outdatedOrders?: number;
  byPlatform: Record<string, unknown>;
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

interface FinanceTotals {
  revenue: number;
  orderProfit: number;
  expenses: number;
  netProfit: number;
  orderCount: number;
  vat?: VatSummary;
}

interface FinanceQuality {
  incompleteOrders: number;
  partialProfitOrders: number;
  missingProfitOrders: number;
  excludedOrders: number;
  unsupportedCurrencyOrders: number;
}

interface FinanceResponse {
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
}

interface TrendyolCommissionSyncResponse {
  fetchedTransactions: number;
  storedOrders: number;
  skippedTransactions: number;
  days: number;
  syncedAt: string;
}

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
/** KDV kartı: hesaplanan (satıştan) sıcak, indirilecek (girdilerden) soğuk renkte. */
const VAT_OUT = "oklch(0.70 0.16 30)";
const VAT_IN = "oklch(0.68 0.13 200)";

/** Özet kartları: kuruş göstermeye gerek yok, ondalıksız daha okunaklı. */
const fmtK = (value: number) => formatCurrency(value, { decimals: 0 });

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
  const financeQuery = useQuery<FinanceResponse>({
    queryKey: ["finance-monthly", 12, ordersQuery.dataUpdatedAt],
    queryFn: () =>
      fetchJson<FinanceResponse>("/api/finance/monthly?months=12", {
        cache: "no-store",
      }),
    enabled: ordersQuery.isSuccess && !ordersQuery.isFetching,
    staleTime: 0,
    refetchOnMount: "always",
  });
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
  const orders = useMemo(() => ordersQuery.data?.orders ?? [], [ordersQuery.data]);
  const productList = useMemo(
    () => (Array.isArray(productsQuery.data) ? productsQuery.data : []),
    [productsQuery.data]
  );
  const financeMonths = useMemo(
    () => (Array.isArray(financeQuery.data?.months) ? financeQuery.data.months : []),
    [financeQuery.data]
  );
  const currentMonth = financeMonths.at(-1);
  // Kullanıcı bir ay seçmediyse "bu ay" — düzeltmeler en sık içinde bulunulan ayda yapılıyor.
  const selectedRecalcMonth =
    financeMonths.some((month) => month.month === recalcMonth)
      ? recalcMonth
      : currentMonth?.month ?? "";
  const selectedRecalcBucket = financeMonths.find(
    (month) => month.month === selectedRecalcMonth
  );

  const topSellers = useMemo(() => {
    const sellers = new Map<string, { qty: number; image: string | null }>();
    for (const order of orders) {
      if (order.statusKind === "cancelled") continue;
      for (const item of order.items) {
        const current = sellers.get(item.name);
        if (current) {
          current.qty += item.quantity;
          if (!current.image && item.image) current.image = item.image;
        } else {
          sellers.set(item.name, { qty: item.quantity, image: item.image ?? null });
        }
      }
    }
    return [...sellers.entries()]
      .map(([name, value]) => ({ name, qty: value.qty, image: value.image }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 8);
  }, [orders]);
  const topSellerMax = topSellers[0]?.qty ?? 1;

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

  // KDV özeti: rakamlar motorun kayıtlı çıktısından gelir. Kapsam dışı kalan siparişler
  // (KDV'si ayrıştırılmamış) toplanmaz, kullanıcıya ayrıca söylenir.
  const vatMonths = useMemo(
    () =>
      financeMonths.map((month) => ({
        month: month.month,
        label: month.label,
        Hesaplanan: month.vat?.outputVat ?? 0,
        İndirilecek: month.vat?.inputVatCredit ?? 0,
        payable: month.vat?.payable ?? 0,
      })),
    [financeMonths]
  );
  const currentVat = currentMonth?.vat ?? null;
  const yearVat = financeQuery.data?.totals.vat ?? null;
  const hasVatData = vatMonths.some(
    (month) => month.Hesaplanan !== 0 || month.İndirilecek !== 0
  );

  const hasMonthlyData = financeMonths.some(
    (month) =>
      month.orderCount > 0 ||
      month.expenses !== 0 ||
      month.revenue !== 0 ||
      month.orderProfit !== 0
  );
  const incompleteCount = financeQuery.data?.quality.incompleteOrders ?? 0;
  const financeReady = ordersQuery.isSuccess && !ordersQuery.isFetching;
  const loading =
    ordersQuery.isLoading ||
    productsQuery.isLoading ||
    (!financeReady && !financeQuery.data && !ordersQuery.isError) ||
    financeQuery.isLoading;

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-6xl">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <BarChart3 className="h-6 w-6 text-primary" /> Raporlar
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Aylık ciro, net kâr ve satış performansının tek görünümü.
          </p>
          {financeQuery.data && (
            <p className="text-xs text-muted-foreground mt-1">
              {financeQuery.data.actualCommissionOrders > 0
                ? `${financeQuery.data.actualCommissionOrders} Trendyol siparişinde gerçek komisyon kullanılıyor.`
                : "Trendyol komisyonları henüz alınmadı."}
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
          {ordersQuery.isError && (
            <Card className="border-destructive/40">
              <CardContent className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-destructive">
                  Siparişler yenilenemedi. Finans grafiği yeni siparişlerle güncellenmedi.
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

          {financeQuery.isError && (
            <Card className="border-destructive/40">
              <CardContent className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-destructive">
                  Aylık finans verisi alınamadı. Sipariş özeti yine de aşağıda gösteriliyor.
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
            <Stat
              label="Ciro (bu ay)"
              value={currentMonth ? currentMonth.revenue : null}
              format={fmtK}
              color={PRIMARY}
              icon={ShoppingCart}
              delay={0}
            />
            <Stat
              label="Net kâr (bu ay)"
              value={currentMonth ? currentMonth.netProfit : null}
              format={fmtK}
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
              value={currentMonth ? currentMonth.expenses : null}
              format={fmtK}
              color="oklch(0.70 0.16 60)"
              icon={Receipt}
              delay={140}
            />
            <Stat
              label="Sipariş (bu ay)"
              value={currentMonth?.orderCount ?? 0}
              format={(n) => formatNumber(Math.round(n))}
              color={PRIMARY}
              icon={Trophy}
              delay={210}
            />

          </div>

          {incompleteCount > 0 && (
            <Card className="border-amber-500/40 bg-amber-500/5">
              <CardContent className="p-4 flex gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium">
                    {incompleteCount} siparişin kâr hesabı tam değil.
                  </p>
                  <p className="text-muted-foreground mt-0.5">
                    {financeQuery.data?.quality.missingProfitOrders ?? 0} siparişte maliyet
                    eksik, {financeQuery.data?.quality.partialProfitOrders ?? 0} siparişte
                    kâr kısmi. Bu dönemin net kârı bu nedenle kesin değil.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {(financeQuery.data?.quality.unsupportedCurrencyOrders ?? 0) > 0 && (
            <Card className="border-amber-500/40 bg-amber-500/5">
              <CardContent className="p-4 flex gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium">
                    {financeQuery.data?.quality.unsupportedCurrencyOrders} sipariş farklı
                    para biriminde olduğu için toplama katılmadı.
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
                  <p className="text-sm text-muted-foreground">
                    Grafik için henüz satış veya gider verisi yok.
                  </p>
                </div>
              )}
              <div className="mt-3 border-t border-border/50 pt-3 space-y-2">
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
                  {!recalcRunning && (selectedRecalcBucket?.outdatedOrders ?? 0) > 0 && (
                    <span className="text-xs text-amber-600 dark:text-amber-500">
                      Bu ayın rakamı güncel değil.
                    </span>
                  )}
                </div>

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

                {financeQuery.data?.dataFrom && (
                  <p className="text-xs text-muted-foreground">
                    Grafik {formatHistoryDate(financeQuery.data.dataFrom)} tarihinden bu yana
                    toplanan verilerle çiziliyor.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2 border-b border-border/50">
              <CardTitle className="text-sm flex items-center gap-2">
                <Percent className="h-4 w-4 text-primary" />
                KDV Özeti
                {currentMonth && (
                  <span className="ml-auto text-xs font-normal text-muted-foreground">
                    {currentMonth.label}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-4">
              {hasVatData ? (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <Stat
                      label="Hesaplanan KDV (bu ay)"
                      value={currentVat ? currentVat.outputVat : null}
                      format={fmtK}
                      color={VAT_OUT}
                      icon={Percent}
                      delay={0}
                    />
                    <Stat
                      label="İndirilecek KDV (bu ay)"
                      value={currentVat ? currentVat.inputVatCredit : null}
                      format={fmtK}
                      color={VAT_IN}
                      icon={Undo2}
                      delay={70}
                    />
                    <Stat
                      label={
                        (currentVat?.payable ?? 0) < 0
                          ? "Devreden KDV (bu ay)"
                          : "Ödenecek KDV (bu ay)"
                      }
                      value={currentVat ? Math.abs(currentVat.payable) : null}
                      format={fmtK}
                      color={PRIMARY}
                      icon={Landmark}
                      delay={140}
                    />
                  </div>

                  <div className="h-48 w-full text-muted-foreground">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={vatMonths}
                        margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="currentColor"
                          strokeOpacity={0.12}
                          vertical={false}
                        />
                        <XAxis
                          dataKey="label"
                          tick={{ fontSize: 10, fill: "currentColor" }}
                          tickLine={false}
                          axisLine={{ stroke: "currentColor", strokeOpacity: 0.15 }}
                        />
                        <YAxis
                          tick={{ fontSize: 10, fill: "currentColor" }}
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
                          formatter={(value: number, name: string) => [
                            formatCurrency(Number(value)),
                            name,
                          ]}
                        />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Bar
                          dataKey="Hesaplanan"
                          fill={VAT_OUT}
                          radius={[4, 4, 0, 0]}
                        />
                        <Bar
                          dataKey="İndirilecek"
                          fill={VAT_IN}
                          radius={[4, 4, 0, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="border-t border-border/50 pt-3 space-y-1">
                    {yearVat && (
                      <p className="text-xs text-muted-foreground">
                        Son 12 ayda{" "}
                        {yearVat.payable < 0 ? "devreden" : "ödenecek"} KDV:{" "}
                        <span className="font-medium text-foreground tabular-nums">
                          {formatCurrency(Math.abs(yearVat.payable))}
                        </span>
                      </p>
                    )}
                    {(currentVat?.payable ?? 0) < 0 && (
                      <p className="text-xs text-muted-foreground">
                        Bu ay indirilecek KDV daha yüksek — fark sonraki aya devreder.
                      </p>
                    )}
                    {(currentVat?.partialOrders ?? 0) > 0 && (
                      <p className="text-xs text-amber-600 dark:text-amber-500">
                        {currentVat?.partialOrders} siparişte maliyet eksik; indirilecek KDV
                        olduğundan düşük görünüyor.
                      </p>
                    )}
                    {(currentVat?.unknownOrders ?? 0) > 0 && (
                      <p className="text-xs text-amber-600 dark:text-amber-500">
                        {currentVat?.unknownOrders} siparişin KDV&apos;si henüz hesaplanmadı (
                        {formatCurrency(currentVat?.unknownRevenue ?? 0)} ciro) — bu ayı
                        yeniden hesapla.
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <EmptyState
                  icon={Percent}
                  title="KDV özeti için henüz veri yok"
                  description={
                    (currentVat?.unknownOrders ?? 0) > 0
                      ? `${currentVat?.unknownOrders} siparişin KDV'si henüz hesaplanmadı — bu ayı yeniden hesapla.`
                      : "Satış kaydedildikçe hesaplanan ve indirilecek KDV burada birikir."
                  }
                  className="py-8"
                />
              )}
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
              {platformChart.length > 0 && summary && summary.total.orderCount > 0 ? (
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
                  Son 30 günde sipariş verisi yok.
                </p>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2 border-b border-border/50">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Trophy className="h-4 w-4 text-amber-500" /> En Çok Satanlar (30g)
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-3">
                {topSellers.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">Veri yok.</p>
                ) : (
                  <div className="space-y-2">
                    {topSellers.map((seller, index) => (
                      <div key={seller.name} className="space-y-1">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground tabular-nums w-4 shrink-0">
                            {index + 1}.
                          </span>
                          <MiniThumb src={seller.image} />
                          <span className="truncate flex-1 min-w-0">{seller.name}</span>
                          <span className="font-semibold tabular-nums ml-2 shrink-0">
                            {seller.qty} adet
                          </span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${(seller.qty / topSellerMax) * 100}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2 border-b border-border/50">
                <CardTitle className="text-sm">
                  Ürün Kârlılığı (mevcut fiyatla)
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-3 space-y-3">
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                    <TrendingUp className="h-3.5 w-3.5 text-green-500" /> En kârlı
                  </p>
                  {profitLeaders.length === 0 ? (
                    <p className="text-xs text-muted-foreground">Maliyetli ürün yok.</p>
                  ) : (
                    profitLeaders.map((product) => (
                      <div key={product.id} className="flex items-center gap-2 text-xs py-0.5">
                        <MiniThumb src={product.imageUrl} />
                        <span className="truncate flex-1 min-w-0">{product.name}</span>
                        <span className="tabular-nums font-medium text-green-600 dark:text-green-500 ml-2 shrink-0">
                          {formatCurrency(product.currentNetProfit ?? 0)}
                          <span className="text-muted-foreground font-normal ml-1">
                            ({formatPercent(product.currentProfitMargin ?? 0)})
                          </span>
                        </span>
                      </div>
                    ))
                  )}
                </div>
                {lossMakers.length > 0 && (
                  <div className="border-t border-border/40 pt-2">
                    <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                      <TrendingDown className="h-3.5 w-3.5 text-destructive" /> Zarar
                      edenler
                    </p>
                    {lossMakers.map((product) => (
                      <div key={product.id} className="flex items-center gap-2 text-xs py-0.5">
                        <MiniThumb src={product.imageUrl} />
                        <span className="truncate flex-1 min-w-0">{product.name}</span>
                        <span className="tabular-nums font-medium text-destructive ml-2 shrink-0">
                          {formatCurrency(product.currentNetProfit ?? 0)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Özet kartı. Rakam SNAP ETMEZ, akar (AnimatedNumber) — kartlar da sırayla belirir.
 * Veri henüz yokken `value` null verilir ve animasyon yerine "—" gösterilir; 0'dan 0'a
 * anlamsız bir sayaç dönmesin.
 */
function Stat({
  label,
  value,
  format,
  color,
  icon: Icon,
  delay = 0,
}: {
  label: string;
  value: number | null;
  format: (n: number) => string;
  color: string;
  icon: React.ElementType;
  delay?: number;
}) {
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
      </CardContent>
    </Card>
  );
}
