"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Package,
  AlertTriangle,
  TrendingDown,
  TrendingUp,
  Activity,
  ClipboardList,
  ArrowRight,
  PackageX,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatPercent, cn } from "@/lib/utils";
import Link from "next/link";
import { PlatformLogo } from "@/components/PlatformLogo";

type Platform = "shopify" | "trendyol" | "hepsiburada";

interface PlatformStats {
  platform: Platform;
  activeListings: number;
  totalProfit: number;
  averageMargin: number;
  negativeProfitCount: number;
  thinMarginCount: number;
}

interface DashboardData {
  totalProducts: number;
  inStockCount: number;
  outOfStockCount: number;
  lowStockCount: number;
  lowStockProducts: {
    id: string;
    name: string;
    stock: number;
    imageUrl: string | null;
  }[];
  missingCost: number;
  negativeListings: number;
  grandTotalProfit: number;
  platforms: PlatformStats[];
  problemProducts: {
    id: string;
    name: string;
    listingId?: string;
    platform?: Platform;
    salePrice: number;
    problem: string;
    profit: number | null;
    margin: number | null;
  }[];
}

const PLATFORM_INFO: Record<Platform, { label: string; color: string }> = {
  shopify: { label: "Shopify", color: "oklch(0.60 0.16 152)" },
  trendyol: { label: "Trendyol", color: "oklch(0.72 0.17 60)" },
  hepsiburada: { label: "Hepsiburada", color: "oklch(0.66 0.19 38)" },
};

const PROBLEM_LABELS: Record<
  string,
  { label: string; variant: "destructive" | "secondary" | "outline" }
> = {
  missing_cost: { label: "Maliyet Eksik", variant: "secondary" },
  negative_profit: { label: "Zarar", variant: "destructive" },
};

const ACCENTS = {
  primary: "oklch(0.62 0.20 278)",
  amber: "oklch(0.75 0.18 75)",
  red: "oklch(0.63 0.22 25)",
  green: "oklch(0.72 0.18 145)",
};

function StatCard({
  title,
  value,
  sub,
  icon: Icon,
  accentColor,
  delay = 0,
  href,
}: {
  title: string;
  value: React.ReactNode;
  sub?: string;
  icon: React.ElementType;
  accentColor: string;
  delay?: number;
  href?: string;
}) {
  const card = (
    <Card
      className={`overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-500 ${
        href ? "cursor-pointer transition-transform hover:-translate-y-0.5" : ""
      }`}
      style={{
        animationDelay: `${delay}ms`,
        animationFillMode: "both",
        borderTop: `2px solid ${accentColor}`,
      }}
    >
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <div
          className="rounded-lg p-2"
          style={{ backgroundColor: `${accentColor.replace(")", " / 12%)")}` }}
        >
          <Icon className="h-4 w-4" style={{ color: accentColor }} />
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums" style={{ color: accentColor }}>
          {value}
        </div>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );

  return href ? <Link href={href}>{card}</Link> : card;
}

