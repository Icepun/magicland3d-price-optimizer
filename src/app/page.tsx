"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Package,
  AlertTriangle,
  TrendingDown,
  TrendingUp,
  Sparkles,
  DollarSign,
  ArrowRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import Link from "next/link";

interface DashboardData {
  totalProducts: number;
  activeProducts: number;
  inStockCount: number;
  outOfStockCount: number;
  missingCost: number;
  negativeProfitCount: number;
  belowMinimumCount: number;
  optimizableCount: number;
  currentTotalProfit: number;
  optimizedTotalProfit: number;
  potentialIncrease: number;
  problemProducts: {
    id: string;
    name: string;
    currentSalePrice: number;
    problem: string;
    profit: number | null;
    margin: number | null;
  }[];
  opportunityProducts: {
    id: string;
    name: string;
    currentSalePrice: number;
    recommendedPrice: number;
    currentProfit: number;
    recommendedProfit: number;
    profitDifference: number;
  }[];
}

const PROBLEM_LABELS: Record<
  string,
  { label: string; variant: "destructive" | "secondary" | "outline" }
> = {
  missing_cost:    { label: "Maliyet Eksik", variant: "secondary" },
  negative_profit: { label: "Zarar Eden",    variant: "destructive" },
  below_minimum:   { label: "Min. Altında",  variant: "outline" },
};

/* Mor-mavi palette aksanları */
const ACCENTS = {
  primary:  "oklch(0.62 0.20 278)",  /* mor-mavi */
  amber:    "oklch(0.75 0.18 75)",   /* sarı */
  red:      "oklch(0.63 0.22 25)",   /* kırmızı */
  violet:   "oklch(0.68 0.22 305)",  /* leylak */
  green:    "oklch(0.72 0.18 145)",  /* yeşil */
};

