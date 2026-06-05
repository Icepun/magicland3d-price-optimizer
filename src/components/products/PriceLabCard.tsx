"use client";

import { memo } from "react";
import { FlaskConical, Target, Tag, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatPercent, cn } from "@/lib/utils";
import type { PriceLab } from "@/lib/client-pricing";

const PLATFORM = {
  shopify: { label: "Shopify", color: "oklch(0.60 0.16 152)" },
  trendyol: { label: "Trendyol", color: "oklch(0.72 0.17 60)" },
} as const;

function platformInfo(p: string) {
  return PLATFORM[p as keyof typeof PLATFORM] ?? { label: p, color: "oklch(0.62 0.20 278)" };
}

// İSTEMCİDE hesaplanır (parent → computeClientPricing) ve `data` prop'uyla gelir → sunucuya istek YOK.
// memo: parent her render olduğunda değil, yalnız `data` referansı değişince yeniden çizilir.
export const PriceLabCard = memo(PriceLabCardImpl);
function PriceLabCardImpl({ data }: { data: PriceLab | undefined }) {
  const isLoading = data === undefined; // kurallar/maliyet henüz hazır değil → iskelet

  return (
    <Card
      className="animate-in fade-in slide-in-from-bottom-2 duration-500"
      style={{ animationDelay: "40ms", animationFillMode: "both" }}
    >
      <CardHeader className="pb-3 border-b border-border/50">
        <CardTitle className="text-sm flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-primary" />
          Fiyat Laboratuvarı
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : !data?.hasCost ? (
          <div className="flex items-center gap-2 text-sm text-amber-500 py-2">
            <AlertTriangle className="h-4 w-4" />
            Maliyet girilmemiş — hedef fiyat hesaplanamıyor. Önce üretim maliyetini kaydet.
          </div>
        ) : (
          <div className="space-y-5">
            {/* Hedef marj → fiyat */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-2.5">
                <Target className="h-3.5 w-3.5" /> Hedef marj için satış fiyatı (KDV dahil)
              </p>
              <div className="space-y-3">
                {(data.targets ?? []).map((t) => {
                  const info = platformInfo(t.platform);
                  return (
                    <div key={t.platform}>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-medium" style={{ color: info.color }}>
                          {info.label}
                        </span>
                        <span className="text-[11px] text-muted-foreground tabular-nums">
                          Şu an {formatCurrency(t.currentPrice)} · marj {formatPercent(t.currentMargin)}
                        </span>
                      </div>
                      <div className="grid grid-cols-4 gap-1.5">
                        {t.rows.map((r) => {
                          // Renk: hedef fiyatı güncel satış fiyatıyla kıyasla. ±%5 içinde → nötr;
                          // %5'ten UCUZA satılabiliyorsa (hedef < güncel) → yeşil (rahat ulaşılır);
                          // %5'ten PAHALI gerekiyorsa (hedef > güncel) → kırmızı (şu an bu marja yetmiyor).
                          const cur = t.currentPrice;
                          let tone: "neutral" | "green" | "red" = "neutral";
                          if (r.price != null && cur > 0) {
                            if (r.price > cur * 1.05) tone = "red";
                            else if (r.price < cur * 0.95) tone = "green";
                          }
                          return (
                            <div
                              key={r.margin}
                              className={cn(
                                "rounded-lg border px-2 py-1.5 text-center transition-colors",
                                tone === "green"
                                  ? "border-green-500/40 bg-green-500/10"
                                  : tone === "red"
                                    ? "border-destructive/40 bg-destructive/10"
                                    : "border-border bg-muted/30"
                              )}
                            >
                              <div className="text-[10px] text-muted-foreground">%{r.margin} marj</div>
                              <div
                                className={cn(
                                  "text-xs font-bold tabular-nums mt-0.5",
                                  tone === "green"
                                    ? "text-green-600 dark:text-green-500"
                                    : tone === "red"
                                      ? "text-destructive"
                                      : "text-foreground"
                                )}
                              >
                                {r.price != null ? formatCurrency(r.price) : "—"}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Shopify kampanya simülatörü */}
            {data.campaign && (
              <div className="border-t border-border/50 pt-4">
                <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-2.5">
                  <Tag className="h-3.5 w-3.5" /> Shopify kampanya — {formatCurrency(data.campaign.currentPrice)} üzerinden
                </p>
                <div className="space-y-1">
                  <div className="grid grid-cols-4 gap-2 text-[10px] uppercase tracking-wider text-muted-foreground/70 px-1">
                    <span>İndirim</span>
                    <span className="text-right">Etkin fiyat</span>
                    <span className="text-right">Net kâr</span>
                    <span className="text-right">Marj</span>
                  </div>
                  {data.campaign.rows.map((r) => {
                    const loss = r.profit < 0;
                    return (
                      <div
                        key={r.discount}
                        className={cn(
                          "grid grid-cols-4 gap-2 text-xs tabular-nums px-1 py-1 rounded",
                          loss && "bg-destructive/10"
                        )}
                      >
                        <span className="font-medium">%{r.discount}</span>
                        <span className="text-right text-muted-foreground">{formatCurrency(r.effectivePrice)}</span>
                        <span className={cn("text-right font-semibold", loss ? "text-destructive" : "text-green-600 dark:text-green-500")}>
                          {formatCurrency(r.profit)}
                        </span>
                        <span className={cn("text-right", loss && "text-destructive")}>{formatPercent(r.margin)}</span>
                      </div>
                    );
                  })}
                </div>
                <p className="text-[10px] text-muted-foreground/70 mt-2">
                  Kırmızı satır = o indirimde zarara geçiyorsun.
                </p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
