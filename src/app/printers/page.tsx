"use client";
/* eslint-disable @next/next/no-img-element */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Printer, Box, Flame, Layers, Clock, CheckCircle2, Loader2, Sparkles, Power,
  RefreshCw, Settings2, Plus, Trash2, Pause, Play, Ban, Pencil, WifiOff,
  Check, X, Search, Package, Link2, ArrowRight, AlertTriangle,
  Upload, FileBox, Weight, ChevronLeft, ChevronRight,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatCurrency } from "@/lib/utils";
import { toast } from "sonner";
import {
  SlotStep, PrintProgress, runPrintStream,
  type PrintableModel, type PrintProg, type PrintPrefs,
} from "@/components/printers/print-flow";

type PrinterStatus = "printing" | "finished" | "idle" | "paused" | "error";

interface PrinterJob {
  productName: string;
  productImage: string | null;
  startedAt: string;
  endsAt: string;
  progress: number;
  remainingSec: number;
  layerCurrent: number | null;
  layerTotal: number;
  filamentType: string;
  filamentColor: string;
}
interface PanelPrinter {
  id: string;
  name: string;
  brand: string;
  model: string;
  accent: string;
  type: "moonraker" | "bambu" | "sim";
  status: PrinterStatus;
  online: boolean;
  note: string | null;
  currentFilename: string | null;
  matchedProductId: string | null;
  temps: { nozzle: number; nozzleTarget: number; bed: number; bedTarget: number };
  job: PrinterJob | null;
}
interface PrintersResponse {
  printers: PanelPrinter[];
  simulated: boolean;
  configured: boolean;
}
interface PrinterConfig {
  id: string;
  name: string;
  brand: string;
  model: string | null;
  type: string;
  host: string;
  port: number;
  enabled: boolean;
  accessCode?: string | null;
  serial?: string | null;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const alpha = (oklch: string, pct: number) => oklch.replace(")", ` / ${pct}%)`);

function fmtRemaining(sec: number) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}sa ${m}dk`;
  if (m > 0) return `${m}dk ${s.toString().padStart(2, "0")}sn`;
  return `${s}sn`;
}

/** Bitiş saati — bugünse "HH:MM", yarınsa "yarın HH:MM", sonraysa "g.a HH:MM". */
function fmtClock(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const cur = new Date(nowMs);
  const dayDiff = Math.floor((d.setHours(0, 0, 0, 0) - cur.setHours(0, 0, 0, 0)) / 86400000);
  const d2 = new Date(ms);
  if (dayDiff <= 0) return `${hh}:${mm}`;
  if (dayDiff === 1) return `yarın ${hh}:${mm}`;
  return `${d2.getDate()}.${d2.getMonth() + 1} ${hh}:${mm}`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body?.error || `${url} ${r.status}`);
  }
  return r.json() as Promise<T>;
}

export default function PrintersPage() {
  const qc = useQueryClient();
  const { data, isLoading, isFetching, refetch } = useQuery<PrintersResponse>({
    queryKey: ["printers"],
    queryFn: () => fetchJson<PrintersResponse>("/api/printers"),
    refetchInterval: 5000,
    staleTime: 0,
  });

  // SSR/prerender (build-zamanı) ile client ilk render'ı birebir aynı tut (now=0)
  // → hydration mismatch (React #418, boş ekran) olmaz. Gerçek zaman mount sonrası
  // gelir (sadece client) ve canlı geri sayım sürer.
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const [manageOpen, setManageOpen] = useState(false);
  const [matchTarget, setMatchTarget] = useState<{ id: string; filename: string } | null>(null);
  const [startTarget, setStartTarget] = useState<{ id: string; name: string; brand: string } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<{ id: string; name: string } | null>(null);
  const [customOpen, setCustomOpen] = useState(false);

  const printers = useMemo(() => data?.printers ?? [], [data]);
  const simulated = data?.simulated ?? false;
  const onlineCount = printers.filter((p) => p.online).length;
  const printingCount = printers.filter((p) => p.status === "printing").length;
  const idleCount = printers.filter((p) => p.online && p.status === "idle").length;

  const action = useMutation({
    mutationFn: (v: { id: string; action: "pause" | "resume" | "cancel" | "start"; filename?: string }) =>
      fetchJson(`/api/printers/${v.id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: v.action, filename: v.filename }),
      }),
    onSuccess: (_d, v) => {
      const label = { pause: "Duraklatıldı", resume: "Devam ettirildi", cancel: "İptal edildi", start: "Baskı başlatıldı" }[v.action];
      toast.success(label);
      setTimeout(() => qc.invalidateQueries({ queryKey: ["printers"] }), 600);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Printer className="h-6 w-6 text-primary" /> Yazıcılar
            {simulated && (
              <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/12 text-primary border border-primary/25">
                Demo
              </span>
            )}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {simulated
              ? "Örnek görünüm — gerçek bağlantı için “Yönet”ten yazıcı ekleyin."
              : "Yazıcılarınızın canlı baskı durumu (Moonraker — Elegoo / Snapmaker)."}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" disabled={isFetching} onClick={() => refetch()} className="gap-2">
            <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
            Yenile
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCustomOpen(true)} className="gap-2" disabled={simulated || printers.length === 0}>
            <Upload className="h-4 w-4" /> Özel Baskı
          </Button>
          <Button size="sm" onClick={() => setManageOpen(true)} className="gap-2">
            <Settings2 className="h-4 w-4" /> Yönet
          </Button>
        </div>
      </div>

      {!isLoading && (
        <div className="flex flex-wrap gap-2 text-xs">
          <SummaryChip icon={Printer} label={`${printers.length} yazıcı`} />
          {!simulated && <SummaryChip icon={Power} label={`${onlineCount} çevrimiçi`} />}
          <SummaryChip icon={Loader2} label={`${printingCount} yazdırıyor`} spin accent />
          <SummaryChip icon={Power} label={`${idleCount} hazır`} muted />
        </div>
      )}

      {simulated && !isLoading && (
        <div className="rounded-lg border border-primary/25 bg-primary/[0.04] px-4 py-3 text-sm flex items-start gap-3">
          <Link2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Henüz gerçek yazıcı bağlı değil — bu kartlar örnektir.</p>
            <p className="text-muted-foreground text-xs mt-0.5">
              <strong>Yönet</strong> → yazıcı ekle (örn. Elegoo Neptune 4 Pro · IP <code>192.168.1.18</code> · port 7125). Eklediğin anda canlı veriye geçer.
            </p>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[260px] w-full rounded-xl" />
          ))}
        </div>
      ) : printers.length === 0 ? (
        <div className="rounded-xl border border-dashed py-16 text-center">
          <Printer className="h-10 w-10 mx-auto text-muted-foreground/30" />
          <p className="mt-3 font-medium">Yazıcı yok</p>
          <p className="text-sm text-muted-foreground mt-1">“Yönet”ten ilk yazıcını ekle.</p>
          <Button size="sm" className="mt-4 gap-2" onClick={() => setManageOpen(true)}>
            <Plus className="h-4 w-4" /> Yazıcı Ekle
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {printers.map((p, i) => (
            <PrinterCard
              key={p.id}
              printer={p}
              now={now}
              index={i}
              busy={action.isPending}
              onPause={() => action.mutate({ id: p.id, action: "pause" })}
              onResume={() => action.mutate({ id: p.id, action: "resume" })}
              onCancel={() => setCancelTarget({ id: p.id, name: p.name })}
              onStart={() => setStartTarget({ id: p.id, name: p.name, brand: p.brand })}
              onMatch={() => p.currentFilename && setMatchTarget({ id: p.id, filename: p.currentFilename })}
            />
          ))}
        </div>
      )}

      {manageOpen && <ManageModal onClose={() => setManageOpen(false)} />}
      {matchTarget && <MatchModal target={matchTarget} onClose={() => setMatchTarget(null)} />}
      {startTarget && (
        <StartModal target={startTarget} onClose={() => setStartTarget(null)} />
      )}
      {customOpen && <CustomPrintModal printers={printers} onClose={() => setCustomOpen(false)} />}

      <Dialog open={!!cancelTarget} onOpenChange={(o) => !o && setCancelTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Baskıyı iptal et?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            <strong className="text-foreground">{cancelTarget?.name}</strong> üzerindeki baskı durdurulacak. Bu işlem geri alınamaz.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelTarget(null)}>Vazgeç</Button>
            <Button
              variant="destructive"
              disabled={action.isPending}
              onClick={() => {
                if (cancelTarget) action.mutate({ id: cancelTarget.id, action: "cancel" });
                setCancelTarget(null);
              }}
            >
              Baskıyı İptal Et
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SummaryChip({ icon: Icon, label, spin, accent, muted }: { icon: React.ElementType; label: string; spin?: boolean; accent?: boolean; muted?: boolean }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border font-medium",
      accent ? "bg-primary/10 border-primary/25 text-primary"
        : muted ? "bg-muted/50 border-border text-muted-foreground"
          : "bg-card border-border text-foreground/80"
    )}>
      <Icon className={cn("h-3.5 w-3.5", spin && "animate-spin")} />
      {label}
    </span>
  );
}