function StatCard({
  title,
  value,
  sub,
  icon: Icon,
  accentColor,
  delay = 0,
}: {
  title: string;
  value: React.ReactNode;
  sub?: string;
  icon: React.ElementType;
  accentColor: string;
  delay?: number;
}) {
  return (
    <Card
      className="overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-500"
      style={{
        animationDelay: `${delay}ms`,
        animationFillMode: "both",
        borderTop: `2px solid ${accentColor}`,
      }}
    >
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <div
          className="rounded-lg p-2"
          style={{ backgroundColor: `${accentColor.replace(")", " / 12%)")}` }}
        >
          <Icon className="h-4 w-4" style={{ color: accentColor }} />
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold" style={{ color: accentColor }}>
          {value}
        </div>
        {sub && (
          <p className="text-xs text-muted-foreground mt-1">{sub}</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const { data, isLoading, error } = useQuery<DashboardData>({
    queryKey: ["dashboard"],
    queryFn: () => fetch("/api/dashboard").then((r) => r.json()),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-3">
        <div
          className="w-5 h-5 rounded-full border-2 animate-spin"
          style={{
            borderColor: "oklch(1 0 0 / 10%)",
            borderTopColor: ACCENTS.primary,
          }}
        />
        <p className="text-muted-foreground text-sm">Yükleniyor…</p>
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
      {/* Başlık */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Dashboard
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Genel bakış ve kâr özeti
        </p>
      </div>

      {/* Üst istatistik kartları */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Toplam Ürün"
          value={data.totalProducts}
          sub={`Stokta ${data.inStockCount} / Biten ${data.outOfStockCount}`}
          icon={Package}
          accentColor={ACCENTS.primary}
          delay={0}
        />
        <StatCard
          title="Maliyet Eksik"
          value={data.missingCost}
          icon={AlertTriangle}
          accentColor={ACCENTS.amber}
          delay={60}
        />
        <StatCard
          title="Zarar Eden"
          value={data.negativeProfitCount}
          icon={TrendingDown}
          accentColor={ACCENTS.red}
          delay={120}
        />
        <StatCard
          title="Optimize Edilebilir"
          value={data.optimizableCount}
          icon={Sparkles}
          accentColor={ACCENTS.violet}
          delay={180}
        />
      </div>

      {/* Kâr özet kartları */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card
          className="animate-in fade-in slide-in-from-bottom-2 duration-500"
          style={{ animationDelay: "240ms", animationFillMode: "both" }}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              Mevcut Tahmini Kâr
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">
              {formatCurrency(data.currentTotalProfit)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Tüm aktif ürünler toplam
            </p>
          </CardContent>
        </Card>

        <Card
          className="animate-in fade-in slide-in-from-bottom-2 duration-500"
          style={{
            animationDelay: "300ms",
            animationFillMode: "both",
            borderTop: `2px solid ${ACCENTS.green}`,
          }}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4" style={{ color: ACCENTS.green }} />
              Optimize Edilmiş Tahmini Kâr
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" style={{ color: ACCENTS.green }}>
              {formatCurrency(data.optimizedTotalProfit)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Öneriler uygulanırsa
            </p>
          </CardContent>
        </Card>

        <Card
          className="animate-in fade-in slide-in-from-bottom-2 duration-500"
          style={{
            animationDelay: "360ms",
            animationFillMode: "both",
            borderTop: `2px solid ${ACCENTS.violet}`,
          }}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Sparkles className="h-4 w-4" style={{ color: ACCENTS.violet }} />
              Potansiyel Artış
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className="text-2xl font-bold"
              style={{
                color: data.potentialIncrease > 0 ? ACCENTS.violet : undefined,
              }}
            >
              {data.potentialIncrease > 0 ? "+" : ""}
              {formatCurrency(data.potentialIncrease)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Kazanılabilecek ek kâr
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Sorunlu ürünler + En iyi fırsatlar */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card
          className="animate-in fade-in slide-in-from-bottom-2 duration-500"
          style={{ animationDelay: "420ms", animationFillMode: "both" }}
        >
          <CardHeader className="border-b border-border/50 pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" style={{ color: ACCENTS.amber }} />
              Problemli Ürünler
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3">
            {data.problemProducts.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                Problem bulunamadı.
              </p>
            ) : (
              <div className="space-y-0.5">
                {data.problemProducts.map((p) => {
                  const pb = PROBLEM_LABELS[p.problem] ?? {
                    label: p.problem,
                    variant: "outline" as const,
                  };
                  return (
                    <Link key={p.id} href={`/products/${p.id}`}>
                      <div className="flex items-center justify-between py-2.5 px-3 -mx-3 rounded-lg cursor-pointer transition-all duration-150 hover:bg-muted/40 group border-l-2 border-transparent hover:border-primary/50">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate group-hover:text-foreground transition-colors">
                            {p.name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatCurrency(p.currentSalePrice)}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 ml-3">
                          {p.profit !== null && (
                            <span
                              className="text-xs font-medium"
                              style={{
                                color: p.profit < 0 ? ACCENTS.red : undefined,
                              }}
                            >
                              {formatCurrency(p.profit)}
                            </span>
                          )}
                          <Badge variant={pb.variant} className="text-xs">
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

        <Card
          className="animate-in fade-in slide-in-from-bottom-2 duration-500"
          style={{ animationDelay: "480ms", animationFillMode: "both" }}
        >
          <CardHeader className="border-b border-border/50 pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              En İyi Fırsatlar
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3">
            {data.opportunityProducts.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                Fırsat bulunamadı.{" "}
                <Link
                  href="/recommendations"
                  className="text-primary underline underline-offset-2 hover:opacity-80 transition-opacity"
                >
                  Simülasyon çalıştırın
                </Link>
                .
              </p>
            ) : (
              <div className="space-y-0.5">
                {data.opportunityProducts.map((p) => (
                  <Link key={p.id} href={`/products/${p.id}`}>
                    <div className="flex items-center justify-between py-2.5 px-3 -mx-3 rounded-lg cursor-pointer transition-all duration-150 hover:bg-muted/40 group border-l-2 border-transparent hover:border-green-500/50">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate group-hover:text-foreground transition-colors">
                          {p.name}
                        </p>
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          {formatCurrency(p.currentSalePrice)}
                          <ArrowRight className="h-3 w-3" />
                          {formatCurrency(p.recommendedPrice)}
                        </p>
                      </div>
                      <div className="text-right shrink-0 ml-3">
                        <p
                          className="text-sm font-semibold"
                          style={{ color: ACCENTS.green }}
                        >
                          +{formatCurrency(p.profitDifference)}
                        </p>
                        <p className="text-xs text-muted-foreground">kâr artışı</p>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
