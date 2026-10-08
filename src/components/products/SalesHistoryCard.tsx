"use client";

import { useQuery } from "@tanstack/react-query";
import { ShoppingBag } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { fetchJson } from "@/lib/fetch-json";
import { formatNumber } from "@/lib/format";
import { stokKacGunYeter, type UrunSatisOzeti } from "@/lib/urun-satis";

/** Platform renkleri — Panel ve fiyat geçmişiyle aynı aile. */
const PLATFORM: Record<string, { ad: string; renk: string }> = {
  shopify: { ad: "Shopify", renk: "oklch(0.60 0.16 152)" },
  trendyol: { ad: "Trendyol", renk: "oklch(0.72 0.17 60)" },
  hepsiburada: { ad: "Hepsiburada", renk: "oklch(0.64 0.21 30)" },
  manual: { ad: "Manuel", renk: "oklch(0.62 0.20 278)" },
};
const SIRA = ["shopify", "trendyol", "hepsiburada", "manual"];

/**
 * SATIŞ GEÇMİŞİ — son 6 ay platform başına adet, satış hızı ve "stok kaç gün yeter".
 * 9 Eki 2026 denetimi: ürün detayında fiyat geçmişi vardı, satış geçmişi yoktu.
 * Bilinmeyen ≠ sıfır: alınamazsa "alınamadı", geçmiş kısaysa hız yerine açıklama.
 */
export function SalesHistoryCard({ productId, stok }: { productId: string; stok: number | null }) {
  const { data, isLoading, isError, refetch, isFetching } = useQuery<UrunSatisOzeti>({
    queryKey: ["product-sales", productId],
    queryFn: ({ signal }) => fetchJson(`/api/products/${productId}/sales`, { signal }),
    staleTime: 5 * 60_000,
  });
  const enCok = Math.max(1, ...(data?.aylar.map((a) => a.toplam) ?? [0]));
  // Sayfadaki CANLI stokla (stok burada +/− ile değişebiliyor; sunucunun okuduğu an bayatlar).
  const stokGunu = data ? stokKacGunYeter(stok, data.kacGundeBir) : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <ShoppingBag className="h-4 w-4 text-primary" />
          Satış Geçmişi
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-[150px] w-full" />
        ) : isError || !data ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
            <span>Satış geçmişi alınamadı.</span>
            <Button size="sm" variant="outline" disabled={isFetching} onClick={() => void refetch()}>
              Tekrar dene
            </Button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Ozet ust="Son 90 gün" alt={`${formatNumber(data.son90Adet)} adet`} />
              <Ozet
                ust="Satış hızı"
                alt={
                  !data.hazir
                    ? "Geçmiş henüz kısa"
                    : data.kacGundeBir == null
                      ? "Bu dönemde satmadı"
                      : data.kacGundeBir < 1
                        ? `Günde ~${formatNumber(1 / data.kacGundeBir, 1)} adet`
                        : `~${formatNumber(data.kacGundeBir, 1)} günde bir`
                }
              />
              <Ozet
                ust="Stok kaç gün yeter"
                alt={
                  stok == null
                    ? "Sipariş üzerine"
                    : stokGunu == null
                      ? "—"
                      : stokGunu < 1
                        ? "Stok yok"
                        : `~${formatNumber(Math.round(stokGunu))} gün`
                }
                vurgu={stokGunu != null && stokGunu < 14}
              />
            </div>
            <div className="flex h-[110px] items-end gap-3" role="img" aria-label="Son 6 ayın aylık satış adetleri">
              {data.aylar.map((a) => (
                <div key={a.ay} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                  <span className="text-[11px] tabular-nums text-muted-foreground">{a.toplam || ""}</span>
                  <div
                    className="flex w-full max-w-[44px] flex-col-reverse overflow-hidden rounded-sm bg-muted/40"
                    style={{ height: `${Math.max(2, (a.toplam / enCok) * 72)}px` }}
                    title={SIRA.filter((p) => a.adet[p]).map((p) => `${PLATFORM[p].ad}: ${a.adet[p]}`).join(" · ") || "Satış yok"}
                  >
                    {SIRA.filter((p) => a.adet[p]).map((p) => (
                      <div key={p} style={{ height: `${(a.adet[p] / Math.max(1, a.toplam)) * 100}%`, backgroundColor: PLATFORM[p].renk }} />
                    ))}
                  </div>
                  <span className="text-[11px] text-muted-foreground">{a.etiket}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              {SIRA.map((p) => (
                <span key={p} className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: PLATFORM[p].renk }} />
                  {PLATFORM[p].ad}
                </span>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Ozet({ ust, alt, vurgu }: { ust: string; alt: string; vurgu?: boolean }) {
  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{ust}</p>
      <p className={vurgu ? "text-sm font-semibold text-amber-500" : "text-sm font-semibold"}>{alt}</p>
    </div>
  );
}
