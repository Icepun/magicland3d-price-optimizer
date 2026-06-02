"use client";
/* eslint-disable @next/next/no-img-element */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Factory, Package, Disc3, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

interface ProductRow {
  id: string;
  name: string;
  imageUrl: string | null;
  stock: number;
  madeToOrder?: boolean;
  cost?: { filamentWeight: number | null } | null;
}

export default function PlannerPage() {
  const { data, isLoading } = useQuery<ProductRow[]>({
    queryKey: ["products", "planner"],
    queryFn: () => fetch("/api/products?filter=active").then((r) => r.json()),
    staleTime: 60_000,
  });
  const products = useMemo(() => (Array.isArray(data) ? data : []), [data]);

  // Hedef stok DB'de (AppSetting) saklanır → masaüstü/telefon senkron
  const qc = useQueryClient();
  const { data: settings } = useQuery<Record<string, string>>({
    queryKey: ["settings"],
    queryFn: () => fetch("/api/settings").then((r) => r.json()),
    staleTime: 60_000,
  });
  const savedTarget = Math.max(1, Number(settings?.plannerTargetStock) || 5);
  const [override, setOverride] = useState<number | null>(null);
  const target = override ?? savedTarget;
  const saveTarget = useMutation({
    mutationFn: (v: number) =>
      fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plannerTargetStock: String(v) }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  const plan = useMemo(() => {
    return products
      // "Sipariş üzerine üretilir" ürünler stok tutmaz → üretim planına girmez.
      .filter((p) => !p.madeToOrder && p.stock < target)
      .map((p) => {
        const printQty = Math.max(1, target - p.stock);
        const gramPer = p.cost?.filamentWeight ?? 0;
        return { ...p, printQty, filament: printQty * gramPer, gramPer };
      })
      .sort((a, b) => a.stock - b.stock);
  }, [products, target]);

  const totalFilament = plan.reduce((s, p) => s + p.filament, 0);
  const totalPrints = plan.reduce((s, p) => s + p.printQty, 0);

  return (
    <div className="p-6 space-y-5 max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Factory className="h-6 w-6 text-primary" /> Üretim Planı
            <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/12 text-primary border border-primary/25">
              Demo
            </span>
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Stoğu hedefin altındaki ürünler — ne basmalısın + gereken filament. (Demo: şimdilik stoğa
            göre; ileride açık siparişleri de katarız.)
          </p>
        </div>
        <div className="shrink-0">
          <Label className="text-[11px] text-muted-foreground">Hedef stok</Label>
          <Input
            type="number"
            min="1"
            value={target}
            onChange={(e) => {
              const v = Math.max(1, Number(e.target.value) || 1);
              setOverride(v);
              saveTarget.mutate(v);
            }}
            className="h-9 w-20"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[60px] w-full rounded-xl" />
          ))}
        </div>
      ) : plan.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="Üretim gerekmiyor 🎉"
          description={`Tüm aktif ürünlerin stoğu hedefin (${target}) üzerinde. Acil basılacak bir şey yok.`}
        />
      ) : (
        <>
          <Card className="border-primary/30 bg-primary/5">
            <CardContent className="py-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
              <span className="inline-flex items-center gap-1.5">
                <Factory className="h-4 w-4 text-primary" />
                <strong className="tabular-nums">{plan.length}</strong> ürün basılmalı
              </span>
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Package className="h-4 w-4" />
                toplam <strong className="text-foreground tabular-nums">{totalPrints}</strong> baskı
              </span>
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Disc3 className="h-4 w-4" />
                ~<strong className="text-foreground tabular-nums">{(totalFilament / 1000).toFixed(2)}</strong> kg filament
              </span>
            </CardContent>
          </Card>

          <div className="space-y-2">
            {plan.map((p) => (
              <Card key={p.id} className="overflow-hidden">
                <CardContent className="p-3 flex items-center gap-3">
                  <div className="h-12 w-12 shrink-0 rounded-lg border bg-muted flex items-center justify-center overflow-hidden">
                    {p.imageUrl ? (
                      <img src={p.imageUrl} alt="" className="max-w-full max-h-full object-contain" loading="lazy" />
                    ) : (
                      <Package className="h-5 w-5 text-muted-foreground/40" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <Link href={`/products/${p.id}`} className="text-sm font-medium hover:underline line-clamp-1">
                      {p.name}
                    </Link>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full border tabular-nums",
                          p.stock === 0
                            ? "bg-destructive/15 text-destructive border-destructive/30"
                            : "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
                        )}
                      >
                        {p.stock === 0 && <AlertTriangle className="h-3 w-3" />}
                        Stok {p.stock}
                      </span>
                      {p.gramPer > 0 && (
                        <span className="text-[11px] text-muted-foreground tabular-nums">{Math.round(p.gramPer)} g/adet</span>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-lg font-bold tabular-nums text-primary leading-none">{p.printQty}</div>
                    <div className="text-[10px] text-muted-foreground">baskı</div>
                    {p.filament > 0 && (
                      <div className="text-[11px] text-muted-foreground tabular-nums mt-0.5">~{Math.round(p.filament)} g</div>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
