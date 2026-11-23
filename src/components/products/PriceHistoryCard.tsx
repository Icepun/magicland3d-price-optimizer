"use client";

import { fetchJson } from "@/lib/fetch-json";
import { memo } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { LineChart as LineChartIcon, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { formatCurrency, cn } from "@/lib/utils";

// recharts ağır → grafik alanı görününce dinamik yükle (Ürün detay initial bundle'ında değil).
// Yüklenene dek aynı yükseklikte skeleton → boş ekran/layout kayması yok.
const PriceHistoryChart = dynamic(
  () => import("./PriceHistoryChart").then((m) => m.PriceHistoryChart),
  { ssr: false, loading: () => <Skeleton className="h-[240px] w-full" /> }
);

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
  shopify_sync: { label: "Shopify", color: "#34D399" }, // yeşil
  trendyol_sync: { label: "Trendyol", color: "#F27A1A" }, // Trendyol turuncusu (marka rengi)
  hepsiburada_sync: { label: "Hepsiburada", color: "#4F8CFF" }, // turuncu-kırmızı (HB)
  manual: { label: "Manuel", color: "#C9D2F2" }, // mor
};

function sourceMeta(src: string) {
  return SOURCE_META[src] ?? { label: src, color: "#C9D2F2" };
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
  const { data, isLoading, isError, refetch, isFetching } = useQuery<PriceHistoryEntry[]>({
    queryKey: ["price-history", productId],
    queryFn: () =>
      fetchJson(`/api/products/${productId}/price-history?days=365&limit=300`),
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
      className="detay-kart rounded-2xl animate-in fade-in slide-in-from-bottom-2 duration-500"
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
        ) : isError && history.length === 0 ? (
          // Hata "geçmiş yok" gibi gösterilmez — yeniden denetir.
          <div className="flex flex-col items-center gap-2.5 py-10 text-center text-sm text-muted-foreground">
            Fiyat geçmişi şu an yüklenemedi.
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-foreground ring-1 ring-white/10 transition hover:bg-white/[0.1] active:scale-[0.97] disabled:opacity-60"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} /> Tekrar dene
            </button>
          </div>
        ) : history.length === 0 ? (
          <EmptyState
            icon={LineChartIcon}
            title="Henüz fiyat değişimi kaydedilmedi"
            description="Otomatik fiyat tazelemede ya da manuel düzenlemede fiyat değiştikçe burada Shopify ve Trendyol için ayrı trend grafiği oluşur."
          />
        ) : (
          <>
            <PriceHistoryChart chartData={chartData} sources={sources} resolveSource={sourceMeta} />

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
                            up ? "text-emerald-400" : "text-rose-400"
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
