"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Package,
  AlertTriangle,
  TrendingDown,
  DollarSign,
  ShoppingBag,
  ShieldCheck,
  PackageX,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatPercent } from "@/lib/utils";
import Link from "next/link";

type Platform = "shopify" | "trendyol";

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

const PLATFORM_INFO: Record<Platform, { label: string; color: string; icon: React.ElementType }> = {
  shopify: { label: "Shopify", color: "oklch(0.60 0.16 152)", icon: ShoppingBag },
  trendyol: { label: "Trendyol", color: "oklch(0.72 0.17 60)", icon: ShieldCheck },
};

const PROBLEM_LABELS: Record<
  string,
  { label: string; variant: "destructive" | "secondary" | "outline" }
> = {
  missing_cost: { label: "Maliyet Eksik", variant: "secondary" },
  negative_profit: { label: "Zarar", variant: "destructive" },
  below_minimum: { label: "Min. Altında", variant: "outline" },
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
  const Icon = info.icon;

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
            <Icon className="h-4 w-4" style={{ color: info.color }} />
            <span style={{ color: info.color }}>{info.label}</span>
          </CardTitle>
          <Badge variant="outline" className="text-xs tabular-nums">
            {stats.activeListings} listing
          </Badge>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-muted-foreground">Toplam Kâr</span>
            <span
              className="text-lg font-bold tabular-nums"
              style={{ color: stats.totalProfit < 0 ? ACCENTS.red : info.color }}
            >
              {formatCurrency(stats.totalProfit)}
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-muted-foreground">Ortalama Marj</span>
            <span className="text-sm font-medium tabular-nums">
              {formatPercent(stats.averageMargin)}
            </span>
          </div>
          {stats.negativeProfitCount > 0 && (
            <div className="flex items-baseline justify-between pt-1 border-t border-border/50">
              <span className="text-xs text-destructive flex items-center gap-1">
                <TrendingDown className="h-3 w-3" />
                Zarar Eden
              </span>
              <span className="text-sm font-bold text-destructive tabular-nums">
                {stats.negativeProfitCount}
              </span>
            </div>
          )}
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
        <p className="text-destructive text-sm">Dashboard verileri yüklenemedi.</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 animate-in fade-in duration-300">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Ürünler 3 platformda ne kadar kâr veya zarar ettiriyor — net durum.
        </p>
      </div>

      {/* Genel Stat'lar */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Toplam Ürün"
          value={data.totalProducts}
          sub={`Stokta ${data.inStockCount} · Biten ${data.outOfStockCount}`}
          icon={Package}
          accentColor={ACCENTS.primary}
          delay={0}
          href="/products"
        />
        <StatCard
          title="Maliyet Eksik"
          value={data.missingCost}
          sub="Net kâr hesabı yapılamıyor"
          icon={AlertTriangle}
          accentColor={ACCENTS.amber}
          delay={60}
          href="/products?filter=missing-cost"
        />
        <StatCard
          title="Zarar Eden Listings"
          value={data.negativeListings}
          sub="Acil müdahale gerek"
          icon={TrendingDown}
          accentColor={ACCENTS.red}
          delay={120}
          href="/products?filter=negative-profit"
        />
        <StatCard
          title="Toplam Tahmini Kâr"
          value={formatCurrency(data.grandTotalProfit)}
          sub="3 platform toplam"
          icon={DollarSign}
          accentColor={ACCENTS.green}
          delay={180}
        />
      </div>

      {/* Platform Bazlı Kartlar */}
      <div>
        <h2 className="text-base font-semibold mb-3">Platform Bazlı Özet</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {data.platforms.map((p, i) => (
            <PlatformCard key={p.platform} stats={p} delay={240 + i * 60} />
          ))}
        </div>
      </div>

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
