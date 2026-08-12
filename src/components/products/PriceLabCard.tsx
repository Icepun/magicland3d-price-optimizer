"use client";

import { memo, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Target, Tag, AlertTriangle, TrendingUp, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { formatCurrency, formatPercent, cn } from "@/lib/utils";
import type { PriceLab } from "@/lib/client-pricing";

/** Ürünler listesinde hesaplanan "küçük zam, büyük kazanç" önerisi. */
export interface PriceThresholdInfo {
  platform: string;
  currentPrice: number;
  targetPrice: number;
  currentProfit: number;
  targetProfit: number;
  gain: number;
}

const PLATFORM = {
  shopify: { label: "Shopify", color: "oklch(0.60 0.16 152)" },
  trendyol: { label: "Trendyol", color: "oklch(0.72 0.17 60)" },
} as const;

function platformInfo(p: string) {
  return PLATFORM[p as keyof typeof PLATFORM] ?? { label: p, color: "oklch(0.62 0.20 278)" };
}

/**
 * Eşik önerisi ürün listesiyle BİRLİKTE hesaplanıp önbelleğe düşer; burada yeniden hesaplanmaz
 * (bu kart hiçbir zaman sunucuya istek atmaz). Liste henüz açılmamışsa öneri gösterilmez.
 */
function useCachedThreshold(): PriceThresholdInfo | null {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const productId = pathname?.startsWith("/products/") ? pathname.split("/")[2] : undefined;
  if (!productId) return null;
  const caches = queryClient.getQueriesData<
    Array<{ id: string; priceThreshold?: PriceThresholdInfo | null }>
  >({ queryKey: ["products"] });
  for (const [, list] of caches) {
    if (!Array.isArray(list)) continue;
    const found = list.find((p) => p?.id === productId);
    if (found?.priceThreshold) return found.priceThreshold;
  }
  return null;
}

/** Hesap hazır olana kadar kartın kendi iskeleti — boş/donuk alan bırakmaz. */
function TargetsSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true">
      <Skeleton className="h-3.5 w-52" />
      {[0, 1].map((row) => (
        <div
          key={row}
          className="space-y-2 animate-in fade-in duration-500"
          style={{ animationDelay: `${row * 90}ms`, animationFillMode: "both" }}
        >
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-36" />
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {[0, 1, 2, 3].map((cell) => (
              <Skeleton key={cell} className="h-12 rounded-lg" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// İSTEMCİDE hesaplanır (parent → computeClientPricing) ve `data` prop'uyla gelir → sunucuya istek YOK.
// memo: parent her render olduğunda değil, yalnız `data` referansı değişince yeniden çizilir.
export const PriceLabCard = memo(PriceLabCardImpl);
function PriceLabCardImpl({
  data,
  threshold,
  failed,
  onRetry,
  assumptionNotes,
}: {
  data: PriceLab | undefined;
  /** Dışarıdan verilirse bu kullanılır; verilmezse ürün listesi önbelleğinden okunur. */
  threshold?: PriceThresholdInfo | null;
  /** Hesap için gereken kurallar çekilemedi → iskelet sonsuza kadar dönmesin, durumu söyle. */
  failed?: boolean;
  onRetry?: () => void;
  /**
   * Fiyatın hangi varsayımla çıktığını söyleyen uyarılar. Kartın İÇİNDE, önerilen fiyatların
   * hemen üstünde gösterilir — kullanıcı rakamı ve dayanağını aynı yerde okur.
   * (Slot: uyarılar sayfadaki kâr önizlemesinden türüyor, kart onları kendi hesaplamıyor.)
   */
  assumptionNotes?: ReactNode;
}) {
  // Kurallar başarısızsa `data` sonsuza kadar undefined kalır → önce hatayı göster, sonra iskeleti.
  const isLoading = !failed && data === undefined; // kurallar/maliyet henüz hazır değil → iskelet
  const cachedThreshold = useCachedThreshold();
  const hint = threshold ?? cachedThreshold;

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
        {failed ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center animate-in fade-in duration-300">
            <span className="rounded-full bg-amber-500/10 p-2.5">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
            </span>
            <p className="text-sm text-muted-foreground max-w-xs">
              Fiyat önerileri hesaplanamadı.
            </p>
            {onRetry && (
              <Button
                variant="outline"
                size="sm"
                className="gap-2 transition-transform active:scale-95"
                onClick={onRetry}
              >
                <RefreshCw className="h-3.5 w-3.5" /> Tekrar dene
              </Button>
            )}
          </div>
        ) : isLoading ? (
          <TargetsSkeleton />
        ) : !data?.hasCost ? (
          <div className="flex items-center gap-2 text-sm text-amber-500 py-2 animate-in fade-in duration-300">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Maliyet girilmeden hedef fiyat hesaplanamaz.
          </div>
        ) : (
          <div className="space-y-5">
            {/* Eşik uyarısı — küçük zam, belirgin kazanç. Yalnızca anlamlı fark varsa görünür. */}
            {hint && (
              <div className="flex items-center gap-2 rounded-lg border border-green-500/40 bg-green-500/10 px-3 py-2 text-sm text-green-400 animate-in fade-in slide-in-from-top-1 duration-300">
                <TrendingUp className="h-4 w-4 shrink-0" />
                <span>
                  Fiyatı{" "}
                  <AnimatedNumber
                    value={hint.targetPrice}
                    durationMs={420}
                    format={(n) => formatCurrency(n)}
                    className="font-bold tabular-nums"
                  />{" "}
                  yaparsan kâr{" "}
                  <AnimatedNumber
                    value={hint.gain}
                    durationMs={420}
                    format={(n) => `+${formatCurrency(n)}`}
                    className="font-bold tabular-nums"
                  />
                </span>
              </div>
            )}

            {/* Hedef marj → fiyat */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-2.5">
                <Target className="h-3.5 w-3.5" /> Hedef marj için satış fiyatı (KDV dahil)
              </p>
              {/* Fiyatın dayandığı varsayım rakamların HEMEN üstünde — kartın dışında değil. */}
              {assumptionNotes}
              <div className="space-y-3">
                {(data.targets ?? []).map((t, ti) => {
                  const info = platformInfo(t.platform);
                  return (
                    <div
                      key={t.platform}
                      className="animate-in fade-in slide-in-from-bottom-1 duration-500"
                      style={{ animationDelay: `${ti * 90}ms`, animationFillMode: "both" }}
                    >
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
                              {/* Hesaplanamayan fiyat NaN → "—" (BİLİNMEYEN ≠ SIFIR); geri kalanı akar. */}
                              <AnimatedNumber
                                value={r.price ?? NaN}
                                durationMs={420}
                                format={(n) => formatCurrency(n)}
                                className={cn(
                                  "block text-xs font-bold tabular-nums mt-0.5 transition-colors",
                                  tone === "green"
                                    ? "text-green-500"
                                    : tone === "red"
                                      ? "text-destructive"
                                      : "text-foreground"
                                )}
                              />
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
                  {data.campaign.rows.map((r, ri) => {
                    const loss = r.profit < 0;
                    return (
                      <div
                        key={r.discount}
                        className="animate-in fade-in slide-in-from-left-1 duration-300"
                        style={{ animationDelay: `${ri * 45}ms`, animationFillMode: "both" }}
                      >
                        <div
                          className={cn(
                            "grid grid-cols-4 gap-2 text-xs tabular-nums px-1 py-1 rounded transition-colors",
                            loss && "bg-destructive/10"
                          )}
                        >
                          <span className="font-medium">%{r.discount}</span>
                          <AnimatedNumber
                            value={r.effectivePrice}
                            durationMs={380}
                            format={(n) => formatCurrency(n)}
                            className="text-right text-muted-foreground"
                          />
                          <AnimatedNumber
                            value={r.profit}
                            durationMs={380}
                            format={(n) => formatCurrency(n)}
                            className={cn("text-right font-semibold", loss ? "text-destructive" : "text-green-500")}
                          />
                          <span className={cn("text-right", loss && "text-destructive")}>{formatPercent(r.margin)}</span>
                        </div>
                        {/* Kâr bu satırda ARTMIŞ görünebilir — sayı doğru, sebebi kargonun el
                            değiştirmesi. Açıklamasız bırakılırsa hesap hatası sanılır. */}
                        {r.crossesFreeShipping && (
                          <p className="px-1 pb-1 text-[10px] leading-snug text-amber-400">
                            Bu fiyatta sepet 150₺&apos;nin altına iniyor — kargo sana kalmıyor, kâr bu yüzden yükseliyor.
                          </p>
                        )}
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
