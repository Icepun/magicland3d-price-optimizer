"use client";
/* eslint-disable @next/next/no-img-element */

import { fetchJson } from "@/lib/fetch-json";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
  Factory,
  Package,
  Disc3,
  AlertTriangle,
  CheckCircle2,
  Printer,
  RefreshCw,
  Timer,
  Zap,
  Snowflake,
  Info,
} from "lucide-react";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { formatCurrency, formatNumber } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ProductPrintModal } from "@/components/products/ProductPrintModal";
import { cn } from "@/lib/utils";
import { thumbUrl } from "@/lib/image";

interface ProductRow {
  id: string;
  name: string;
  imageUrl: string | null;
  stock: number;
  madeToOrder?: boolean;
  /** Net kâr ÷ baskı süresi — üretim önceliğini bu belirler (süre girilmemişse null). */
  profitPerHour: number | null;
  cost?: { filamentWeight: number | null } | null;
}

/** Satış hızı ucunun ürün satırı (/api/planner/insights). */
interface SalesInsight {
  productId: string;
  soldRecent: number;
  soldInWindow: number;
  daysSinceLastSale: number | null;
  daysPerSale: number | null;
  deadStock: boolean;
}

interface SalesInsights {
  windowDays: number;
  recentDays: number;
  deadStockDays: number;
  historyDays: number;
  ready: boolean;
  readyInDays: number;
  deadStockReady: boolean;
  deadStockInDays: number;
  items: SalesInsight[];
}

/** Öncelik: makine saati başına kazanç (mevcut) ya da satış hızı (yeni, tamamlayıcı). */
type PriorityMode = "profit" | "velocity";

