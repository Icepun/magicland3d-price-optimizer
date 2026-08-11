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
  List,
  Layers,
  Clock,
  FileBox,
} from "lucide-react";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { formatCurrency, formatNumber } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button, buttonVariants } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
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

/** Baskı kuyruğu ucunun (/api/planner/queue) satırları. */
interface QueueJob {
  productId: string;
  name: string;
  imageUrl: string | null;
  stock: number;
  quantity: number;
  hoursPerUnit: number | null;
  gramsPerUnit: number | null;
  totalHours: number | null;
  totalGrams: number | null;
  printerIds: string[];
}

interface QueuePrinter {
  id: string;
  name: string;
  brand: string;
  accent: string | null;
  status: string;
  online: boolean;
  busy: boolean;
  currentEtaSec: number | null;
  currentProductName: string | null;
  jobs: QueueJob[];
  queueHours: number;
  queueGrams: number;
  unknownTimeJobs: number;
  finishAt: string | null;
  finishIsPartial: boolean;
}

interface QueuePayload {
  targetStock: number;
  generatedAt: string;
  printers: QueuePrinter[];
  unassigned: QueueJob[];
  totals: {
    products: number;
    prints: number;
    hours: number;
    grams: number;
    unknownTimeJobs: number;
    unknownGramJobs: number;
  };
  filament: {
    neededGrams: number;
    remainingGrams: number;
    enough: boolean;
    spoolCount: number;
    unknownGramJobs: number;
  };
}

/** Öncelik: makine saati başına kazanç, satış hızı ya da en büyük stok açığı. */
type PriorityMode = "profit" | "velocity" | "shortage";
/** Görünüm: düz liste ya da yazıcıya göre kuyruk. */
type ViewMode = "list" | "queue";

/** Sıralamanın baktığı alanlar — hem düz liste hem kuyruk satırları bu şekle uyar. */
interface Sortable {
  stock: number;
  printQty: number;
  profitPerHour: number | null;
  sales: SalesInsight | null;
}

/** Seçilen önceliğe göre iki satırı karşılaştırır (liste ve kuyruk AYNI kuralı kullanır). */
function comparePriority(mode: PriorityMode, a: Sortable, b: Sortable): number {
  if (mode === "shortage") {
    // En büyük açık başta; eşitse stoğu az olan, sonra saat başına çok kazandıran.
    if (a.printQty !== b.printQty) return b.printQty - a.printQty;
    if (a.stock !== b.stock) return a.stock - b.stock;
    return (b.profitPerHour ?? -Infinity) - (a.profitPerHour ?? -Infinity);
  }
  if (mode === "velocity") {
    // Satış hızı: penceredeki adedi en yüksek olan başta. Hiç satmayanlar sona düşer;
    // aralarında stoğu en az olan öne gelir.
    const av = a.sales?.soldInWindow ?? 0;
    const bv = b.sales?.soldInWindow ?? 0;
    if (av !== bv) return bv - av;
    const ad = a.sales?.daysSinceLastSale ?? Number.POSITIVE_INFINITY;
    const bd = b.sales?.daysSinceLastSale ?? Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return a.stock - b.stock;
  }
  // Makine saati başına en çok kazandıran önce. Baskı süresi girilmemiş ürünler (kâr/saat
  // bilinmiyor) sona düşer, kendi aralarında stoğu en az olan başta kalır.
  const av = a.profitPerHour;
  const bv = b.profitPerHour;
  if (av != null && bv != null && av !== bv) return bv - av;
  if (av != null && bv == null) return -1;
  if (av == null && bv != null) return 1;
  return a.stock - b.stock;
}

