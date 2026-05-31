"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Printer,
  Box,
  Flame,
  Layers,
  Clock,
  CheckCircle2,
  Loader2,
  Sparkles,
  Power,
  RefreshCw,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type PrinterStatus = "printing" | "finished" | "idle" | "paused" | "error";

interface PrinterJob {
  productName: string;
  productImage: string | null;
  startedAt: string;
  endsAt: string;
  layerTotal: number;
  filamentType: string;
  filamentColor: string;
}
interface SimPrinter {
  id: string;
  name: string;
  brand: "bambu" | "elegoo" | "snapmaker";
  model: string;
  accent: string;
  status: PrinterStatus;
  online: boolean;
  temps: { nozzle: number; nozzleTarget: number; bed: number; bedTarget: number };
  job: PrinterJob | null;
}
interface PrintersResponse {
  printers: SimPrinter[];
  simulated: boolean;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function alpha(oklch: string, pct: number) {
  return oklch.replace(")", ` / ${pct}%)`);
}

function fmtRemaining(sec: number) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}sa ${m}dk`;
  if (m > 0) return `${m}dk ${s.toString().padStart(2, "0")}sn`;
  return `${s}sn`;
}

export default function PrintersPage() {
  const { data, isLoading, isFetching, refetch } = useQuery<PrintersResponse>({
    queryKey: ["printers"],
    queryFn: () => fetch("/api/printers").then((r) => r.json()),
    refetchInterval: 5000,
    staleTime: 0,
  });

  // Canlı saat — her saniye tik (progress/ETA akıcı oynasın)
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const printers = useMemo(() => data?.printers ?? [], [data]);
  const printingCount = printers.filter((p) => p.status === "printing").length;
  const idleCount = printers.filter((p) => p.status === "idle").length;

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      {/* Başlık */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Printer className="h-6 w-6 text-primary" /> Yazıcılar
            <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/12 text-primary border border-primary/25">
              Demo
            </span>
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            4 yazıcının canlı baskı durumu — simülasyon (henüz yazıcılara bağlı değil).
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={isFetching} onClick={() => refetch()} className="gap-2 shrink-0">
          <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
          Yenile
        </Button>
      </div>

      {/* Özet şerit */}
      {!isLoading && (
        <div className="flex flex-wrap gap-2 text-xs">
          <SummaryChip icon={Printer} label={`${printers.length} yazıcı`} />
          <SummaryChip icon={Loader2} label={`${printingCount} yazdırıyor`} spin accent />
          <SummaryChip icon={Power} label={`${idleCount} hazır`} muted />
        </div>
      )}

      {/* Kartlar */}
      {isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[232px] w-full rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {printers.map((p, i) => (
            <PrinterCard key={p.id} printer={p} now={now} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryChip({
  icon: Icon,
  label,
  spin,
  accent,
  muted,
}: {
  icon: React.ElementType;
  label: string;
  spin?: boolean;
  accent?: boolean;
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border font-medium",
        accent
          ? "bg-primary/10 border-primary/25 text-primary"
          : muted
            ? "bg-muted/50 border-border text-muted-foreground"
            : "bg-card border-border text-foreground/80"
      )}
    >
      <Icon className={cn("h-3.5 w-3.5", spin && "animate-spin")} />
      {label}
    </span>
  );
}

const STATUS_META: Record<
  PrinterStatus,
  { label: string; cls: string; finished?: boolean }
> = {
  printing: { label: "Yazdırıyor", cls: "" },
  finished: { label: "Tamamlandı", cls: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30", finished: true },
  idle: { label: "Hazır", cls: "bg-muted text-muted-foreground border-border" },
  paused: { label: "Duraklatıldı", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30" },
  error: { label: "Hata", cls: "bg-destructive/15 text-destructive border-destructive/30" },
};

function PrinterCard({ printer, now, index }: { printer: SimPrinter; now: number; index: number }) {
  const { job, status, accent } = printer;

  let progress = 0;
  let remainingSec = 0;
  let layerCurrent = 0;
  if (job) {
    const start = new Date(job.startedAt).getTime();
    const end = new Date(job.endsAt).getTime();
    const dur = Math.max(1, end - start);
    progress = clamp((now - start) / dur, 0, 1);
    remainingSec = Math.max(0, (end - now) / 1000);
    if (status === "finished") {
      progress = 1;
      remainingSec = 0;
    }
    layerCurrent = Math.round(progress * job.layerTotal);
  }
  const pct = Math.round(progress * 100);
  const finishingNow = status === "printing" && remainingSec <= 0.5;
  const isFinished = status === "finished";
  const isPrinting = status === "printing";

  // Sıcaklık — minik canlı oynama
  const nozzle =
    printer.temps.nozzleTarget > 0
      ? printer.temps.nozzle + Math.round(Math.sin(now / 800 + index) * 1.5)
      : printer.temps.nozzle;
  const bed =
    printer.temps.bedTarget > 0
      ? printer.temps.bed + Math.round(Math.cos(now / 1100 + index) * 1)
      : printer.temps.bed;

  const sm = STATUS_META[status];

  return (
    <Card
      className="relative overflow-hidden animate-in fade-in slide-in-from-bottom-3 duration-500"
      style={{
        animationDelay: `${index * 80}ms`,
        animationFillMode: "both",
        borderColor: isPrinting ? alpha(accent, 35) : undefined,
        boxShadow: isPrinting ? `0 0 0 1px ${alpha(accent, 18)}, 0 8px 30px ${alpha(accent, 12)}` : undefined,
      }}
    >
      {/* Yazdırırken üstte ince akan accent çizgi */}
      {isPrinting && (
        <div className="absolute inset-x-0 top-0 h-[2px] overflow-hidden">
          <div
            className="h-full w-1/3"
            style={{ background: accent, animation: "indeterminate-bar 2.2s ease-in-out infinite", boxShadow: `0 0 8px ${accent}` }}
          />
        </div>
      )}
      {isFinished && <Confetti accent={accent} />}

      <CardContent className="p-4 space-y-3.5">
        {/* Üst: marka + durum */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className="flex items-center justify-center h-9 w-9 rounded-lg shrink-0"
              style={{ backgroundColor: alpha(accent, 14), border: `1px solid ${alpha(accent, 30)}` }}
            >
              <Printer className="h-4 w-4" style={{ color: accent }} />
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-sm truncate leading-tight">{printer.name}</p>
              <p className="text-[11px] text-muted-foreground truncate">{printer.model}</p>
            </div>
          </div>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold border shrink-0",
              sm.cls
            )}
            style={isPrinting ? { backgroundColor: alpha(accent, 14), color: accent, borderColor: alpha(accent, 30) } : undefined}
          >
            {isPrinting && <span className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: accent }} />}
            {isFinished && <Sparkles className="h-3 w-3" />}
            {sm.label}
          </span>
        </div>

        {/* Gövde: görsel + bilgi */}
        {job ? (
          <div className="flex gap-3.5">
            <PrintInImage
              image={job.productImage}
              productName={job.productName}
              progress={progress}
              accent={accent}
              printing={isPrinting}
            />
            <div className="flex-1 min-w-0 space-y-2">
              <p className="text-sm font-medium leading-snug line-clamp-2">{job.productName}</p>
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground tabular-nums">
                <span className="inline-flex items-center gap-1">
                  <Layers className="h-3.5 w-3.5" /> {layerCurrent}/{job.layerTotal}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full border border-black/10" style={{ background: job.filamentColor }} />
                  {job.filamentType}
                </span>
              </div>
              <div className="flex items-center gap-3 text-[11px] tabular-nums">
                <span className="inline-flex items-center gap-1" style={{ color: nozzle > 60 ? "oklch(0.65 0.2 35)" : undefined }}>
                  <Flame className="h-3.5 w-3.5" /> {nozzle}°
                  <span className="text-muted-foreground/60">/ {printer.temps.nozzleTarget || "—"}</span>
                </span>
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  Tabla {bed}°
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3.5 py-2">
            <div className="flex items-center justify-center h-28 w-28 shrink-0 rounded-xl border border-dashed bg-muted/30">
              <Box className="h-9 w-9 text-muted-foreground/30" />
            </div>
            <div className="flex-1 text-sm text-muted-foreground">
              <p className="font-medium text-foreground/70">Hazır</p>
              <p className="text-xs mt-0.5">Baskı bekleniyor…</p>
              <p className="text-[11px] mt-2 text-muted-foreground/70 tabular-nums">
                Nozzle {nozzle}° · Tabla {bed}°
              </p>
            </div>
          </div>
        )}

        {/* Progress */}
        {job && (
          <div className="space-y-1.5">
            <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full relative overflow-hidden transition-[width] duration-1000 ease-linear"
                style={{
                  width: `${pct}%`,
                  background: isFinished
                    ? "linear-gradient(90deg, oklch(0.72 0.18 145 / 80%), oklch(0.72 0.18 145))"
                    : `linear-gradient(90deg, ${alpha(accent, 70)}, ${accent})`,
                }}
              >
                {isPrinting && (
                  <div
                    className="absolute inset-0"
                    style={{
                      background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent)",
                      animation: "printer-shimmer 1.6s linear infinite",
                    }}
                  />
                )}
              </div>
            </div>
            <div className="flex items-center justify-between text-xs tabular-nums">
              <span className="font-bold text-sm" style={{ color: isFinished ? "oklch(0.72 0.18 145)" : accent }}>
                {isFinished ? "Tamamlandı 🎉" : `%${pct}`}
              </span>
              <span className="text-muted-foreground inline-flex items-center gap-1">
                {isFinished ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> Baskı bitti
                  </>
                ) : finishingNow ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Tamamlanıyor…
                  </>
                ) : (
                  <>
                    <Clock className="h-3.5 w-3.5" /> {fmtRemaining(remainingSec)} kaldı
                  </>
                )}
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PrintInImage({
  image,
  productName,
  progress,
  accent,
  printing,
}: {
  image: string | null;
  productName: string;
  progress: number;
  accent: string;
  printing: boolean;
}) {
  const pct = Math.round(progress * 100);
  return (
    <div className="relative h-28 w-28 shrink-0 rounded-xl overflow-hidden border bg-muted/40">
      {image ? (
        <>
          {/* Basılmamış kısım — soluk/gri */}
          <img src={image} alt="" className="absolute inset-0 h-full w-full object-cover opacity-25 grayscale" />
          {/* Basılan kısım — alttan yukarı dolar */}
          <img
            src={image}
            alt={productName}
            className="absolute inset-0 h-full w-full object-cover transition-[clip-path] duration-1000 ease-linear"
            style={{ clipPath: `inset(${100 - pct}% 0 0 0)` }}
          />
        </>
      ) : (
        <>
          <Box className="absolute inset-0 m-auto h-10 w-10 text-muted-foreground/25" />
          <div
            className="absolute inset-x-0 bottom-0 transition-[height] duration-1000 ease-linear"
            style={{ height: `${pct}%`, background: `linear-gradient(0deg, ${alpha(accent, 22)}, transparent)` }}
          />
        </>
      )}
      {/* Parlayan tarama çizgisi */}
      {printing && pct < 100 && (
        <div
          className="absolute inset-x-0 h-[2px] transition-[bottom] duration-1000 ease-linear"
          style={{ bottom: `${pct}%`, background: accent, boxShadow: `0 0 10px 1px ${accent}` }}
        />
      )}
    </div>
  );
}

function Confetti({ accent }: { accent: string }) {
  const colors = ["#e23b3b", "#2b6cf0", "#15c47e", "#f5b400", "#9b5de5", accent];
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden z-10">
      {Array.from({ length: 18 }).map((_, i) => {
        const left = (i * 53) % 100;
        const delay = (i % 6) * 0.1;
        const dur = 1.2 + (i % 5) * 0.22;
        return (
          <span
            key={i}
            className="absolute -top-2 h-2 w-1.5 rounded-[1px]"
            style={{
              left: `${left}%`,
              background: colors[i % colors.length],
              animation: `confetti-fall ${dur}s ease-in ${delay}s infinite`,
            }}
          />
        );
      })}
    </div>
  );
}