function PlatformCard({ stats, delay }: { stats: PlatformStats; delay: number }) {
  const info = PLATFORM_INFO[stats.platform];

  return (
    <Link href={`/products?platform=${stats.platform}`}>
      <Card
        className="overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-500 cursor-pointer hover:-translate-y-0.5 transition-transform"
        style={{
          animationDelay: `${delay}ms`,
          animationFillMode: "both",
          borderLeft: `3px solid ${info.color}`,
        }}
      >
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <PlatformLogo platform={stats.platform} className="h-4 w-4" style={{ color: info.color }} />
            <span style={{ color: info.color }}>{info.label}</span>
          </CardTitle>
          <Badge variant="outline" className="text-xs tabular-nums">
            {stats.activeListings} listing
          </Badge>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-muted-foreground">Ortalama Marj</span>
            <span
              className="text-lg font-bold tabular-nums"
              style={{ color: stats.averageMargin < 0 ? ACCENTS.red : info.color }}
            >
              {formatPercent(stats.averageMargin)}
            </span>
          </div>
          <div className="flex items-baseline justify-between pt-1 border-t border-border/50">
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <TrendingDown className="h-3 w-3" />
              Zarar Eden
            </span>
            <span
              className="text-sm font-bold tabular-nums"
              style={{ color: stats.negativeProfitCount > 0 ? ACCENTS.red : undefined }}
            >
              {stats.negativeProfitCount} / {stats.activeListings}
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

interface PriceChangeItem {
  productId: string;
  productName: string;
  firstPrice: number;
  lastPrice: number;
  changePercent: number;
  changeCount: number;
  lastChangedAt: string;
}

interface PriceChangesData {
  days: number;
  totalChanges: number;
  productsAffected: number;
  recent: PriceChangeItem[];
}

function PriceChangesCard({ delay }: { delay: number }) {
  const { data } = useQuery<PriceChangesData>({
    queryKey: ["price-changes"],
    queryFn: () => fetch("/api/dashboard/price-changes?days=30&limit=8").then((r) => r.json()),
    refetchInterval: 60_000,
    staleTime: 0,
  });

  if (!data || data.totalChanges === 0) return null;

  return (
    <Card
      className="animate-in fade-in slide-in-from-bottom-2 duration-500"
      style={{ animationDelay: `${delay}ms`, animationFillMode: "both" }}
    >
      <CardHeader className="border-b border-border/50 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4" style={{ color: ACCENTS.primary }} />
          Son {data.days} Gün Fiyat Hareketleri
          <Badge variant="outline" className="ml-1 tabular-nums">
            {data.totalChanges} değişim · {data.productsAffected} ürün
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-3">
        <div className="space-y-0.5">
          {data.recent.map((item) => {
            const up = item.changePercent >= 0;
            return (
              <Link key={item.productId} href={`/products/${item.productId}`}>
                <div className="flex items-center justify-between py-2 px-3 -mx-3 rounded-lg cursor-pointer transition-all duration-150 hover:bg-muted/40 group">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm truncate group-hover:text-foreground transition-colors">
                      {item.productName}
                    </p>
                    <p className="text-[11px] text-muted-foreground tabular-nums mt-0.5">
                      {formatCurrency(item.firstPrice)} → {formatCurrency(item.lastPrice)}
                      {item.changeCount > 1 && (
                        <span className="ml-1.5 opacity-70">· {item.changeCount}×</span>
                      )}
                    </p>
                  </div>
                  <div
                    className={cn(
                      "flex items-center gap-1 text-sm font-bold tabular-nums shrink-0 ml-3",
                      up ? "text-green-500" : "text-destructive"
                    )}
                  >
                    {up ? (
                      <TrendingUp className="h-3.5 w-3.5" />
                    ) : (
                      <TrendingDown className="h-3.5 w-3.5" />
                    )}
                    {up ? "+" : ""}
                    {item.changePercent.toFixed(1)}%
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

interface OrdersSummaryBucket {
  revenue: number;
  profit: number;
  orderCount: number;
}
interface OrdersSummary {
  days: number;
  shopify: OrdersSummaryBucket;
  trendyol: OrdersSummaryBucket;
  hepsiburada: OrdersSummaryBucket;
  total: OrdersSummaryBucket;
}

function fmtTL(n: number) {
  try {
    return new Intl.NumberFormat("tr-TR", {
      style: "currency",
      currency: "TRY",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `₺${Math.round(n)}`;
  }
}

function OrdersSummaryCard({ delay }: { delay: number }) {
  const { data, isLoading } = useQuery<{ summary?: OrdersSummary }>({
    queryKey: ["orders"],
    queryFn: () => fetch("/api/orders").then((r) => r.json()),
    staleTime: 5 * 60_000,
  });
  const s = data?.summary;

  if (isLoading && !s) {
    return (
      <div
        className="animate-in fade-in slide-in-from-bottom-2 duration-500"
        style={{ animationDelay: `${delay}ms`, animationFillMode: "both" }}
      >
        <Skeleton className="h-[132px] w-full rounded-xl" />
      </div>
    );
  }
  if (!s) return null;

  const profitPos = s.total.profit >= 0;
  const rows: { platform: Platform; bucket: OrdersSummaryBucket }[] = [
    { platform: "shopify", bucket: s.shopify },
    { platform: "trendyol", bucket: s.trendyol },
    { platform: "hepsiburada", bucket: s.hepsiburada },
  ];

  return (
    <Link href="/orders" className="group block">
      <Card
        className="overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-500 cursor-pointer transition-transform hover:-translate-y-0.5"
        style={{
          animationDelay: `${delay}ms`,
          animationFillMode: "both",
          borderTop: `2px solid ${ACCENTS.primary}`,
        }}
      >
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <ClipboardList className="h-4 w-4" style={{ color: ACCENTS.primary }} />
              Son {s.days} Gün Siparişleri
            </h2>
            <span className="text-[11px] text-primary flex items-center gap-0.5 transition-transform group-hover:translate-x-0.5">
              Tümünü gör <ArrowRight className="h-3 w-3" />
            </span>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            {/* Toplam ciro */}
            <div>
              <p className="text-[11px] text-muted-foreground">Toplam ciro</p>
              <p className="text-2xl font-bold tabular-nums leading-tight" style={{ color: ACCENTS.primary }}>
                {fmtTL(s.total.revenue)}
              </p>
              <p className="text-[11px] text-muted-foreground tabular-nums mt-0.5">{s.total.orderCount} sipariş</p>
            </div>

            {/* Net kâr */}
            <div className="sm:border-l sm:border-border/50 sm:pl-4">
              <p className="text-[11px] text-muted-foreground">Net kâr</p>
              <p
                className="text-2xl font-bold tabular-nums leading-tight"
                style={{ color: profitPos ? ACCENTS.green : ACCENTS.red }}
              >
                {profitPos ? "+" : ""}
                {fmtTL(s.total.profit)}
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">tahmini</p>
            </div>

            {/* Shopify + Trendyol kırılımı */}
            {rows.map(({ platform, bucket }) => {
              const info = PLATFORM_INFO[platform];
              return (
                <div key={platform} className="sm:border-l sm:border-border/50 sm:pl-4">
                  <p className="text-[11px] flex items-center gap-1.5">
                    <PlatformLogo platform={platform} className="h-3 w-3" style={{ color: info.color }} />
                    <span style={{ color: info.color }} className="font-medium">
                      {info.label}
                    </span>
                  </p>
                  <p className="text-xl font-bold tabular-nums leading-tight mt-0.5">{fmtTL(bucket.revenue)}</p>
                  <p className="text-[11px] text-muted-foreground tabular-nums mt-0.5">{bucket.orderCount} sipariş</p>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function DashboardPage() {
  const { data, isLoading, error } = useQuery<DashboardData>({
    queryKey: ["dashboard"],
    queryFn: () => fetch("/api/dashboard").then((r) => r.json()),
    refetchInterval: 60_000,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-6 animate-in fade-in duration-300">
        <div>
          <Skeleton className="h-7 w-32 mb-1.5" />
          <Skeleton className="h-3 w-48" />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-8 w-8 rounded-lg" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-16 mb-2" />
                <Skeleton className="h-3 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6">
        <p className="text-destructive text-sm">Panel verileri yüklenemedi.</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 animate-in fade-in duration-300">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Panel</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Shopify ve Trendyol&apos;da ürünlerin net kâr/zarar durumu — tek bakışta.
        </p>
      </div>

      {/* Sipariş bazlı ciro/kâr — son 30 gün (öne çıkan) */}
      <OrdersSummaryCard delay={0} />

      {/* Genel Stat'lar */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <StatCard
          title="Toplam Ürün"
          value={data.totalProducts}
          sub={`Stokta ${data.inStockCount} · Biten ${data.outOfStockCount}`}
          icon={Package}
          accentColor={ACCENTS.primary}
          delay={60}
          href="/products"
        />
        <StatCard
          title="Maliyet Eksik"
          value={data.missingCost}
          sub="Net kâr hesabı yapılamıyor"
          icon={AlertTriangle}
          accentColor={ACCENTS.amber}
          delay={120}
          href="/products?filter=missing-cost"
        />
        <StatCard
          title="Zarar Eden Listings"
          value={data.negativeListings}
          sub="Acil müdahale gerek"
          icon={TrendingDown}
          accentColor={ACCENTS.red}
          delay={180}
          href="/products?filter=negative-profit"
        />
      </div>

      {/* Platform Bazlı Kartlar */}
      <div>
        <h2 className="text-base font-semibold mb-3">Platform Bazlı Özet</h2>
        <div className="space-y-3">
          {/* Üst: pazaryerleri (Trendyol + Hepsiburada) yan yana */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {data.platforms
              .filter((p) => p.platform === "trendyol" || p.platform === "hepsiburada")
              .map((p, i) => (
                <PlatformCard key={p.platform} stats={p} delay={240 + i * 60} />
              ))}
          </div>
          {/* Alt: Shopify (ana kaynak) ortalı, bir kart genişliğinde */}
          {data.platforms
            .filter((p) => p.platform === "shopify")
            .map((p) => (
              <div key={p.platform} className="md:flex md:justify-center">
                <div className="md:w-[calc(50%-0.375rem)]">
                  <PlatformCard stats={p} delay={360} />
                </div>
              </div>
            ))}
        </div>
      </div>

      <PriceChangesCard delay={340} />

      {/* Düşük Stok Uyarısı */}
      {data.lowStockCount > 0 && (
        <Card
          className="animate-in fade-in slide-in-from-bottom-2 duration-500 border-amber-500/30"
          style={{ animationDelay: "400ms", animationFillMode: "both" }}
        >
          <CardHeader className="border-b border-border/50 pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <PackageX className="h-4 w-4" style={{ color: ACCENTS.amber }} />
              Düşük Stok Uyarısı
              <Badge variant="outline" className="ml-1 tabular-nums">
                {data.lowStockCount}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
              {data.lowStockProducts.map((p) => (
                <Link key={p.id} href={`/products/${p.id}`}>
                  <div className="flex items-center justify-between py-2 px-3 rounded-lg cursor-pointer transition-all duration-150 hover:bg-muted/40 group border border-transparent hover:border-amber-500/20">
                    <span className="text-sm truncate group-hover:text-foreground transition-colors flex-1 min-w-0">
                      {p.name}
                    </span>
                    <Badge
                      variant="outline"
                      className={`ml-2 shrink-0 tabular-nums ${
                        p.stock === 0
                          ? "border-destructive/40 text-destructive bg-destructive/10"
                          : "border-amber-500/40 text-amber-500 bg-amber-500/10"
                      }`}
                    >
                      {p.stock === 0 ? "Bitti" : `${p.stock} adet`}
                    </Badge>
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Problemli Ürünler */}
      <Card
        className="animate-in fade-in slide-in-from-bottom-2 duration-500"
        style={{ animationDelay: "460ms", animationFillMode: "both" }}
      >
        <CardHeader className="border-b border-border/50 pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" style={{ color: ACCENTS.amber }} />
            Acil Müdahale Gereken Listings
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-3">
          {data.problemProducts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              ✓ Tüm aktif listings sağlıklı.
            </p>
          ) : (
            <div className="space-y-0.5">
              {data.problemProducts.map((p, idx) => {
                const pb =
                  PROBLEM_LABELS[p.problem] ?? {
                    label: p.problem,
                    variant: "outline" as const,
                  };
                const platformInfo = p.platform ? PLATFORM_INFO[p.platform] : null;
                return (
                  <Link key={`${p.id}-${p.listingId ?? idx}`} href={`/products/${p.id}`}>
                    <div className="flex items-center justify-between py-2.5 px-3 -mx-3 rounded-lg cursor-pointer transition-all duration-150 hover:bg-muted/40 group">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate group-hover:text-foreground transition-colors flex items-center gap-2">
                          {platformInfo && (
                            <span
                              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold shrink-0"
                              style={{
                                backgroundColor: `${platformInfo.color.replace(
                                  ")",
                                  " / 15%)"
                                )}`,
                                color: platformInfo.color,
                              }}
                            >
                              {platformInfo.label}
                            </span>
                          )}
                          {p.name}
                        </p>
                        <p className="text-xs text-muted-foreground tabular-nums mt-0.5">
                          {formatCurrency(p.salePrice)}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 ml-3">
                        {p.profit !== null && (
                          <div className="text-right tabular-nums">
                            <p
                              className="text-xs font-medium"
                              style={{
                                color: p.profit < 0 ? ACCENTS.red : undefined,
                              }}
                            >
                              {formatCurrency(p.profit)}
                            </p>
                            {p.margin !== null && (
                              <p className="text-[10px] text-muted-foreground">
                                {formatPercent(p.margin)}
                              </p>
                            )}
                          </div>
                        )}
                        <Badge variant={pb.variant} className="text-xs shrink-0">
                          {pb.label}
                        </Badge>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