/** 2,5 → "2 sa 30 dk". Kısa işlerde yalnız dakika. */
function hoursText(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "0 dk";
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} dk`;
  if (m === 0) return `${h} sa`;
  return `${h} sa ${m} dk`;
}

const timeFmt = new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit" });
const dayTimeFmt = new Intl.DateTimeFormat("tr-TR", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** Bitiş anını okunur yaz: bugünse saat, yarınsa "yarın 09:15", sonrası tam tarih. */
function finishText(at: number, now = Date.now()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "—";
  const today = new Date(now);
  const dayDiff = Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() -
      new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      86_400_000
  );
  if (dayDiff === 0) return timeFmt.format(date);
  if (dayDiff === 1) return `yarın ${timeFmt.format(date)}`;
  return dayTimeFmt.format(date);
}

const PRINTER_STATUS: Record<string, { label: string; cls: string }> = {
  printing: { label: "Yazdırıyor", cls: "bg-primary/10 text-primary border-primary/30" },
  paused: { label: "Duraklatıldı", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30" },
  finished: { label: "Baskı bitti", cls: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30" },
  idle: { label: "Hazır", cls: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/25" },
  error: { label: "Hata", cls: "bg-destructive/15 text-destructive border-destructive/30" },
  offline: { label: "Bağlı değil", cls: "bg-muted text-muted-foreground border-border" },
};

function printerStatusLabel(printer: QueuePrinter): { label: string; cls: string } {
  if (!printer.online) return { label: "Bağlı değil", cls: "bg-muted text-muted-foreground border-border" };
  return PRINTER_STATUS[printer.status] ?? { label: "Durum bilinmiyor", cls: "bg-muted text-muted-foreground border-border" };
}

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
  const [view, setView] = useState<ViewMode>("list");

  // Yazıcı kuyruğu yalnız o görünüm açılınca çekilir — her sorgu süreç genelinde sıraya
  // girdiği için listeye bakan kullanıcıya ek yük bindirmeyelim.
  const { data: queue, isLoading: queueLoading } = useQuery<QueuePayload>({
    queryKey: ["planner-queue", target],
    queryFn: () => fetchJson(`/api/planner/queue?target=${target}`),
    staleTime: 60_000,
    enabled: view === "queue",
  });

  // Yenile: stok/maliyet başka bir cihazda veya senkronla değişmiş olabilir → listeyi tazele.
  // İlerleme GERÇEK: tamamlanan tazeleme sayısı ekrana yansır, sahte animasyon yok.
  const [refreshProgress, setRefreshProgress] = useState<{ done: number; total: number } | null>(null);
  const refreshing = refreshProgress != null;
  const refresh = async () => {
    if (refreshing) return;
    const tasks = [
      qc.invalidateQueries({ queryKey: ["products"] }),
      qc.invalidateQueries({ queryKey: ["settings"] }),
      qc.invalidateQueries({ queryKey: ["planner-insights"] }),
      qc.invalidateQueries({ queryKey: ["planner-queue"] }),
    ];
    setRefreshProgress({ done: 0, total: tasks.length });
    try {
      await Promise.all(
        tasks.map((task) =>
          task.then(() =>
            setRefreshProgress((p) => (p ? { ...p, done: p.done + 1 } : p))
          )
        )
      );
    } finally {
      setRefreshProgress(null);
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
    const mode = priority === "velocity" && !velocityReady ? "profit" : priority;
    return [...visible].sort((a, b) => comparePriority(mode, a, b));
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

  // Kuyruk satırları kâr/saat ve satış hızını ürün listesinden ödünç alır → aynı sıralama
  // düğmeleri kuyruk içinde de çalışır.
  const productById = useMemo(() => {
    const map = new Map<string, ProductRow>();
    for (const p of products) map.set(p.id, p);
    return map;
  }, [products]);

  const sortJobs = useMemo(() => {
    const mode = priority === "velocity" && !velocityReady ? "profit" : priority;
    const key = (job: QueueJob): Sortable => ({
      stock: job.stock,
      printQty: job.quantity,
      profitPerHour: productById.get(job.productId)?.profitPerHour ?? null,
      sales: insightById.get(job.productId) ?? null,
    });
    return (jobs: QueueJob[]) => [...jobs].sort((a, b) => comparePriority(mode, key(a), key(b)));
  }, [priority, velocityReady, productById, insightById]);

  // Kuyruk, listenin gösterdiği işlerle AYNI olmalı: "satmayanları gizle" açıkken gizlenen
  // ürünler kuyruktan da düşer ve süre/filament toplamları kalanlara göre yeniden çıkar
  // (yoksa ekranda gizlenmiş ürünün süresi görünmeye devam ederdi).
  const visibleQueue = useMemo(() => {
    if (!queue) return null;
    const allowed = hideDeadStock ? new Set(plan.map((p) => p.id)) : null;
    const keep = (job: QueueJob) => allowed == null || allowed.has(job.productId);
    const printers = queue.printers.map((printer) => ({
      ...printer,
      jobs: sortJobs(printer.jobs.filter(keep)),
    }));
    const unassigned = sortJobs(queue.unassigned.filter(keep));
    let hours = 0;
    let grams = 0;
    for (const job of [...printers.flatMap((p) => p.jobs), ...unassigned]) {
      hours += job.totalHours ?? 0;
      grams += job.totalGrams ?? 0;
    }
    return {
      printers,
      unassigned,
      hours,
      neededGrams: grams,
      remainingGrams: queue.filament.remainingGrams,
      enough: queue.filament.remainingGrams >= grams,
      generatedAtMs: Date.parse(queue.generatedAt),
    };
  }, [queue, hideDeadStock, plan, sortJobs]);

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
            Stoğu hedefin altındaki ürünler.{" "}
            <span className="font-medium text-foreground">Yazıcı kuyruğu</span> sekmesi bunları
            yazıcılara dağıtır; <span className="font-medium text-foreground">Bas</span> ile
            istediğini hemen gönder.
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

      {/* Yenileme ilerlemesi — kaç adım bittiği gerçekten sayılır. */}
      {refreshProgress && (
        <div className="space-y-1 animate-in fade-in duration-200">
          <Progress value={(refreshProgress.done / refreshProgress.total) * 100} className="h-1.5" />
          <p className="text-[11px] text-muted-foreground tabular-nums">
            Yenileniyor · {refreshProgress.done}/{refreshProgress.total}
          </p>
        </div>
      )}

      {/* Görünüm: düz liste ↔ yazıcı kuyruğu */}
      <div className="flex items-center rounded-md border bg-muted/30 p-0.5 gap-0.5 w-fit">
        {([
          { id: "list" as const, icon: List, label: "Liste" },
          { id: "queue" as const, icon: Layers, label: "Yazıcı kuyruğu" },
        ]).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setView(tab.id)}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-sm transition-all active:scale-[0.97]",
              view === tab.id
                ? "bg-background shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <tab.icon className="h-3.5 w-3.5" /> {tab.label}
          </button>
        ))}
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
            onClick={() => setPriority("shortage")}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-sm transition-all active:scale-[0.97]",
              priority === "shortage"
                ? "bg-background shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
            title="Stoğu hedeften en çok geride kalan önce"
          >
            <Package className="h-3.5 w-3.5" /> Stok açığı
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
              {view === "queue" && visibleQueue && visibleQueue.hours > 0 && (
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <Clock className="h-4 w-4" />~
                  <AnimatedNumber
                    value={visibleQueue.hours}
                    format={hoursText}
                    className="text-foreground font-bold tabular-nums"
                  />{" "}
                  baskı süresi
                </span>
              )}
            </CardContent>
          </Card>

          {view === "queue" ? (
            <QueueView
              queue={visibleQueue}
              loading={queueLoading}
              productById={productById}
              onPrint={(id, name) => setPrintTarget({ id, name })}
            />
          ) : (
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
          )}
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

/** Ekranda gösterilen kuyruk — süzgeç uygulandıktan sonraki hâli. */
interface VisibleQueue {
  printers: QueuePrinter[];
  unassigned: QueueJob[];
  hours: number;
  neededGrams: number;
  remainingGrams: number;
  enough: boolean;
  generatedAtMs: number;
}

/** Yazıcıya göre kuyruk: her yazıcının işleri, toplam süresi ve tahmini bitişi. */
function QueueView({
  queue,
  loading,
  productById,
  onPrint,
}: {
  queue: VisibleQueue | null;
  loading: boolean;
  productById: Map<string, ProductRow>;
  onPrint: (id: string, name: string) => void;
}) {
  if (loading || !queue) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[150px] w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (queue.printers.length === 0) {
    return (
      <EmptyState
        icon={Printer}
        title="Henüz yazıcı yok"
        description="Yazıcılarını ekleyince plan otomatik olarak yazıcılara dağılır."
        action={
          <Link href="/printers" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Yazıcılara git
          </Link>
        }
      />
    );
  }

  const queued = queue.printers.filter((p) => p.jobs.length > 0);
  const empty = queue.printers.filter((p) => p.jobs.length === 0);

  return (
    <div className="space-y-3">
      {/* Tek satır filament uyarısı — otomatik düşüm yok, sadece "yetecek mi?" */}
      {!queue.enough && (
        <Card className="border-amber-500/40 bg-amber-500/5 animate-in fade-in slide-in-from-bottom-1 duration-300">
          <CardContent className="py-2.5 flex items-center gap-2 text-sm">
            <Disc3 className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <span>
              Bu plan ~{formatNumber(queue.neededGrams / 1000, 2)} kg filament ister, makaralarda ~
              {formatNumber(queue.remainingGrams / 1000, 2)} kg kaldı.
            </span>
            <Link href="/spools" className="ml-auto shrink-0 text-xs font-medium text-primary hover:underline">
              Makaralar
            </Link>
          </CardContent>
        </Card>
      )}

      {queued.map((printer, i) => (
        <PrinterQueueCard
          key={printer.id}
          printer={printer}
          index={i}
          generatedAtMs={queue.generatedAtMs}
          productById={productById}
          onPrint={onPrint}
        />
      ))}

      {empty.length > 0 && (
        <p className="text-[11px] text-muted-foreground animate-in fade-in duration-300">
          Kuyruğu boş: {empty.map((p) => p.name).join(", ")}
        </p>
      )}

      {queue.unassigned.length > 0 && (
        <Card
          className="border-dashed animate-in fade-in slide-in-from-bottom-2 duration-300"
          style={{ animationDelay: `${Math.min(queued.length, 12) * 60}ms`, animationFillMode: "both" }}
        >
          <CardContent className="p-4 space-y-2.5">
            <div className="flex items-center gap-2">
              <FileBox className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm font-semibold">Baskı dosyası yok</p>
              <span className="rounded-full bg-foreground/10 px-1.5 text-[11px] font-semibold tabular-nums">
                {queue.unassigned.length}
              </span>
              <Link href="/models" className="ml-auto text-xs font-medium text-primary hover:underline">
                Model Kütüphanesi
              </Link>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Bu ürünler için dosya yüklenmedi — hiçbir yazıcıya atanamadı.
            </p>
            <div className="space-y-1.5">
              {queue.unassigned.map((job) => (
                <div key={job.productId} className="flex items-center gap-2.5 rounded-lg border bg-muted/20 p-2">
                  <div className="min-w-0 flex-1">
                    <Link href={`/products/${job.productId}`} className="text-sm font-medium hover:underline line-clamp-1">
                      {job.name}
                    </Link>
                    <p className="text-[11px] text-muted-foreground tabular-nums">
                      Stok {job.stock} · {job.quantity} baskı gerekiyor
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function PrinterQueueCard({
  printer,
  index,
  generatedAtMs,
  productById,
  onPrint,
}: {
  printer: QueuePrinter;
  index: number;
  generatedAtMs: number;
  productById: Map<string, ProductRow>;
  onPrint: (id: string, name: string) => void;
}) {
  const status = printerStatusLabel(printer);
  const jobs = printer.jobs;
  // Toplamlar EKRANDAKİ işlerden çıkar — süzgeç bir ürünü gizlediyse süresi de düşer.
  let prints = 0;
  let queueHours = 0;
  let queueGrams = 0;
  let unknownTimeJobs = 0;
  for (const job of jobs) {
    prints += job.quantity;
    if (job.totalHours == null) unknownTimeJobs += 1;
    else queueHours += job.totalHours;
    queueGrams += job.totalGrams ?? 0;
  }
  const finishAtMs =
    queueHours > 0
      ? generatedAtMs + (printer.currentEtaSec ?? 0) * 1000 + queueHours * 3_600_000
      : null;
  return (
    <Card
      className="overflow-hidden transition-shadow hover:shadow-md animate-in fade-in slide-in-from-bottom-2 duration-300"
      style={{ animationDelay: `${Math.min(index, 12) * 60}ms`, animationFillMode: "both" }}
    >
      <div className="h-1 w-full" style={{ background: printer.accent || "oklch(0.66 0.20 278)" }} />
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Printer className="h-4 w-4 text-primary shrink-0" />
              <p className="font-semibold text-sm truncate">{printer.name}</p>
              <span className={cn("text-[11px] px-1.5 py-0.5 rounded-full border", status.cls)}>
                {status.label}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1 tabular-nums">
              {jobs.length} ürün · {prints} baskı
              {queueGrams > 0 && ` · ~${Math.round(queueGrams)} g`}
            </p>
          </div>
          <div className="text-right shrink-0">
            <div className="text-lg font-bold tabular-nums text-primary leading-none">
              <AnimatedNumber value={queueHours} format={hoursText} />
            </div>
            <div className="text-[10px] text-muted-foreground">kuyruk süresi</div>
          </div>
        </div>

        {/* Tek satır durum özeti: ne zaman biter, neyi bilmiyoruz. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {printer.currentEtaSec != null && (
            <span className="inline-flex items-center gap-1">
              <Timer className="h-3 w-3" />
              Süren baskı{printer.currentProductName ? ` (${printer.currentProductName})` : ""}:{" "}
              {hoursText(printer.currentEtaSec / 3600)} kaldı
            </span>
          )}
          {finishAtMs != null && (
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <Clock className="h-3 w-3" />
              {unknownTimeJobs > 0 ? "En erken bitiş" : "Tahmini bitiş"} {finishText(finishAtMs)}
            </span>
          )}
          {unknownTimeJobs > 0 && (
            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3 w-3" />
              {unknownTimeJobs} üründe baskı süresi girilmemiş
            </span>
          )}
        </div>

        <div className="space-y-1.5">
          {jobs.map((job, i) => {
            const profitPerHour = productById.get(job.productId)?.profitPerHour ?? null;
            return (
              <div
                key={job.productId}
                className="flex items-center gap-2.5 rounded-lg border bg-muted/20 p-2 transition-colors hover:bg-muted/40 animate-in fade-in duration-300"
                style={{ animationDelay: `${Math.min(i, 10) * 25}ms`, animationFillMode: "both" }}
              >
                <span className="flex items-center justify-center h-7 w-7 shrink-0 rounded bg-primary/10 text-primary text-xs font-bold tabular-nums">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <Link href={`/products/${job.productId}`} className="text-sm font-medium hover:underline line-clamp-1">
                    {job.name}
                  </Link>
                  <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground tabular-nums">
                    <span className="font-medium text-foreground">{job.quantity} baskı</span>
                    <span>
                      {job.totalHours != null ? hoursText(job.totalHours) : "süre girilmemiş"}
                    </span>
                    {job.totalGrams != null && <span>~{Math.round(job.totalGrams)} g</span>}
                    {profitPerHour != null && (
                      <span className="inline-flex items-center gap-1">
                        <Timer className="h-3 w-3" />
                        {formatCurrency(profitPerHour, { decimals: 0 })}/saat
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 gap-1.5"
                  onClick={() => onPrint(job.productId, job.name)}
                  title="Bu ürünü yazıcıya gönder (yazıcı + renk seç, başlat)"
                >
                  <Printer className="h-3.5 w-3.5" />
                  Bas
                </Button>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
