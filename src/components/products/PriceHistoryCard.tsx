"use client";

import { memo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { LineChart as LineChartIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { formatCurrency, cn } from "@/lib/utils";

interface PriceHistoryEntry {
  id: string;
  productId: string;
  oldPrice: number;
  newPrice: number;
  changeSource: string;
  changedAt: string;
  note: string | null;
}

/** changeSource → platform etiketi + renk (Shopify yeşil, Trendyol turuncu, manuel mor). */
const SOURCE_META: Record<string, { label: string; color: string }> = {
  shopify_sync: { label: "Shopify", color: "oklch(0.60 0.16 152)" },
  trendyol_sync: { label: "Trendyol", color: "oklch(0.72 0.17 60)" },
  manual: { label: "Manuel", color: "oklch(0.62 0.20 278)" },
};

function sourceMeta(src: string) {
  return SOURCE_META[src] ?? { label: src, color: "oklch(0.62 0.20 278)" };
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit" });
}
function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// memo: Recharts grafiği pahalı — detay cache'i her değişince (madeToOrder/maliyet) yeniden çizilmesin.
export const PriceHistoryCard = memo(PriceHistoryCardImpl);
function PriceHistoryCardImpl({ productId }: { productId: string }) {
  const { data, isLoading } = useQuery<PriceHistoryEntry[]>({
    queryKey: ["price-history", productId],
    queryFn: () =>
      fetch(`/api/products/${productId}/price-history?days=365&limit=300`).then((r) => r.json()),
  });

  const history = Array.isArray(data) ? data : [];
  const sources = Array.from(new Set(history.map((h) => h.changeSource)));

  // Her kayıt bir nokta: kaydın kaynağına newPrice yazılır, diğer seriler null kalır
  // (connectNulls ile çizgiler köprülenir → platform başına ayrı çizgi).
  const chartData: Record<string, number | string>[] = history.map((h) => ({
    label: fmtDate(h.changedAt),
    [h.changeSource]: h.newPrice,
  }));

  return (
    <Card
      className="animate-in fade-in slide-in-from-bottom-2 duration-500"
      style={{ animationDelay: "80ms", animationFillMode: "both" }}
    >
      <CardHeader className="pb-3 border-b border-border/50">
        <CardTitle className="text-sm flex items-center gap-2">
          <LineChartIcon className="h-4 w-4 text-primary" />
          Fiyat Geçmişi
          {history.length > 0 && (
            <Badge variant="outline" className="ml-1 tabular-nums">
              {history.length} değişim
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        {isLoading ? (
          <Skeleton className="h-[240px] w-full" />
        ) : history.length === 0 ? (
          <EmptyState
            icon={LineChartIcon}
            title="Henüz fiyat değişimi kaydedilmedi"
            description="Otomatik fiyat tazelemede ya da manuel düzenlemede fiyat değiştikçe burada Shopify ve Trendyol için ayrı trend grafiği oluşur."
          />
        ) : (
          <>
            <div className="h-[240px] w-full text-muted-foreground">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
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
                    minTickGap={20}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "currentColor" }}
                    tickLine={false}
                    axisLine={false}
                    width={56}
                    domain={["auto", "auto"]}
                    tickFormatter={(v) => `₺${Math.round(Number(v))}`}
                  />
                  <RTooltip
                    contentStyle={{
                      background: "oklch(0.2 0.02 278)",
                      border: "1px solid oklch(1 0 0 / 12%)",
                      borderRadius: 8,
                      fontSize: 12,
                      color: "oklch(0.95 0 0)",
                    }}
                    labelStyle={{ color: "oklch(0.85 0 0)", marginBottom: 4 }}
                    formatter={(value: number, name: string) => [
                      formatCurrency(Number(value)),
                      sourceMeta(name).label,
                    ]}
                  />
                  <Legend
                    formatter={(value) => sourceMeta(String(value)).label}
                    wrapperStyle={{ fontSize: 11 }}
                  />
                  {sources.map((src) => (
                    <Line
                      key={src}
                      type="monotone"
                      dataKey={src}
                      name={src}
                      stroke={sourceMeta(src).color}
                      strokeWidth={2}
                      dot={{ r: 2.5 }}
                      activeDot={{ r: 4 }}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Son değişimler tablosu — en yeni üstte */}
            <div className="mt-4">
              {[...history]
                .reverse()
                .slice(0, 12)
                .map((h) => {
                  const meta = sourceMeta(h.changeSource);
                  const pct = h.oldPrice > 0 ? ((h.newPrice - h.oldPrice) / h.oldPrice) * 100 : 0;
                  const up = h.newPrice >= h.oldPrice;
                  return (
                    <div
                      key={h.id}
                      className="flex items-center justify-between py-1.5 text-xs border-b border-border/30 last:border-0"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ backgroundColor: meta.color }}
                        />
                        <span className="text-muted-foreground tabular-nums shrink-0">
                          {fmtDateTime(h.changedAt)}
                        </span>
                        <span
                          className="text-[10px] uppercase tracking-wider font-medium shrink-0"
                          style={{ color: meta.color }}
                        >
                          {meta.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 tabular-nums shrink-0">
                        <span className="text-muted-foreground">{formatCurrency(h.oldPrice)}</span>
                        <span className="text-muted-foreground/50">→</span>
                        <span className="font-medium">{formatCurrency(h.newPrice)}</span>
                        <span
                          className={cn(
                            "font-medium w-16 text-right",
                            up ? "text-green-500" : "text-destructive"
                          )}
                        >
                          {up ? "+" : ""}
                          {pct.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  );
                })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
