"use client";
/* eslint-disable @next/next/no-img-element */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ResponsiveContainer, Cell } from "recharts";
import { BarChart3, TrendingUp, TrendingDown, ShoppingCart, Trophy, Package } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatPercent, cn } from "@/lib/utils";
import { thumbUrl } from "@/lib/image";

interface SummaryBucket { revenue: number; profit: number; orderCount: number }
interface OrdersResp {
  orders: { platform: "shopify" | "trendyol" | "hepsiburada"; items: { name: string; quantity: number; image?: string | null }[]; total: number }[];
  summary: { days: number; shopify: SummaryBucket; trendyol: SummaryBucket; hepsiburada: SummaryBucket; total: SummaryBucket };
}
interface ProductRow {
  id: string;
  name: string;
  imageUrl: string | null;
  currentNetProfit: number | null;
  currentProfitMargin: number | null;
  hasCost: boolean;
}

/** Liste satırlarındaki küçük ürün görseli — tanımayı kolaylaştırır; görsel yoksa kutu ikonu. */
function MiniThumb({ src, size = "h-6 w-6" }: { src: string | null | undefined; size?: string }) {
  return (
    <span className={cn("inline-flex items-center justify-center rounded-md border bg-muted/40 overflow-hidden shrink-0", size)}>
      {src ? (
        <img src={thumbUrl(src) ?? undefined} alt="" loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <Package className="h-3 w-3 text-muted-foreground/40" />
      )}
    </span>
  );
}

const SHOPIFY = "oklch(0.60 0.16 152)";
const TRENDYOL = "oklch(0.72 0.17 60)";
const HEPSIBURADA = "oklch(0.66 0.19 38)";
const PRIMARY = "oklch(0.62 0.20 278)";

function fmtK(n: number) {
  try {
    return new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", maximumFractionDigits: 0 }).format(n);
  } catch {
    return `₺${Math.round(n)}`;
  }
}

