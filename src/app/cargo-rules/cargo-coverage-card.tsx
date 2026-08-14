"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, CheckCircle2, Ruler } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";

interface Kapsam {
  measuredDays: number;
  soldProducts: number;
  missingProducts: number;
  soldUnits: number;
  missingUnits: number;
  maxDesi: number | null;
  top: { id: string; name: string; units: number }[];
}

/**
 * KARGO KAPSAMI — "kargo maliyeti hangi ürünlerde tahmine dayanıyor?"
 *
 * Kurallar doğru olsa bile ürünün DESİSİ girilmemişse kargo bedeli tahmin ediliyor ve o
 * siparişin kârı tahmine dayanıyor. Sayfa bunu hiç söylemiyordu. Ölçüldü (14 Ağu 2026):
 * satan 108 üründen 39'unda desi yoktu; satılan 411 adedin 94'ü bu ürünlerden.
 *
 * Liste bilerek KISA: en çok satan birkaç ürünün desisini girmek açığın büyük kısmını
 * kapatıyor. Uzun bir "eksikler" listesi kimseyi harekete geçirmez.
 */
export function CargoCoverageCard() {
  const { data, isLoading } = useQuery<Kapsam>({
    queryKey: ["cargo-coverage"],
    queryFn: () => fetchJson<Kapsam>("/api/cargo-rules/coverage"),
    staleTime: 5 * 60_000,
  });

  if (isLoading) return <Skeleton className="h-28 rounded-xl" />;
  if (!data) return null;

  const oran = data.soldUnits > 0 ? (data.missingUnits / data.soldUnits) * 100 : 0;
  const temiz = data.missingProducts === 0;

  return (
    <Card className={cn(temiz ? "border-green-500/30 bg-green-500/5" : "border-amber-500/40 bg-amber-500/5")}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start gap-2.5">
          {temiz ? (
            <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">
              {temiz
                ? "Satan ürünlerin desisi eksiksiz"
                : `${data.missingProducts} üründe desi girilmemiş`}
            </p>
            <p className="text-[11px] text-muted-foreground mt-0.5 tabular-nums">
              {temiz
                ? `Son ${data.measuredDays} günde satan ${data.soldProducts} ürünün hepsinde desi var; kargo bedeli tahmin edilmiyor.`
                : `Son ${data.measuredDays} günde satılan ${data.soldUnits} adedin ${data.missingUnits}'i (%${oran.toFixed(0)}) bu ürünlerden. Desisi olmayan üründe kargo bedeli TAHMİN ediliyor, dolayısıyla kârı da tahmini.`}
            </p>
          </div>
        </div>

        {data.top.length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted-foreground">
              Önce bunları gir — en çok satanlar:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {data.top.map((u) => (
                <Link
                  key={u.id}
                  href={`/products/${u.id}`}
                  className="inline-flex items-center gap-1.5 rounded-full border bg-background/60 px-2 py-1 text-[11px] hover:border-primary/40 transition-colors"
                  title="Ürün sayfasında desiyi gir"
                >
                  <span className="truncate max-w-[190px]">{u.name}</span>
                  <span className="tabular-nums text-muted-foreground">{u.units} adet</span>
                  <ArrowRight className="h-3 w-3 shrink-0" />
                </Link>
              ))}
            </div>
          </div>
        )}

        {data.maxDesi != null && (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Ruler className="h-3.5 w-3.5 shrink-0" />
            Ürünlerinin en büyüğü {data.maxDesi} desi — kuralların bunun üstündeki baremleri
            pratikte kullanılmıyor.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
