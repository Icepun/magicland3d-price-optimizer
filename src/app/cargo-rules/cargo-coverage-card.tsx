"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Check, CheckCircle2, Loader2, Ruler } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";
import { clearPricingQueryCache } from "@/lib/pricing-query-cache";
import { parseDesiInput } from "@/components/products/CostEditor";

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
              Önce bunları gir — en çok satanlar (desiyi yaz, Enter):
            </p>
            <div className="flex flex-wrap gap-1.5">
              {data.top.map((u) => (
                <DesiCipi key={u.id} urun={u} />
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

/**
 * Desiyi ürün sayfasına gitmeden YERİNDE gir (9 Eki 2026 denetimi: her çip ürün sayfasına
 * götürüyordu, on ürün için on sayfa). Kayıttan sonra kapsam ve tüm kâr önbellekleri tazelenir.
 */
function DesiCipi({ urun }: { urun: { id: string; name: string; units: number } }) {
  const qc = useQueryClient();
  const [metin, setMetin] = useState("");
  const desi = parseDesiInput(metin);
  const kaydet = useMutation({
    mutationFn: (deger: number) =>
      fetchJson(`/api/products/${urun.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ desi: deger }),
      }),
    onSuccess: (_d, deger) => {
      toast.success(`${urun.name}: ${deger} desi kaydedildi`);
      void qc.invalidateQueries({ queryKey: ["cargo-coverage"] });
      clearPricingQueryCache(qc);
    },
    onError: (e) => toast.error(e instanceof Error && e.message ? e.message : "Desi kaydedilemedi"),
  });
  const gonder = () => {
    if (desi != null && !kaydet.isPending) kaydet.mutate(desi);
  };
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border bg-background/60 py-0.5 pl-2 pr-0.5 text-[11px] transition-colors focus-within:border-primary/50">
      <Link href={`/products/${urun.id}`} className="truncate max-w-[180px] hover:underline" title="Ürün sayfasını aç">
        {urun.name}
      </Link>
      <span className="tabular-nums text-muted-foreground">{urun.units} adet</span>
      <input
        value={metin}
        onChange={(e) => setMetin(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") gonder();
        }}
        inputMode="decimal"
        placeholder="desi"
        aria-label={`${urun.name} desisi`}
        className="h-6 w-12 rounded-full border bg-background px-2 text-center tabular-nums outline-none focus:border-primary/50"
      />
      <button
        type="button"
        onClick={gonder}
        disabled={desi == null || kaydet.isPending}
        aria-label="Desiyi kaydet"
        className="flex h-6 w-6 items-center justify-center rounded-full text-primary transition-colors hover:bg-primary/10 disabled:opacity-30"
      >
        {kaydet.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
      </button>
    </span>
  );
}