export default function ReportsPage() {
  const { data: ordersData, isLoading: ordersLoading } = useQuery<OrdersResp>({
    queryKey: ["orders"],
    queryFn: () => fetch("/api/orders").then((r) => r.json()),
    staleTime: 5 * 60_000,
  });
  const { data: products, isLoading: productsLoading } = useQuery<ProductRow[]>({
    // Aktif ürünler (~442KB) — Ürünler/Üretim/Filament ile AYNI key → tek fetch, sayfalar arası paylaşılır.
    queryKey: ["products", "active"],
    queryFn: () => fetch("/api/products?filter=active").then((r) => r.json()),
    staleTime: 60_000,
  });

  const summary = ordersData?.summary;
  const orders = useMemo(() => ordersData?.orders ?? [], [ordersData]);
  const productList = useMemo(() => (Array.isArray(products) ? products : []), [products]);

  const topSellers = useMemo(() => {
    const m = new Map<string, { qty: number; image: string | null }>();
    for (const o of orders)
      for (const it of o.items) {
        const cur = m.get(it.name);
        if (cur) { cur.qty += it.quantity; if (!cur.image && it.image) cur.image = it.image; }
        else m.set(it.name, { qty: it.quantity, image: it.image ?? null });
      }
    return [...m.entries()].map(([name, v]) => ({ name, qty: v.qty, image: v.image })).sort((a, b) => b.qty - a.qty).slice(0, 8);
  }, [orders]);
  const topSellerMax = topSellers[0]?.qty ?? 1;

  const profitLeaders = useMemo(
    () => productList.filter((p) => p.hasCost && p.currentNetProfit != null).sort((a, b) => (b.currentNetProfit ?? 0) - (a.currentNetProfit ?? 0)).slice(0, 6),
    [productList]
  );
  const lossMakers = useMemo(
    () => productList.filter((p) => p.currentNetProfit != null && (p.currentNetProfit ?? 0) < 0).sort((a, b) => (a.currentNetProfit ?? 0) - (b.currentNetProfit ?? 0)).slice(0, 6),
    [productList]
  );

  // useMemo: veri değişmedikçe AYNI dizi referansı → recharts BarChart gereksiz yere yeniden çizmez.
  const platformChart = useMemo(
    () =>
      summary
        ? [
            { platform: "Shopify", Ciro: Math.round(summary.shopify.revenue), Kâr: Math.round(summary.shopify.profit), color: SHOPIFY },
            { platform: "Trendyol", Ciro: Math.round(summary.trendyol.revenue), Kâr: Math.round(summary.trendyol.profit), color: TRENDYOL },
            { platform: "Hepsiburada", Ciro: Math.round(summary.hepsiburada.revenue), Kâr: Math.round(summary.hepsiburada.profit), color: HEPSIBURADA },
          ]
        : [],
    [summary]
  );

  const loading = ordersLoading || productsLoading;

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-primary" /> Raporlar
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Son {summary?.days ?? 30} günün satış & kâr özeti, en çok satanlar ve ürün kârlılığı.
        </p>
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          {/* Stat row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Ciro (30g)" value={summary ? fmtK(summary.total.revenue) : "—"} color={PRIMARY} icon={ShoppingCart} />
            <Stat
              label="Net kâr (30g)"
              value={summary ? fmtK(summary.total.profit) : "—"}
              color={summary && summary.total.profit >= 0 ? "oklch(0.72 0.18 145)" : "oklch(0.63 0.22 25)"}
              icon={TrendingUp}
            />
            <Stat label="Sipariş" value={String(summary?.total.orderCount ?? 0)} color={PRIMARY} icon={ShoppingCart} />
            <Stat
              label="Ort. sepet"
              value={summary && summary.total.orderCount > 0 ? fmtK(summary.total.revenue / summary.total.orderCount) : "—"}
              color={PRIMARY}
              icon={Trophy}
            />
          </div>

          {/* Platform karşılaştırma */}
          <Card>
            <CardHeader className="pb-2 border-b border-border/50">
              <CardTitle className="text-sm">Platform Karşılaştırma — Ciro & Net Kâr</CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              {platformChart.length > 0 && summary && summary.total.orderCount > 0 ? (
                <div className="h-56 w-full text-muted-foreground">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={platformChart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.12} vertical={false} />
                      <XAxis dataKey="platform" tick={{ fontSize: 12, fill: "currentColor" }} tickLine={false} axisLine={{ stroke: "currentColor", strokeOpacity: 0.15 }} />
                      <YAxis tick={{ fontSize: 11, fill: "currentColor" }} tickLine={false} axisLine={false} width={56} tickFormatter={(v) => `₺${Math.round(Number(v) / 1000)}k`} />
                      <RTooltip
                        contentStyle={{ background: "oklch(0.2 0.02 278)", border: "1px solid oklch(1 0 0 / 12%)", borderRadius: 8, fontSize: 12, color: "oklch(0.95 0 0)" }}
                        formatter={(v: number) => formatCurrency(Number(v))}
                      />
                      <Bar dataKey="Ciro" radius={[4, 4, 0, 0]}>
                        {platformChart.map((d, i) => (
                          <Cell key={i} fill={d.color} />
                        ))}
                      </Bar>
                      <Bar dataKey="Kâr" radius={[4, 4, 0, 0]} fill={PRIMARY} fillOpacity={0.55} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground py-6 text-center">Son 30 günde sipariş verisi yok.</p>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* En çok satanlar */}
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
                    {topSellers.map((s, i) => (
                      <div key={s.name} className="space-y-1">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground tabular-nums w-4 shrink-0">{i + 1}.</span>
                          <MiniThumb src={s.image} />
                          <span className="truncate flex-1 min-w-0">{s.name}</span>
                          <span className="font-semibold tabular-nums ml-2 shrink-0">{s.qty} adet</span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${(s.qty / topSellerMax) * 100}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Kâr liderleri + zarar */}
            <Card>
              <CardHeader className="pb-2 border-b border-border/50">
                <CardTitle className="text-sm">Ürün Kârlılığı (mevcut fiyatla)</CardTitle>
              </CardHeader>
              <CardContent className="pt-3 space-y-3">
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                    <TrendingUp className="h-3.5 w-3.5 text-green-500" /> En kârlı
                  </p>
                  {profitLeaders.length === 0 ? (
                    <p className="text-xs text-muted-foreground">Maliyetli ürün yok.</p>
                  ) : (
                    profitLeaders.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 text-xs py-0.5">
                        <MiniThumb src={p.imageUrl} />
                        <span className="truncate flex-1 min-w-0">{p.name}</span>
                        <span className="tabular-nums font-medium text-green-600 dark:text-green-500 ml-2 shrink-0">
                          {formatCurrency(p.currentNetProfit ?? 0)}
                          <span className="text-muted-foreground font-normal ml-1">({formatPercent(p.currentProfitMargin ?? 0)})</span>
                        </span>
                      </div>
                    ))
                  )}
                </div>
                {lossMakers.length > 0 && (
                  <div className="border-t border-border/40 pt-2">
                    <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                      <TrendingDown className="h-3.5 w-3.5 text-destructive" /> Zarar edenler
                    </p>
                    {lossMakers.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 text-xs py-0.5">
                        <MiniThumb src={p.imageUrl} />
                        <span className="truncate flex-1 min-w-0">{p.name}</span>
                        <span className="tabular-nums font-medium text-destructive ml-2 shrink-0">{formatCurrency(p.currentNetProfit ?? 0)}</span>
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

function Stat({ label, value, color, icon: Icon }: { label: string; value: string; color: string; icon: React.ElementType }) {
  return (
    <Card className="overflow-hidden" style={{ borderTop: `2px solid ${color}` }}>
      <CardContent className="p-3.5">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Icon className="h-4 w-4" style={{ color }} />
        </div>
        <div className="text-xl font-bold tabular-nums mt-1" style={{ color }}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