export default function PlannerPage() {
  const { data, isLoading } = useQuery<ProductRow[]>({
    // Aktif ürünler (~442KB) — Ürünler/Raporlar/Filament ile AYNI key → tek fetch, sayfalar arası paylaşılır.
    queryKey: ["products", "active"],
    queryFn: () => fetchJson("/api/products?filter=active"),
    staleTime: 60_000,
  });
  const products = useMemo(() => (Array.isArray(data) ? data : []), [data]);

  // Satış geçmişi ayrı ve hafif bir uçtan gelir → ürün listesini bekletmez.
  const { data: insights } = useQuery<SalesInsights>({
    queryKey: ["planner-insights"],
    queryFn: () => fetchJson("/api/planner/insights"),
    staleTime: 5 * 60_000,
  });
  const insightById = useMemo(() => {
    const map = new Map<string, SalesInsight>();
    for (const item of insights?.items ?? []) map.set(item.productId, item);
    return map;
  }, [insights]);

  const velocityReady = insights?.ready ?? false;
  const deadStockReady = insights?.deadStockReady ?? false;

  // Hedef stok DB'de (AppSetting) saklanır → masaüstü/telefon senkron
  const qc = useQueryClient();
  const { data: settings } = useQuery<Record<string, string>>({
    queryKey: ["settings"],
    queryFn: () => fetchJson("/api/settings"),
    staleTime: 60_000,
  });
  const savedTarget = Math.max(1, Number(settings?.plannerTargetStock) || 5);
  const [override, setOverride] = useState<number | null>(null);
  const target = override ?? savedTarget;

  // Sıra ve süzgeç kullanıcının seçimi — varsayılan MEVCUT davranıştır (kâr/saat, hepsi görünür).
  const [priority, setPriority] = useState<PriorityMode>("profit");
  const [hideDeadStock, setHideDeadStock] = useState(false);

  // Yenile: stok/maliyet başka bir cihazda veya senkronla değişmiş olabilir → listeyi tazele.
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["products"] }),
        qc.invalidateQueries({ queryKey: ["settings"] }),
        qc.invalidateQueries({ queryKey: ["planner-insights"] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  };
  // Baskı modalı — Ürünler sayfasındakiyle AYNI akış (yazıcı seçimi + Snapmaker/Bambu renk + başlat).
  const [printTarget, setPrintTarget] = useState<{ id: string; name: string } | null>(null);
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
    const rows = products
      // "Sipariş üzerine üretilir" ürünler stok tutmaz → üretim planına girmez.
      .filter((p) => !p.madeToOrder && p.stock < target)
      .map((p) => {
        const printQty = Math.max(1, target - p.stock);
        const gramPer = p.cost?.filamentWeight ?? 0;
        const sales = insightById.get(p.id) ?? null;
        // Satış listesinde hiç görünmeyen ürün, pencerede hiç satmamış demektir. Bunu ancak
        // elimizde o kadar geçmiş varsa "ölü stok" saymaya hakkımız var.
        const deadStock = deadStockReady && (sales == null || sales.deadStock);
        return { ...p, printQty, filament: printQty * gramPer, gramPer, sales, deadStock };
      });

    const visible = hideDeadStock ? rows.filter((p) => !p.deadStock) : rows;

    if (priority === "velocity" && velocityReady) {
      // Satış hızı önceliği: penceredeki adedi en yüksek olan başta. Hiç satmayanlar sona
      // düşer; aralarında stoğu en az olan öne gelir.
      return [...visible].sort((a, b) => {
        const av = a.sales?.soldInWindow ?? 0;
        const bv = b.sales?.soldInWindow ?? 0;
        if (av !== bv) return bv - av;
        const ad = a.sales?.daysSinceLastSale ?? Number.POSITIVE_INFINITY;
        const bd = b.sales?.daysSinceLastSale ?? Number.POSITIVE_INFINITY;
        if (ad !== bd) return ad - bd;
        return a.stock - b.stock;
      });
    }

    // Öncelik: makine saati başına en çok kazandıran önce. Baskı süresi girilmemiş ürünler
    // (kâr/saat bilinmiyor) sona düşer, kendi aralarında stoğu en az olan başta kalır.
    return [...visible].sort((a, b) => {
      const av = a.profitPerHour;
      const bv = b.profitPerHour;
      if (av != null && bv != null && av !== bv) return bv - av;
      if (av != null && bv == null) return -1;
      if (av == null && bv != null) return 1;
      return a.stock - b.stock;
    });
  }, [products, target, insightById, deadStockReady, hideDeadStock, priority, velocityReady]);

  const totalFilament = plan.reduce((s, p) => s + p.filament, 0);
  const totalPrints = plan.reduce((s, p) => s + p.printQty, 0);
  const deadStockCount = useMemo(
    () =>
      deadStockReady
        ? products.filter(
            (p) =>
              !p.madeToOrder &&
              p.stock < target &&
              (insightById.get(p.id)?.deadStock ?? true)
          ).length
        : 0,
    [products, target, insightById, deadStockReady]
  );

  // Tek satırlık ipucu — geçmiş yeterli değilken rakam yerine bunu gösteririz.
  const hint = !insights
    ? null
    : !insights.ready
      ? `Satış hızı için yeterli satış geçmişi yok — yaklaşık ${insights.readyInDays} gün sonra kullanılabilir.`
      : !insights.deadStockReady
        ? `Satmayan ürün listesi ${insights.deadStockInDays} gün sonra hazır olacak.`
        : null;

  return (
    <div className="p-6 space-y-5 max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Factory className="h-6 w-6 text-primary" /> Üretim Planı
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Stoğu hedefin altındaki ürünler — sırayı aşağıdan seç. Sağdaki{" "}
            <span className="font-medium text-foreground">Bas</span> ile o ürünü doğrudan bir yazıcıya gönder.
          </p>
        </div>
        <div className="shrink-0 flex items-end gap-2">
          <div>
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
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => void refresh()}
            disabled={refreshing}
            title="Stok ve maliyetleri yeniden çek"
          >
            <RefreshCw className={cn("h-4 w-4 mr-1.5", refreshing && "animate-spin")} />
            {refreshing ? "Yenileniyor…" : "Yenile"}
          </Button>
        </div>
      </div>

      {/* Sıra + satmayan ürün süzgeci — ikisi de kullanıcının seçimi, varsayılan hiçbir şeyi değiştirmez. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-md border bg-muted/30 p-0.5 gap-0.5">
          <button
            type="button"
            onClick={() => setPriority("profit")}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-sm transition-all active:scale-[0.97]",
              priority === "profit"
                ? "bg-background shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
            title="Baskı saati başına en çok kazandıran önce"
          >
            <Timer className="h-3.5 w-3.5" /> Kâr/saat
          </button>
          <button
            type="button"
            onClick={() => velocityReady && setPriority("velocity")}
            disabled={!velocityReady}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-sm transition-all active:scale-[0.97]",
              priority === "velocity"
                ? "bg-background shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground",
              !velocityReady && "opacity-40 cursor-not-allowed hover:text-muted-foreground"
            )}
            title={
              velocityReady
                ? "En çok satan ürün önce"
                : "Yeterli satış geçmişi birikince açılır"
            }
          >
            <Zap className="h-3.5 w-3.5" /> Satış hızı
          </button>
        </div>

        <Button
          variant={hideDeadStock ? "default" : "outline"}
          size="sm"
          disabled={!deadStockReady}
          onClick={() => setHideDeadStock((v) => !v)}
          className="h-9 gap-1.5 transition-all"
          title={
            deadStockReady
              ? `${insights?.deadStockDays ?? 90} gündür satmayan ürünleri listeden çıkar`
              : "Yeterli satış geçmişi birikince açılır"
          }
        >
          <Snowflake className="h-3.5 w-3.5" />
          {insights?.deadStockDays ?? 90} gündür satmayanları gizle
          {deadStockReady && deadStockCount > 0 && (
            <span className="ml-0.5 rounded-full bg-foreground/10 px-1.5 text-[11px] font-semibold tabular-nums">
              {deadStockCount}
            </span>
          )}
        </Button>

        {hint && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground animate-in fade-in duration-300">
            <Info className="h-3.5 w-3.5 shrink-0" />
            {hint}
          </span>
        )}
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
          description={
            hideDeadStock
              ? "Satmaya devam eden ürünlerin stoğu yeterli. Gizlenenleri görmek için süzgeci kapat."
              : `Tüm aktif ürünlerin stoğu hedefin (${target}) üzerinde. Acil basılacak bir şey yok.`
          }
        />
      ) : (
        <>
          <Card className="border-primary/30 bg-primary/5">
            <CardContent className="py-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
              <span className="inline-flex items-center gap-1.5">
                <Factory className="h-4 w-4 text-primary" />
                <AnimatedNumber value={plan.length} className="font-bold tabular-nums" /> ürün basılmalı
              </span>
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Package className="h-4 w-4" />
                toplam{" "}
                <AnimatedNumber value={totalPrints} className="text-foreground font-bold tabular-nums" /> baskı
              </span>
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Disc3 className="h-4 w-4" />
                ~
                <AnimatedNumber
                  value={totalFilament / 1000}
                  format={(n) => formatNumber(n, 2)}
                  className="text-foreground font-bold tabular-nums"
                />{" "}
                kg filament
              </span>
            </CardContent>
          </Card>

          <div className="space-y-2">
            {plan.map((p, i) => (
              <Card
                key={p.id}
                className={cn(
                  "overflow-hidden transition-shadow hover:shadow-md animate-in fade-in slide-in-from-bottom-2 duration-300",
                  p.deadStock && "opacity-75"
                )}
                // Sıralı beliriş; uzun listede beklemeyi uzatmamak için gecikme ilk satırlarla sınırlı.
                style={{ animationDelay: `${Math.min(i, 12) * 35}ms`, animationFillMode: "both" }}
              >
                <CardContent className="p-3 flex items-center gap-3">
                  <div className="h-12 w-12 shrink-0 rounded-lg border bg-muted flex items-center justify-center overflow-hidden">
                    {p.imageUrl ? (
                      <img src={thumbUrl(p.imageUrl) ?? undefined} alt="" className="max-w-full max-h-full object-contain" loading="lazy" />
                    ) : (
                      <Package className="h-5 w-5 text-muted-foreground/40" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <Link href={`/products/${p.id}`} className="text-sm font-medium hover:underline line-clamp-1">
                      {p.name}
                    </Link>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
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
                      {p.profitPerHour != null && (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 text-[11px] font-medium tabular-nums px-1.5 py-0.5 rounded-full border",
                            p.profitPerHour > 0
                              ? "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30"
                              : "bg-destructive/10 text-destructive border-destructive/30"
                          )}
                          title="Baskı saati başına kazanç"
                        >
                          <Timer className="h-3 w-3" />
                          {formatCurrency(p.profitPerHour, { decimals: 0 })}/saat
                        </span>
                      )}
                      {/* Satış hızı rozetleri — yalnız geçmiş yeterliyken. */}
                      {p.deadStock ? (
                        <span
                          className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full border bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30"
                          title="Bu ürün uzun süredir satmadı — yeniden basmadan önce düşün"
                        >
                          <Snowflake className="h-3 w-3" />
                          {insights?.deadStockDays ?? 90} gündür satmadı
                        </span>
                      ) : velocityReady && p.sales ? (
                        <span
                          className="inline-flex items-center gap-1 text-[11px] font-medium tabular-nums px-1.5 py-0.5 rounded-full border bg-primary/10 text-primary border-primary/30"
                          title={
                            p.sales.daysPerSale != null
                              ? `Ortalama ${formatNumber(p.sales.daysPerSale, 1)} günde bir satıyor`
                              : undefined
                          }
                        >
                          <Zap className="h-3 w-3" />
                          {insights?.recentDays ?? 30} günde {p.sales.soldRecent} adet
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-lg font-bold tabular-nums text-primary leading-none">{p.printQty}</div>
                    <div className="text-[10px] text-muted-foreground">baskı</div>
                    {p.filament > 0 && (
                      <div className="text-[11px] text-muted-foreground tabular-nums mt-0.5">~{Math.round(p.filament)} g</div>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 gap-1.5"
                    onClick={() => setPrintTarget({ id: p.id, name: p.name })}
                    title="Bu ürünü bir yazıcıya gönder (yazıcı + renk seç, başlat)"
                  >
                    <Printer className="h-3.5 w-3.5" />
                    Bas
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

      {printTarget && (
        <ProductPrintModal
          productId={printTarget.id}
          productName={printTarget.name}
          onClose={() => setPrintTarget(null)}
        />
      )}
    </div>
  );
}
