"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Package,
  AlertTriangle,
  TrendingDown,
  TrendingUp,
  Sparkles,
  DollarSign,
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
  {
    label: string;
    variant: "destructive" | "secondary" | "outline";
  }
> = {
  missing_cost: { label: "Maliyet Eksik", variant: "secondary" },
  negative_profit: { label: "Zarar Eden", variant: "destructive" },
  below_minimum: { label: "Min. Altında", variant: "outline" },
};

export default function DashboardPage() {
  const { data, isLoading, error } = useQuery<DashboardData>({
    queryKey: ["dashboard"],
    queryFn: () => fetch("/api/dashboard").then((r) => r.json()),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Yükleniyor...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6">
        <p className="text-destructive">Dashboard verileri yüklenemedi.</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Toplam Ürün
            </CardTitle>
            <Package className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.totalProducts}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Stokta {data.inStockCount} / biten {data.outOfStockCount}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Maliyet Eksik
            </CardTitle>
            <AlertTriangle className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-500">
              {data.missingCost}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Zarar Eden
            </CardTitle>
            <TrendingDown className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">
              {data.negativeProfitCount}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Optimize Edilebilir
            </CardTitle>
            <Sparkles className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-500">
              {data.optimizableCount}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <DollarSign className="h-4 w-4" /> Mevcut Tahmini Kâr
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(data.currentTotalProfit)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Tüm aktif ürünler toplam
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-green-500" /> Optimize
              Edilmiş Tahmini Kâr
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {formatCurrency(data.optimizedTotalProfit)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Öneriler uygulanırsa
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-blue-500" /> Potansiyel Artış
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold ${data.potentialIncrease > 0 ? "text-green-600" : "text-muted-foreground"}`}
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Problemli Ürünler</CardTitle>
          </CardHeader>
          <CardContent>
            {data.problemProducts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Problem bulunamadı.
              </p>
            ) : (
              <div className="space-y-1">
                {data.problemProducts.map((p) => {
                  const pb = PROBLEM_LABELS[p.problem] ?? {
                    label: p.problem,
                    variant: "outline" as const,
                  };
                  return (
                    <Link key={p.id} href={`/products/${p.id}`}>
                      <div className="flex items-center justify-between py-2 hover:bg-muted/50 rounded px-2 -mx-2 cursor-pointer">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {p.name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatCurrency(p.currentSalePrice)}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {p.profit !== null && (
                            <span
                              className={`text-xs font-medium ${p.profit < 0 ? "text-destructive" : ""}`}
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

        <Card>
          <CardHeader>
            <CardTitle className="text-base">En İyi Fırsatlar</CardTitle>
          </CardHeader>
          <CardContent>
            {data.opportunityProducts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Fırsat bulunamadı.{" "}
                <Link
                  href="/recommendations"
                  className="text-primary underline"
                >
                  Simülasyon çalıştırın
                </Link>
                .
              </p>
            ) : (
              <div className="space-y-1">
                {data.opportunityProducts.map((p) => (
                  <Link key={p.id} href={`/products/${p.id}`}>
                    <div className="flex items-center justify-between py-2 hover:bg-muted/50 rounded px-2 -mx-2 cursor-pointer">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{p.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatCurrency(p.currentSalePrice)} →{" "}
                          {formatCurrency(p.recommendedPrice)}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-medium text-green-600">
                          +{formatCurrency(p.profitDifference)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          kâr artışı
                        </p>
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