const STATUS_META: Record<PrinterStatus, { label: string; cls: string }> = {
  printing: { label: "Yazdırıyor", cls: "" },
  finished: { label: "Tamamlandı", cls: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30" },
  idle: { label: "Hazır", cls: "bg-muted text-muted-foreground border-border" },
  paused: { label: "Duraklatıldı", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30" },
  error: { label: "Hata", cls: "bg-destructive/15 text-destructive border-destructive/30" },
};

// Konfeti — yalnız "accent" prop'una bağlı; memo ile her saniyelik render'da 18 düğüm YENİDEN kurulmaz.
const Confetti = memo(function Confetti({ accent }: { accent: string }) {
  const colors = ["#e23b3b", "#2b6cf0", "#15c47e", "#f5b400", "#9b5de5", accent];
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden z-10">
      {Array.from({ length: 18 }).map((_, i) => {
        const left = (i * 53) % 100;
        const delay = (i % 6) * 0.1;
        const dur = 1.2 + (i % 5) * 0.22;
        return <span key={i} className="absolute -top-2 h-2 w-1.5 rounded-[1px]" style={{ left: `${left}%`, background: colors[i % colors.length], animation: `confetti-fall ${dur}s ease-in ${delay}s infinite` }} />;
      })}
    </div>
  );
});

function PrinterCard({
  printer, now, index, busy, onPause, onResume, onCancel, onStart, onMatch,
}: {
  printer: PanelPrinter; now: number; index: number; busy: boolean;
  onPause: () => void; onResume: () => void; onCancel: () => void; onStart: () => void; onMatch: () => void;
}) {
  const { job, status, accent, online } = printer;
  const isReal = printer.type !== "sim";

  // Gerçek snapshot değerleri (zaman-interpolasyonu DEĞİL). remainingSec endsAt'a
  // sabitlenmiş canlı geri sayım; progress/layer doğrudan yazıcıdan gelir.
  let progress = 0, remainingSec = 0, endMs = 0;
  let layerCurrent: number | null = null;
  if (job) {
    endMs = new Date(job.endsAt).getTime();
    progress = clamp(job.progress, 0, 1);
    remainingSec = now > 0 ? Math.max(0, (endMs - now) / 1000) : 0;
    layerCurrent = job.layerCurrent;
    if (status === "finished") { progress = 1; remainingSec = 0; }
  }
  const pct = Math.round(progress * 100);
  const finishingNow = status === "printing" && remainingSec <= 0.5;
  const isFinished = status === "finished";
  const isPrinting = status === "printing";
  const isPaused = status === "paused";
  const offline = isReal && !online;
  const isError = status === "error";

  const nozzle = printer.temps.nozzle; // gerçek değer (5sn poll); sahte sn-bazlı titreme kaldırıldı
  const bed = printer.temps.bed;
  const sm = STATUS_META[status];

  return (
    <Card
      className={cn(
        "relative overflow-hidden animate-in fade-in slide-in-from-bottom-3 duration-500",
        offline && "opacity-70",
        isError && "border-destructive/55 ring-1 ring-destructive/35 shadow-[0_10px_34px_-10px] shadow-destructive/40"
      )}
      style={{
        animationDelay: `${index * 80}ms`, animationFillMode: "both",
        borderColor: isPrinting && online ? alpha(accent, 35) : undefined,
        boxShadow: isPrinting && online ? `0 0 0 1px ${alpha(accent, 18)}, 0 8px 30px ${alpha(accent, 12)}` : undefined,
      }}
    >
      {isPrinting && online && (
        <div className="absolute inset-x-0 top-0 h-[2px] overflow-hidden">
          <div className="h-full w-1/3" style={{ background: accent, animation: "indeterminate-bar 2.2s ease-in-out infinite", boxShadow: `0 0 8px ${accent}` }} />
        </div>
      )}
      {isError && <div className="absolute inset-x-0 top-0 h-[3px] bg-destructive" />}
      {isFinished && online && <Confetti accent={accent} />}

      <CardContent className="p-4 space-y-3.5">
        {/* Acil: baskı durdu / yazıcı hatası */}
        {isError && (
          <div className="flex items-center gap-2.5 rounded-lg border border-destructive/45 bg-destructive/10 px-3 py-2">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0 motion-safe:animate-pulse" />
            <div className="min-w-0">
              <p className="text-xs font-bold text-destructive leading-tight">Baskı durdu — yazıcıda sorun var</p>
              <p className="text-[11px] text-destructive/80 truncate">
                {job?.productName ? `${job.productName} · ` : ""}kontrol et
              </p>
            </div>
          </div>
        )}

        {/* Üst: marka + durum */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex items-center justify-center h-9 w-9 rounded-lg shrink-0" style={{ backgroundColor: alpha(accent, 14), border: `1px solid ${alpha(accent, 30)}` }}>
              <Printer className="h-4 w-4" style={{ color: accent }} />
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-sm truncate leading-tight">{printer.name}</p>
              <p className="text-[11px] text-muted-foreground truncate">{printer.model || printer.brand}</p>
            </div>
          </div>
          {offline ? (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold border shrink-0 bg-muted text-muted-foreground border-border">
              <WifiOff className="h-3 w-3" /> Çevrimdışı
            </span>
          ) : (
            <span
              className={cn("inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold border shrink-0", sm.cls)}
              style={isPrinting ? { backgroundColor: alpha(accent, 14), color: accent, borderColor: alpha(accent, 30) } : undefined}
            >
              {isPrinting && <span className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: accent }} />}
              {isFinished && <Sparkles className="h-3 w-3" />}
              {isError && <AlertTriangle className="h-3 w-3" />}
              {sm.label}
            </span>
          )}
        </div>

        {/* Gövde */}
        {offline ? (
          <div className="flex items-center gap-3.5 py-4">
            <div className="flex items-center justify-center h-20 w-20 shrink-0 rounded-xl border border-dashed bg-muted/30">
              <WifiOff className="h-7 w-7 text-muted-foreground/30" />
            </div>
            <div className="flex-1 text-sm text-muted-foreground">
              <p className="font-medium text-foreground/70">Bağlantı yok</p>
              <p className="text-xs mt-0.5">{printer.note ?? "Yazıcıya ulaşılamadı."}</p>
            </div>
          </div>
        ) : job ? (
          <div className="flex gap-3.5">
            <PrintInImage image={job.productImage} productName={job.productName} progress={progress} accent={accent} printing={isPrinting} />
            <div className="flex-1 min-w-0 space-y-2">
              <p className="text-sm font-medium leading-snug line-clamp-2">{job.productName}</p>
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground tabular-nums">
                {job.layerTotal > 0 && layerCurrent != null && (
                  <span className="inline-flex items-center gap-1"><Layers className="h-3.5 w-3.5" /> {layerCurrent}/{job.layerTotal}</span>
                )}
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full border border-black/10" style={{ background: job.filamentColor }} />
                  {job.filamentType}
                </span>
              </div>
              <div className="flex items-center gap-3 text-[11px] tabular-nums">
                <span className="inline-flex items-center gap-1" style={{ color: nozzle > 60 ? "oklch(0.65 0.2 35)" : undefined }}>
                  <Flame className="h-3.5 w-3.5" /> {nozzle}°<span className="text-muted-foreground/60">/ {printer.temps.nozzleTarget || "—"}</span>
                </span>
                <span className="inline-flex items-center gap-1 text-muted-foreground">Tabla {bed}°</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3.5 py-2">
            <div className="flex items-center justify-center h-28 w-28 shrink-0 rounded-xl border border-dashed bg-muted/30">
              <Box className="h-9 w-9 text-muted-foreground/30" />
            </div>
            <div className="flex-1 text-sm text-muted-foreground">
              <p className="font-medium text-foreground/70">{status === "error" ? "Hata" : "Hazır"}</p>
              <p className="text-xs mt-0.5">{status === "error" ? "Yazıcıda bir sorun var." : "Baskı bekleniyor…"}</p>
              <p className="text-[11px] mt-2 text-muted-foreground/70 tabular-nums">Nozzle {nozzle}° · Tabla {bed}°</p>
            </div>
          </div>
        )}

        {/* Progress */}
        {job && !offline && (
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
                {isPrinting && <div className="absolute inset-0" style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent)", animation: "printer-shimmer 1.6s linear infinite" }} />}
              </div>
            </div>
            <div className="flex items-center justify-between text-xs tabular-nums">
              <span className="font-bold text-sm" style={{ color: isFinished ? "oklch(0.72 0.18 145)" : accent }}>
                {isFinished ? "Tamamlandı 🎉" : `%${pct}`}
              </span>
              <span className="text-muted-foreground inline-flex items-center gap-1">
                {isFinished ? (<><CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> Baskı bitti</>)
                  : finishingNow ? (<><Loader2 className="h-3.5 w-3.5 animate-spin" /> Tamamlanıyor…</>)
                    : (<><Clock className="h-3.5 w-3.5" /> {fmtRemaining(remainingSec)} kaldı · ~{fmtClock(endMs, now)}</>)}
              </span>
            </div>
          </div>
        )}

        {/* Kontroller — sadece gerçek + çevrimiçi yazıcılarda */}
        {isReal && online && (
          <div className="flex items-center gap-1.5 pt-0.5 border-t border-border/50 mt-1">
            <div className="flex items-center gap-1.5 pt-2 flex-wrap">
              {isPrinting && (
                <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={busy} onClick={onPause}>
                  <Pause className="h-3.5 w-3.5" /> Duraklat
                </Button>
              )}
              {isPaused && (
                <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={busy} onClick={onResume}>
                  <Play className="h-3.5 w-3.5" /> Devam
                </Button>
              )}
              {(isPrinting || isPaused) && (
                <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs text-destructive hover:text-destructive hover:bg-destructive/10" disabled={busy} onClick={onCancel}>
                  <Ban className="h-3.5 w-3.5" /> İptal
                </Button>
              )}
              {(printer.type === "moonraker" || printer.type === "bambu") && (status === "idle" || status === "finished" || status === "error") && (
                <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={busy} onClick={onStart}>
                  <Play className="h-3.5 w-3.5" /> Baskı Başlat
                </Button>
              )}
              {job && (
                <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs ml-auto" onClick={onMatch} title="Bu baskıyı bir ürünle eşleştir">
                  <Link2 className="h-3.5 w-3.5" />
                  {printer.matchedProductId ? "Ürünü değiştir" : "Ürün seç"}
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PrintInImage({ image, productName, progress, accent, printing }: { image: string | null; productName: string; progress: number; accent: string; printing: boolean }) {
  const pct = Math.round(progress * 100);
  return (
    <div className="relative h-28 w-28 shrink-0 rounded-xl overflow-hidden border bg-muted/40">
      {image ? (
        <>
          <img src={image} alt="" className="absolute inset-0 h-full w-full object-cover opacity-25 grayscale" />
          <img src={image} alt={productName} className="absolute inset-0 h-full w-full object-cover transition-[clip-path] duration-1000 ease-linear" style={{ clipPath: `inset(${100 - pct}% 0 0 0)` }} />
        </>
      ) : (
        <>
          <Box className="absolute inset-0 m-auto h-10 w-10 text-muted-foreground/25" />
          <div className="absolute inset-x-0 bottom-0 transition-[height] duration-1000 ease-linear" style={{ height: `${pct}%`, background: `linear-gradient(0deg, ${alpha(accent, 22)}, transparent)` }} />
        </>
      )}
      {printing && pct < 100 && (
        <div className="absolute inset-x-0 h-[2px] transition-[bottom] duration-1000 ease-linear" style={{ bottom: `${pct}%`, background: accent, boxShadow: `0 0 10px 1px ${accent}` }} />
      )}
    </div>
  );
}

// ───────────────────────── Yönet (yapılandırma) modalı ─────────────────────────

const BRANDS = [
  { value: "elegoo", label: "Elegoo", type: "moonraker", port: 7125 },
  { value: "snapmaker", label: "Snapmaker", type: "moonraker", port: 7125 },
  { value: "bambu", label: "Bambu Lab", type: "bambu", port: 8883 },
];

function ManageModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: configs = [], isLoading } = useQuery<PrinterConfig[]>({
    queryKey: ["printer-configs"],
    queryFn: () => fetchJson<PrinterConfig[]>("/api/printers/config"),
  });
  const [editing, setEditing] = useState<PrinterConfig | "new" | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["printer-configs"] });
    qc.invalidateQueries({ queryKey: ["printers"] });
  };

  const del = useMutation({
    mutationFn: (id: string) => fetchJson(`/api/printers/config/${id}`, { method: "DELETE" }),
    onSuccess: () => { refresh(); toast.success("Yazıcı silindi"); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Yazıcıları Yönet</DialogTitle>
        </DialogHeader>

        {editing ? (
          <PrinterForm
            config={editing === "new" ? null : editing}
            onCancel={() => setEditing(null)}
            onSaved={() => { setEditing(null); refresh(); }}
          />
        ) : (
          <div className="space-y-3">
            {isLoading ? (
              <div className="py-6 text-center text-muted-foreground"><Loader2 className="h-4 w-4 mx-auto animate-spin" /></div>
            ) : configs.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">Henüz yazıcı eklenmedi.</p>
            ) : (
              <div className="space-y-2">
                {configs.map((c) => (
                  <div key={c.id} className="flex items-center gap-3 rounded-lg border p-2.5">
                    <div className="flex items-center justify-center h-8 w-8 rounded-md bg-muted shrink-0">
                      <Printer className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{c.name}</p>
                      <p className="text-[11px] text-muted-foreground font-mono truncate">
                        {c.host}:{c.port} · {c.type === "bambu" ? "Bambu" : "Moonraker"}
                      </p>
                    </div>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(c)} title="Düzenle">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive/70 hover:text-destructive" disabled={del.isPending} onClick={() => del.mutate(c.id)} title="Sil">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <Button variant="outline" className="w-full gap-2" onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4" /> Yazıcı Ekle
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PrinterForm({ config, onCancel, onSaved }: { config: PrinterConfig | null; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState(config?.name ?? "");
  const [brand, setBrand] = useState(config?.brand ?? "elegoo");
  const [model, setModel] = useState(config?.model ?? "");
  const [host, setHost] = useState(config?.host ?? "");
  const [port, setPort] = useState(String(config?.port ?? 7125));
  const [accessCode, setAccessCode] = useState(config?.accessCode ?? "");
  const [serial, setSerial] = useState(config?.serial ?? "");
  const [test, setTest] = useState<{ state: "idle" | "loading" | "ok" | "fail"; msg?: string }>({ state: "idle" });

  const brandInfo = BRANDS.find((b) => b.value === brand) ?? BRANDS[0];
  const isBambu = brandInfo.type === "bambu";
  const bambuMissing = isBambu && (!accessCode.trim() || !serial.trim());

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        brand,
        model: model.trim() || null,
        type: brandInfo.type,
        host: host.trim(),
        port: Number(port) || brandInfo.port,
        accessCode: isBambu ? (accessCode.trim() || null) : null,
        serial: isBambu ? (serial.trim() || null) : null,
      };
      return config
        ? fetchJson(`/api/printers/config/${config.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        : fetchJson("/api/printers/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    },
    onSuccess: () => { toast.success(config ? "Yazıcı güncellendi" : "Yazıcı eklendi"); onSaved(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const runTest = async () => {
    if (!host.trim()) { toast.error("Önce IP/host gir"); return; }
    setTest({ state: "loading" });
    try {
      const r = await fetchJson<{ ok: boolean; hostname?: string; port?: number; error?: string }>(
        `/api/printers/test?host=${encodeURIComponent(host.trim())}&port=${Number(port) || 7125}`
      );
      if (r.ok) {
        if (r.port && r.port !== Number(port)) setPort(String(r.port)); // Elegoo → 80'e otomatik düzelt
        setTest({ state: "ok", msg: r.port ? `port ${r.port}${r.hostname ? ` · ${r.hostname}` : ""}` : r.hostname });
      } else {
        setTest({ state: "fail", msg: r.error });
      }
    } catch (e) {
      setTest({ state: "fail", msg: e instanceof Error ? e.message : "hata" });
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <Label className="text-xs">Ad</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Neptune 4 Pro" autoFocus />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Marka</Label>
          <select
            value={brand}
            onChange={(e) => { setBrand(e.target.value); const bi = BRANDS.find((b) => b.value === e.target.value); if (bi && (!config || String(config.port) === port)) setPort(String(bi.port)); }}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {BRANDS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        </div>
        <div>
          <Label className="text-xs">Model (ops.)</Label>
          <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Neptune 4 Pro" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <Label className="text-xs">IP / Host</Label>
          <Input value={host} onChange={(e) => { setHost(e.target.value); setTest({ state: "idle" }); }} placeholder="192.168.1.18" className="font-mono" />
        </div>
        <div>
          <Label className="text-xs">Port</Label>
          <Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </div>
      </div>

      {isBambu ? (
        <>
          <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
            Yazıcıda <strong>LAN Modu</strong> + <strong>Geliştirici (Developer) Modu</strong> açık olmalı. Access code ve seri no yazıcı ekranındadır (Ayarlar → WLAN).
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Access Code</Label>
              <Input value={accessCode} onChange={(e) => setAccessCode(e.target.value)} placeholder="8 haneli kod" className="font-mono" />
            </div>
            <div>
              <Label className="text-xs">Seri No</Label>
              <Input value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="00M00A..." className="font-mono" />
            </div>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={test.state === "loading"} onClick={runTest}>
            {test.state === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Bağlantıyı Test Et
          </Button>
          {test.state === "ok" && <span className="text-xs text-green-600 dark:text-green-400 inline-flex items-center gap-1"><Check className="h-3.5 w-3.5" /> Bağlandı{test.msg ? ` (${test.msg})` : ""}</span>}
          {test.state === "fail" && <span className="text-xs text-destructive inline-flex items-center gap-1"><X className="h-3.5 w-3.5" /> {test.msg || "Bağlanılamadı"}</span>}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <Button className="flex-1" disabled={save.isPending || !name.trim() || !host.trim() || bambuMissing} onClick={() => save.mutate()}>
          {save.isPending ? "Kaydediliyor…" : config ? "Güncelle" : "Ekle"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>Vazgeç</Button>
      </div>
    </div>
  );
}

// ───────────────────────── Ürün eşleştirme modalı ─────────────────────────

interface PickProduct { id: string; name: string; imageUrl: string | null; currentSalePrice: number }

function MatchModal({ target, onClose }: { target: { id: string; filename: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery<PickProduct[]>({
    queryKey: ["products", "printer-match"],
    queryFn: () => fetchJson<PickProduct[]>("/api/products?filter=all"),
  });
  const [q, setQ] = useState("");

  const list = useMemo(() => {
    const all = Array.isArray(data) ? data : [];
    const query = q.trim().toLocaleLowerCase("tr-TR");
    return all.filter((p) => !query || p.name.toLocaleLowerCase("tr-TR").includes(query)).slice(0, 50);
  }, [data, q]);

  const match = useMutation({
    mutationFn: (productId: string | null) =>
      fetchJson(`/api/printers/${target.id}/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: target.filename, productId }),
      }),
    onSuccess: (_d, productId) => {
      qc.invalidateQueries({ queryKey: ["printers"] });
      toast.success(productId ? "Ürün eşleştirildi" : "Eşleştirme kaldırıldı");
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Baskıyı ürünle eşleştir</DialogTitle>
          <p className="text-[11px] text-muted-foreground font-mono truncate mt-1">{target.filename}</p>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ürün ara…" className="pl-8 h-9" autoFocus />
        </div>
        <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-0.5 min-h-[120px]">
          {list.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">Ürün bulunamadı.</p>
          ) : (
            list.map((p) => (
              <button key={p.id} onClick={() => match.mutate(p.id)} disabled={match.isPending} className="w-full flex items-center gap-2.5 p-1.5 rounded-lg hover:bg-muted text-left disabled:opacity-50">
                <div className="h-9 w-9 shrink-0 rounded-md border bg-muted flex items-center justify-center overflow-hidden">
                  {p.imageUrl ? <img src={p.imageUrl} alt="" className="max-w-full max-h-full object-contain" /> : <Package className="h-4 w-4 text-muted-foreground/40" />}
                </div>
                <span className="flex-1 min-w-0 text-sm truncate">{p.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums shrink-0">{formatCurrency(p.currentSalePrice)}</span>
              </button>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={match.isPending} onClick={() => match.mutate(null)}>Eşleştirmeyi kaldır</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Baskı başlat (dosya seç) modalı ─────────────────────────

// ── Baskı seçici hiyerarşisi: ürün/grup → varyant → dosya ──────────────────────────
interface PickFileMember { productId: string; label: string; image: string | null; files: PrintableModel[] }
type PickNode =
  | { kind: "solo"; key: string; name: string; image: string | null; searchText: string; files: PrintableModel[] }
  | { kind: "group"; key: string; name: string; image: string | null; searchText: string; members: PickFileMember[]; sharedFiles: PrintableModel[]; allShared: boolean; variantCount: number };

/** Düz dosya listesini ürün/grup düğümlerine çevirir; varyantların ORTAK dosyalarını (shareKey)
 *  tekilleştirir → "aynı dosyaysa tek dosya göster". Boy gibi farklı dosyalı varyantlar ayrı kalır. */
function buildPickNodes(models: PrintableModel[]): PickNode[] {
  const lower = (s: string) => s.toLocaleLowerCase("tr-TR");
  const tops = new Map<string, PrintableModel[]>();
  for (const m of models) {
    const key = m.variantGroupId ? `g:${m.variantGroupId}` : `s:${m.productId}`;
    const arr = tops.get(key);
    if (arr) arr.push(m); else tops.set(key, [m]);
  }
  const nodes: PickNode[] = [];
  for (const [key, list] of tops) {
    if (key.startsWith("s:")) {
      const f = list[0];
      nodes.push({
        kind: "solo", key, name: f.productName, image: f.imageUrl,
        searchText: lower([f.productName, f.alias ?? "", f.originalName].join(" ")),
        files: list,
      });
      continue;
    }
    const byProduct = new Map<string, PrintableModel[]>();
    for (const m of list) { const a = byProduct.get(m.productId); if (a) a.push(m); else byProduct.set(m.productId, [m]); }
    const members: PickFileMember[] = [...byProduct.entries()].map(([pid, files]) => ({
      productId: pid, label: files[0].variantLabel || files[0].productName, image: files[0].imageUrl, files,
    }));
    const byShare = new Map<string, PrintableModel[]>();
    for (const m of list) { const k = m.shareKey || m.fileId; const a = byShare.get(k); if (a) a.push(m); else byShare.set(k, [m]); }
    const buckets = [...byShare.values()];
    const sharedBuckets = buckets.filter((b) => new Set(b.map((x) => x.productId)).size >= 2);
    const soloBuckets = buckets.filter((b) => new Set(b.map((x) => x.productId)).size < 2);
    const allShared = soloBuckets.length === 0 && sharedBuckets.length > 0;
    const name = list[0].variantGroupName || list[0].productName;
    nodes.push({
      kind: "group", key, name, image: members[0]?.image ?? null,
      searchText: lower([name, ...members.map((mm) => mm.label), ...list.map((x) => x.alias ?? "")].join(" ")),
      members, sharedFiles: sharedBuckets.map((b) => b[0]), allShared, variantCount: members.length,
    });
  }
  nodes.sort((a, b) => a.name.localeCompare(b.name, "tr-TR"));
  return nodes;
}

function NodeRow({ node, disabled, onClick }: { node: PickNode; disabled: boolean; onClick: () => void }) {
  const isGroup = node.kind === "group";
  const drillable = isGroup || (node.kind === "solo" && node.files.length > 1);
  return (
    <button onClick={onClick} disabled={disabled} className="w-full flex items-center gap-2.5 p-2 rounded-lg hover:bg-muted text-left disabled:opacity-50">
      <div className="h-9 w-9 shrink-0 rounded-md border bg-muted flex items-center justify-center overflow-hidden">
        {node.image ? <img src={node.image} alt="" className="max-w-full max-h-full object-contain" /> : <Package className="h-4 w-4 text-muted-foreground/40" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm truncate">{node.name}</p>
        <p className="text-[10px] text-muted-foreground flex items-center gap-1.5 truncate">
          {isGroup ? (
            <><Layers className="h-3 w-3 shrink-0" /> {node.variantCount} varyant{node.allShared ? " · ortak dosya" : ""}</>
          ) : node.files.length > 1 ? (
            <>{node.files.length} parça</>
          ) : (
            <span className="font-mono truncate">{node.files[0]?.originalName}</span>
          )}
        </p>
      </div>
      {drillable ? <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" /> : <Play className="h-4 w-4 text-primary shrink-0" />}
    </button>
  );
}

function FileRow({ m, idx, disabled, onClick }: { m: PrintableModel; idx: number; disabled: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={disabled} className="w-full flex items-center gap-2.5 p-2 rounded-lg hover:bg-muted text-left disabled:opacity-50">
      <span className="flex items-center justify-center h-7 w-7 rounded bg-primary/10 text-primary text-[11px] font-bold tabular-nums shrink-0">{idx + 1}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm truncate">{m.label || m.originalName}</p>
        <p className="text-[10px] text-muted-foreground font-mono truncate">{m.originalName}{m.gramaj ? ` · ${m.gramaj} gr` : ""}</p>
      </div>
      <Play className="h-4 w-4 text-primary shrink-0" />
    </button>
  );
}

function StartModal({ target, onClose }: { target: { id: string; name: string; brand: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const multiColor = target.brand === "bambu" || target.brand === "snapmaker";
  const isBambu = target.brand === "bambu";
  const { data, isLoading, isError, error } = useQuery<{ models: PrintableModel[] }>({
    queryKey: ["printable-models", target.id],
    queryFn: () => fetchJson<{ models: PrintableModel[] }>(`/api/printers/${target.id}/printable-models`),
  });
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<PrintableModel | null>(null);
  const [printing, setPrinting] = useState(false);
  const [progress, setProgress] = useState<PrintProg | null>(null);
  // Gezinme: liste → (grup) → (varyant) → dosya
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [openVariant, setOpenVariant] = useState<string | null>(null);

  const runPrint = async (fileId: string, opts: { amsMapping?: number[]; useAms?: boolean; prefs?: PrintPrefs } = {}) => {
    setPrinting(true);
    setProgress({ stage: "upload", pct: 0 });
    try {
      await runPrintStream(fileId, opts, setProgress);
      toast.success("Baskı başlatıldı 🎉");
      onClose();
      setTimeout(() => qc.invalidateQueries({ queryKey: ["printers"] }), 800);
    } catch (e) {
      toast.error((e as Error).message);
      setProgress(null);
    } finally {
      setPrinting(false);
    }
  };

  const nodes = useMemo(() => buildPickNodes(data?.models ?? []), [data]);
  const filtered = useMemo(() => {
    const query = q.trim().toLocaleLowerCase("tr-TR");
    return (query ? nodes.filter((n) => n.searchText.includes(query)) : nodes).slice(0, 200);
  }, [nodes, q]);

  const openNode = nodes.find((n) => n.key === openKey) ?? null;
  const openMember = openNode?.kind === "group" ? openNode.members.find((m) => m.productId === openVariant) ?? null : null;
  const pickFile = (m: PrintableModel) => (multiColor ? setPicked(m) : runPrint(m.fileId));

  if (picked) {
    return (
      <SlotStep printerId={target.id} model={picked} isBambu={isBambu} printing={printing} progress={progress}
        onBack={() => setPicked(null)} onClose={onClose} onConfirm={(opts) => runPrint(picked.fileId, opts)} />
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !printing && onClose()}>
      <DialogContent className="max-w-md max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Baskı Başlat — {target.name}</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1 truncate">
            {openNode
              ? (openMember ? `${openNode.name} · ${openMember.label}` : openNode.name)
              : multiColor ? "Ürün seç → varyant/dosya → renk." : "Ürün seç → dosya; yazıcıya yüklenip baskı başlar."}
          </p>
        </DialogHeader>

        {openNode ? (
          <button
            onClick={() => (openVariant ? setOpenVariant(null) : setOpenKey(null))}
            className="flex items-center gap-1 text-xs text-primary hover:underline w-fit"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Geri
          </button>
        ) : (
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ürün veya takma ad ara…" className="pl-8 h-9" autoFocus />
          </div>
        )}

        <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-0.5 min-h-[140px]">
          {isLoading ? (
            <div className="py-8 text-center text-muted-foreground"><Loader2 className="h-4 w-4 mx-auto animate-spin" /></div>
          ) : isError ? (
            <p className="text-xs text-destructive text-center py-6">{(error as Error)?.message || "Modeller alınamadı"}</p>
          ) : !openNode ? (
            filtered.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-xs text-muted-foreground">{q ? "Eşleşen ürün yok." : "Bu yazıcı için yüklenmiş model yok."}</p>
                <p className="text-[11px] text-muted-foreground/70 mt-1">Bir ürünün sayfasından bu yazıcı için baskı dosyası yükle.</p>
              </div>
            ) : (
              filtered.map((n) => (
                <NodeRow key={n.key} node={n} disabled={printing}
                  onClick={() => {
                    if (n.kind === "solo" && n.files.length === 1) pickFile(n.files[0]);
                    else { setOpenKey(n.key); setOpenVariant(null); }
                  }}
                />
              ))
            )
          ) : openNode.kind === "solo" ? (
            openNode.files.map((m, i) => <FileRow key={m.fileId} m={m} idx={i} disabled={printing} onClick={() => pickFile(m)} />)
          ) : openMember ? (
            openMember.files.map((m, i) => <FileRow key={m.fileId} m={m} idx={i} disabled={printing} onClick={() => pickFile(m)} />)
          ) : openNode.allShared ? (
            <>
              <p className="text-[11px] text-muted-foreground px-1 py-1">Tüm varyantlarda ortak — bir kez seç, hepsi için aynı dosya.</p>
              {openNode.sharedFiles.map((m, i) => <FileRow key={m.fileId} m={m} idx={i} disabled={printing} onClick={() => pickFile(m)} />)}
            </>
          ) : (
            openNode.members.map((mem) => (
              <button key={mem.productId} disabled={printing} onClick={() => setOpenVariant(mem.productId)}
                className="w-full flex items-center gap-2.5 p-2 rounded-lg hover:bg-muted text-left disabled:opacity-50">
                <div className="h-9 w-9 shrink-0 rounded-md border bg-muted flex items-center justify-center overflow-hidden">
                  {mem.image ? <img src={mem.image} alt="" className="max-w-full max-h-full object-contain" /> : <Package className="h-4 w-4 text-muted-foreground/40" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm truncate">{mem.label}</p>
                  <p className="text-[10px] text-muted-foreground">{mem.files.length} parça</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </button>
            ))
          )}
        </div>
        {progress && <PrintProgress p={progress} />}
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Özel Baskı (ürüne bağlı olmayan ad-hoc baskı) ─────────────────────────
function fmtDur(min: number | null): string {
  if (!min || min <= 0) return "—";
  const h = Math.floor(min / 60), m = min % 60;
  return h > 0 ? `${h}sa ${m}dk` : `${m}dk`;
}
interface CustomUpload {
  fileId: string; originalName: string; fileKind: "gcode" | "3mf" | "other";
  sizeBytes: number; grams: number | null; estPrintMin: number | null; thumbnail: string | null; colorCount: number;
}
function CustomPrintModal({ printers, onClose }: { printers: PanelPrinter[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<{ id: string; name: string; brand: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState<CustomUpload | null>(null);
  const [slotMode, setSlotMode] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [progress, setProgress] = useState<PrintProg | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const printable = useMemo(() => printers.filter((p) => p.type !== "sim"), [printers]);
  const isBambu = picked?.brand === "bambu";
  const multiColor = picked?.brand === "bambu" || picked?.brand === "snapmaker";

  const upload = async (f: File) => {
    if (!picked) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("printerConfigId", picked.id);
      const res = await fetch("/api/custom-print/upload", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "Yüklenemedi");
      setFile(data as CustomUpload);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  // NDJSON akışlı baskı (StartModal ile aynı mantık).
  const runPrint = async (fileId: string, opts: { amsMapping?: number[]; useAms?: boolean; prefs?: PrintPrefs } = {}) => {
    setPrinting(true);
    setProgress({ stage: "upload", pct: 0 });
    try {
      const res = await fetch(`/api/models/${fileId}/print`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amsMapping: opts.amsMapping, useAms: opts.useAms, prefs: opts.prefs }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = ""; let errMsg: string | null = null; let ok = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: { stage: string; pct?: number | null; message?: string };
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.stage === "error") errMsg = ev.message || "Baskı başlatılamadı";
          else if (ev.stage === "done") ok = true;
          else if (ev.stage === "status" || ev.stage === "start" || ev.stage === "confirm") setProgress({ stage: ev.stage, pct: null });
          else setProgress({ stage: "upload", pct: ev.pct ?? null });
        }
      }
      if (errMsg) throw new Error(errMsg);
      if (!ok) throw new Error("Baskı tamamlanmadı (akış beklenmedik kapandı)");
      setProgress({ stage: "done", pct: 100 });
      toast.success("Baskı başlatıldı 🎉");
      onClose();
      setTimeout(() => qc.invalidateQueries({ queryKey: ["printers"] }), 800);
    } catch (e) {
      toast.error((e as Error).message);
      setProgress(null);
    } finally {
      setPrinting(false);
    }
  };

  // Renk eşleme adımı (Bambu/Snapmaker) — mevcut SlotStep'i yeniden kullan.
  if (slotMode && file && picked) {
    const model: PrintableModel = {
      fileId: file.fileId, productId: "__custom__", productName: file.originalName,
      imageUrl: file.thumbnail, label: null, originalName: file.originalName, sizeBytes: file.sizeBytes, gramaj: file.grams,
    };
    return (
      <SlotStep
        printerId={picked.id} model={model} isBambu={isBambu} printing={printing} progress={progress}
        onBack={() => setSlotMode(false)} onClose={onClose} onConfirm={(opts) => runPrint(file.fileId, opts)}
      />
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !printing && !uploading && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Upload className="h-4 w-4 text-primary" /> Özel Baskı</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            {!picked ? "Baskı yapacağın yazıcıyı seç." : !file ? "Bu yazıcı için gcode/3mf dosyası yükle." : "Önizle ve bas."}
          </p>
        </DialogHeader>

        {!picked ? (
          <div className="space-y-1.5 max-h-[55vh] overflow-y-auto -mx-1 px-1">
            {printable.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-6">Bağlı yazıcı yok.</p>
            ) : (
              printable.map((p) => {
                const busy = p.status === "printing" || p.status === "paused";
                return (
                  <button
                    key={p.id} disabled={busy}
                    onClick={() => setPicked({ id: p.id, name: p.name, brand: p.brand })}
                    className="w-full flex items-center gap-2.5 p-2 rounded-lg border hover:bg-muted text-left disabled:opacity-50"
                  >
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: p.online ? p.accent : "#9ca3af" }} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{p.name}</p>
                      <p className="text-[10px] text-muted-foreground">{p.model || p.brand}{busy ? " · meşgul" : !p.online ? " · çevrimdışı" : ""}</p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </button>
                );
              })
            )}
          </div>
        ) : !file ? (
          <div className="space-y-3">
            <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs flex items-center gap-2">
              <Printer className="h-3.5 w-3.5 text-primary" /> {picked.name}
              <button onClick={() => setPicked(null)} className="ml-auto text-primary hover:underline">değiştir</button>
            </div>
            <input ref={fileRef} type="file" accept=".gcode,.gco,.g,.3mf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
            <button
              onClick={() => fileRef.current?.click()} disabled={uploading}
              className="w-full rounded-xl border-2 border-dashed py-10 flex flex-col items-center gap-2 hover:border-primary/40 hover:bg-primary/[0.03] transition-colors disabled:opacity-60"
            >
              {uploading ? <Loader2 className="h-6 w-6 animate-spin text-primary" /> : <FileBox className="h-6 w-6 text-muted-foreground/50" />}
              <span className="text-sm font-medium">{uploading ? "Yükleniyor…" : "gcode / 3mf seç"}</span>
              <span className="text-[11px] text-muted-foreground">{isBambu ? "Bambu çok renkli için dilimlenmiş .3mf" : "dosyayı seçmek için tıkla"}</span>
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-3">
              <div className="h-24 w-24 shrink-0 rounded-xl border bg-muted flex items-center justify-center overflow-hidden">
                {file.thumbnail ? <img src={file.thumbnail} alt="" className="max-w-full max-h-full object-contain" /> : <Box className="h-8 w-8 text-muted-foreground/30" />}
              </div>
              <div className="min-w-0 flex-1 space-y-1.5">
                <p className="text-sm font-medium truncate" title={file.originalName}>{file.originalName}</p>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
                  <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {fmtDur(file.estPrintMin)}</span>
                  <span className="inline-flex items-center gap-1"><Weight className="h-3 w-3" /> {file.grams != null ? `${Math.round(file.grams)} g` : "—"}</span>
                  {file.colorCount > 0 && <span className="inline-flex items-center gap-1"><Layers className="h-3 w-3" /> {file.colorCount} renk</span>}
                </div>
                <p className="text-[10px] text-muted-foreground/70 inline-flex items-center gap-1"><Printer className="h-3 w-3" /> {picked.name}</p>
              </div>
            </div>
            {progress && <PrintProgress p={progress} />}
            <DialogFooter className="gap-2">
              <Button variant="ghost" onClick={() => { setFile(null); setProgress(null); }} disabled={printing}>Geri</Button>
              {multiColor ? (
                <Button onClick={() => setSlotMode(true)} disabled={printing} className="gap-1.5"><Layers className="h-4 w-4" /> Renk ayarına geç</Button>
              ) : (
                <Button onClick={() => runPrint(file.fileId)} disabled={printing} className="gap-1.5">
                  {printing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Bas
                </Button>
              )}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
