"use client";
/* eslint-disable @next/next/no-img-element */

import { useMemo } from "react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatPercent, cn } from "@/lib/utils";
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
  byPlatform: Record<string, unknown>;
}

interface FinanceTotals {
  revenue: number;
  orderProfit: number;
  expenses: number;
  netProfit: number;
  orderCount: number;
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

function fmtK(value: number) {
  try {
    return new Intl.NumberFormat("tr-TR", {
      style: "currency",
      currency: "TRY",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `₺${Math.round(value)}`;
  }
}

function compactMoney(value: number) {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `₺${(value / 1_000_000).toFixed(1)}m`;
  if (absolute >= 1_000) return `₺${Math.round(value / 1_000)}b`;
  return `₺${Math.round(value)}`;
}

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
                ? `${financeQuery.data.actualCommissionOrders} Trendyol sipariş/paket kaydında gerçek komisyon hazır.`
                : "Trendyol komisyonları henüz platformdan alınmadı."}
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
                  <div className="text-sm">
                    <p className="font-medium">
                      Bu yenileme finans geçmişine kaydedilemedi.
                    </p>
                    <p className="text-muted-foreground mt-0.5">
                      Aylık grafik önceki kayıtları gösteriyor. Siparişleri yeniden yenile;
                      sürerse hata:{" "}
                      {ordersQuery.data.financeHistory.error ?? "bilinmiyor"}
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat
              label="Ciro (bu ay)"
              value={currentMonth ? fmtK(currentMonth.revenue) : "—"}
              color={PRIMARY}
              icon={ShoppingCart}
            />
            <Stat
              label="Net kâr (bu ay)"
              value={currentMonth ? fmtK(currentMonth.netProfit) : "—"}
              color={
                currentMonth && currentMonth.netProfit < 0
                  ? LOSS
                  : PROFIT
              }
              icon={currentMonth && currentMonth.netProfit < 0 ? TrendingDown : TrendingUp}
            />
            <Stat
              label="Gider ödemesi (bu ay)"
              value={currentMonth ? fmtK(currentMonth.expenses) : "—"}
              color="oklch(0.70 0.16 60)"
              icon={Receipt}
            />
            <Stat
              label="Sipariş (bu ay)"
              value={String(currentMonth?.orderCount ?? 0)}
              color={PRIMARY}
              icon={Trophy}
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
                    {financeQuery.data?.quality.unsupportedCurrencyOrders} sipariş TRY
                    olmadığı için toplama katılmadı.
                  </p>
                  <p className="text-muted-foreground mt-0.5">
                    Döviz tutarı TL maliyetlerle doğrudan karıştırılmadı.
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
                        tickFormatter={(value) => compactMoney(Number(value))}
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
              {financeQuery.data?.dataFrom && (
                <p className="text-xs text-muted-foreground mt-3 border-t border-border/50 pt-3">
                  Finans geçmişi {formatHistoryDate(financeQuery.data.dataFrom)} tarihinden
                  beri kaydediliyor. İlk kurulumda erişilebilen son 60 gün doldurulur ve
                  bu pencerenin iade/iptalleri yenilenir; daha eski geç değişiklikler
                  otomatik yakalanmayabilir. Sipariş kârı ilk tam hesaplandığında saklanır,
                  maliyeti eksik kayıt tamamlanınca güncellenir.
                </p>
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
                        tickFormatter={(value) => compactMoney(Number(value))}
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

function Stat({
  label,
  value,
  color,
  icon: Icon,
}: {
  label: string;
  value: string;
  color: string;
  icon: React.ElementType;
}) {
  return (
    <Card className="overflow-hidden" style={{ borderTop: `2px solid ${color}` }}>
      <CardContent className="p-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Icon className="h-4 w-4 shrink-0" style={{ color }} />
        </div>
        <div className="text-xl font-bold tabular-nums mt-1" style={{ color }}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
