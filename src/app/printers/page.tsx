"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Printer, Box, Flame, Layers, Clock, CheckCircle2, Loader2, Sparkles, Power,
  RefreshCw, Settings2, Plus, Trash2, Pause, Play, Ban, Pencil, WifiOff,
  Check, X, Search, Package, Link2, Minus, ArrowRight, AlertTriangle,
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

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const [manageOpen, setManageOpen] = useState(false);
  const [matchTarget, setMatchTarget] = useState<{ id: string; filename: string } | null>(null);
  const [startTarget, setStartTarget] = useState<{ id: string; name: string; brand: string } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<{ id: string; name: string } | null>(null);

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
    remainingSec = Math.max(0, (endMs - now) / 1000);
    layerCurrent = job.layerCurrent;
    if (status === "finished") { progress = 1; remainingSec = 0; }
  }
  const pct = Math.round(progress * 100);
  const finishingNow = status === "printing" && remainingSec <= 0.5;
  const isFinished = status === "finished";
  const isPrinting = status === "printing";
  const isPaused = status === "paused";
  const offline = isReal && !online;

  const nozzle = printer.temps.nozzleTarget > 0 ? printer.temps.nozzle + Math.round(Math.sin(now / 800 + index) * 1.5) : printer.temps.nozzle;
  const bed = printer.temps.bedTarget > 0 ? printer.temps.bed + Math.round(Math.cos(now / 1100 + index) * 1) : printer.temps.bed;
  const sm = STATUS_META[status];

  return (
    <Card
      className={cn("relative overflow-hidden animate-in fade-in slide-in-from-bottom-3 duration-500", offline && "opacity-70")}
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
      {isFinished && online && <Confetti accent={accent} />}

      <CardContent className="p-4 space-y-3.5">
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

function Confetti({ accent }: { accent: string }) {
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

interface PrintableModel { fileId: string; productId: string; productName: string; imageUrl: string | null; label: string | null; originalName: string; sizeBytes: number; gramaj: number | null }
interface PrinterSlot { slot: number; color: string; type: string; empty?: boolean }

type PrintProg = { stage: "upload" | "start" | "done"; pct: number | null };

function PrintProgress({ p }: { p: PrintProg }) {
  const label = p.stage === "start" ? "Baskı başlatılıyor…" : p.stage === "done" ? "Başlatıldı 🎉" : "Yazıcıya yükleniyor…";
  const showPct = p.stage === "upload" && p.pct != null;
  return (
    <div className="space-y-1.5 rounded-lg border bg-muted/30 p-2.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground flex items-center gap-1.5">
          {p.stage !== "done" && <Loader2 className="h-3 w-3 animate-spin" />}{label}
        </span>
        {showPct && <span className="tabular-nums font-semibold">{p.pct}%</span>}
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        {showPct ? (
          <div className="h-full bg-primary rounded-full transition-all duration-200" style={{ width: `${p.pct}%` }} />
        ) : (
          <div className="h-full w-1/2 bg-primary/70 rounded-full animate-pulse" />
        )}
      </div>
    </div>
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

  // POST → NDJSON akışı; her satır bir ilerleme olayı → progress bar'ı güncelle.
  const runPrint = async (fileId: string, opts: { amsMapping?: number[]; useAms?: boolean } = {}) => {
    setPrinting(true);
    setProgress({ stage: "upload", pct: 0 });
    try {
      const res = await fetch(`/api/models/${fileId}/print`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amsMapping: opts.amsMapping, useAms: opts.useAms }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let errMsg: string | null = null;
      let ok = false;
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
          else setProgress({ stage: ev.stage === "start" ? "start" : "upload", pct: ev.pct ?? null });
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

  const models = useMemo(() => {
    const all = data?.models ?? [];
    const query = q.trim().toLocaleLowerCase("tr-TR");
    return all.filter((m) => !query || m.productName.toLocaleLowerCase("tr-TR").includes(query)).slice(0, 100);
  }, [data, q]);

  if (picked) {
    return (
      <SlotStep
        printerId={target.id}
        model={picked}
        isBambu={isBambu}
        printing={printing}
        progress={progress}
        onBack={() => setPicked(null)}
        onClose={onClose}
        onConfirm={(opts) => runPrint(picked.fileId, opts)}
      />
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !printing && onClose()}>
      <DialogContent className="max-w-md max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Baskı Başlat — {target.name}</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            {multiColor ? "Modeli seç → sonraki adımda renk/slot." : "Modeli seç; dosya yazıcıya yüklenip baskı hemen başlar."}
          </p>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ürün ara…" className="pl-8 h-9" autoFocus />
        </div>
        <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-0.5 min-h-[140px]">
          {isLoading ? (
            <div className="py-8 text-center text-muted-foreground"><Loader2 className="h-4 w-4 mx-auto animate-spin" /></div>
          ) : isError ? (
            <p className="text-xs text-destructive text-center py-6">{(error as Error)?.message || "Modeller alınamadı"}</p>
          ) : models.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-xs text-muted-foreground">Bu yazıcı için yüklenmiş model yok.</p>
              <p className="text-[11px] text-muted-foreground/70 mt-1">Bir ürünün sayfasından bu yazıcı için baskı dosyası yükle.</p>
            </div>
          ) : (
            models.map((m) => (
              <button
                key={m.fileId}
                onClick={() => (multiColor ? setPicked(m) : runPrint(m.fileId))}
                disabled={printing}
                className="w-full flex items-center gap-2.5 p-2 rounded-lg hover:bg-muted text-left disabled:opacity-50"
              >
                <div className="h-9 w-9 shrink-0 rounded-md border bg-muted flex items-center justify-center overflow-hidden">
                  {m.imageUrl ? <img src={m.imageUrl} alt="" className="max-w-full max-h-full object-contain" /> : <Package className="h-4 w-4 text-muted-foreground/40" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm truncate">{m.productName}{m.label ? ` — ${m.label}` : ""}</p>
                  <p className="text-[10px] text-muted-foreground font-mono truncate">{m.originalName}</p>
                </div>
                <Play className="h-4 w-4 text-primary shrink-0" />
              </button>
            ))
          )}
        </div>
        {progress && <PrintProgress p={progress} />}
      </DialogContent>
    </Dialog>
  );
}

interface FileColor { index: number; hex: string; type: string; grams: number | null }
interface ColorInfo { colors: FileColor[]; source: string; fileKind: "gcode" | "3mf" | "other"; originalName?: string; missing?: boolean }

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** Gözle uyumlu ağırlıklı renk mesafesi (düşük = benzer). */
function colorDistance(a: string, b: string): number {
  const ra = hexToRgb(a), rb = hexToRgb(b);
  if (!ra || !rb) return Number.MAX_SAFE_INTEGER;
  const rmean = (ra[0] + rb[0]) / 2;
  const dr = ra[0] - rb[0], dg = ra[1] - rb[1], db = ra[2] - rb[2];
  return Math.sqrt((2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db);
}
function nearestSlotId(hex: string, slots: PrinterSlot[]): number | null {
  const usable = slots.filter((s) => !s.empty && hexToRgb(s.color));
  if (!usable.length) return null;
  let best = usable[0], bestD = colorDistance(hex, usable[0].color);
  for (const s of usable) { const d = colorDistance(hex, s.color); if (d < bestD) { bestD = d; best = s; } }
  return best.slot;
}

function SlotStep({
  printerId, model, isBambu, printing, progress, onBack, onClose, onConfirm,
}: {
  printerId: string; model: PrintableModel; isBambu: boolean; printing: boolean; progress: PrintProg | null;
  onBack: () => void; onClose: () => void;
  onConfirm: (opts: { amsMapping?: number[]; useAms?: boolean }) => void;
}) {
  const slotsQ = useQuery<{ type: string; slots: PrinterSlot[]; error?: string }>({
    queryKey: ["printer-slots", printerId],
    queryFn: () => fetchJson(`/api/printers/${printerId}/slots`),
  });
  const colorsQ = useQuery<ColorInfo>({
    queryKey: ["model-colors", model.fileId],
    queryFn: () => fetchJson(`/api/models/${model.fileId}/colors`),
  });
  const isLoading = slotsQ.isLoading || colorsQ.isLoading;

  const slots = useMemo(() => slotsQ.data?.slots ?? [], [slotsQ.data]);
  // Slot okunamazsa numarayla yine de eşlemek için 4 jenerik slot
  const pickSlots: PrinterSlot[] = slots.length
    ? slots
    : [0, 1, 2, 3].map((n) => ({ slot: n, color: "#9ca3af", type: "", empty: false }));

  const fileColors = useMemo(() => colorsQ.data?.colors ?? [], [colorsQ.data]);
  const usingFile = fileColors.length > 0;
  const fileKind = colorsQ.data?.fileKind;
  // Ham .gcode'da (Bambu) AMS eşlemesi UYGULANMAZ (sıra dilimde sabit). .3mf'te uygulanır.
  const mappingApplies = isBambu && fileKind === "3mf";
  const rawGcodeBambu = isBambu && fileKind === "gcode";

  const [manualCount, setManualCount] = useState(1);
  const [useAms, setUseAms] = useState(true);
  const [assign, setAssign] = useState<number[]>([]); // printColors sırasına paralel: seçilen slot id

  const printColors: FileColor[] = useMemo(
    () => (usingFile ? fileColors : Array.from({ length: manualCount }, (_, i) => ({ index: i, hex: "#9ca3af", type: "", grams: null }))),
    [usingFile, fileColors, manualCount]
  );

  // Otomatik eşleme: dosya rengi → en yakın yüklü slot (yoksa sıra ile)
  useEffect(() => {
    if (isLoading) return;
    setAssign((prev) => {
      if (prev.length === printColors.length && prev.every((v) => v != null)) return prev;
      return printColors.map((c, i) => {
        const near = usingFile && slots.length ? nearestSlotId(c.hex, slots) : null;
        return near != null ? near : (pickSlots[i % pickSlots.length]?.slot ?? i);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, printColors.length, usingFile, slots.length]);

  const setOne = (i: number, slot: number) => setAssign((prev) => { const n = [...prev]; n[i] = slot; return n; });
  const setCount = (n: number) => setManualCount(Math.max(1, Math.min(4, n)));

  const start = () => {
    // ams_mapping: dilimleyici filament index'ine göre yerleştir, boşlukları -1 ile doldur
    const maxIdx = printColors.reduce((m, c) => Math.max(m, c.index), 0);
    const map = Array.from({ length: maxIdx + 1 }, () => -1);
    printColors.forEach((c, i) => { map[c.index] = assign[i] ?? 0; });
    if (isBambu) onConfirm(useAms ? { useAms: true, amsMapping: map } : { useAms: false });
    else onConfirm({ amsMapping: map });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !printing && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Layers className="h-4 w-4 text-primary" /> Renk Eşleme — {model.productName}</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Renkler baskı dosyasından okundu. Her birini yazıcıdaki bir slota ata.
            {mappingApplies ? " Bambu bunu AMS eşlemesi olarak uygular." : isBambu ? "" : " Snapmaker'da sıra dilimlemeden gelir; bu eşleme doğrulama içindir."}
          </p>
        </DialogHeader>

        {isLoading ? (
          <div className="py-10 text-center text-muted-foreground"><Loader2 className="h-4 w-4 mx-auto animate-spin" /></div>
        ) : (
          <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-3">
            {slots.length > 0 ? (
              <div>
                <p className="text-[11px] text-muted-foreground mb-1.5">Yazıcıdaki slotlar</p>
                <div className="flex flex-wrap gap-1.5">
                  {slots.map((s) => (
                    <span key={s.slot} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]">
                      <span className="font-bold tabular-nums">{s.slot + 1}</span>
                      <span className="h-3.5 w-3.5 rounded-full border border-black/10" style={{ background: s.color }} />
                      {s.empty ? "boş" : s.type || "—"}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                {slotsQ.data?.error ? `Slot bilgisi okunamadı: ${slotsQ.data.error}. ` : "Yazıcıdan yüklü renk okunamadı. "}Numarayla eşleyebilirsin.
              </p>
            )}

            {!usingFile && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 space-y-2">
                <p className="text-[11px] text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0" />
                  {colorsQ.data?.missing ? "Dosya bu cihazda yok." : "Dosyadan renk okunamadı — renk sayısını elle seç."}
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-xs">Renk sayısı</span>
                  <div className="flex items-center gap-1 ml-auto">
                    <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => setCount(manualCount - 1)} disabled={manualCount <= 1}><Minus className="h-3.5 w-3.5" /></Button>
                    <span className="w-6 text-center font-bold tabular-nums">{manualCount}</span>
                    <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => setCount(manualCount + 1)} disabled={manualCount >= 4}><Plus className="h-3.5 w-3.5" /></Button>
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              {usingFile && (
                <p className="text-[11px] text-muted-foreground truncate">
                  Baskıda <b>{printColors.length}</b> renk · <span className="font-mono">{colorsQ.data?.originalName}</span>
                </p>
              )}
              {printColors.map((c, i) => {
                const chosen = assign[i];
                return (
                  <div key={i} className="flex items-center gap-2.5 rounded-lg border p-2">
                    <div className="flex items-center gap-2 w-[124px] shrink-0">
                      <span className="h-7 w-7 rounded-md border shadow-inner shrink-0" style={{ background: c.hex }} />
                      <div className="min-w-0">
                        <p className="text-xs font-medium truncate">Renk {i + 1}</p>
                        <p className="text-[10px] text-muted-foreground truncate font-mono">
                          {(c.type ? `${c.type} ` : "") + (usingFile ? c.hex : "")}{c.grams != null ? ` · ${c.grams}g` : ""}
                        </p>
                      </div>
                    </div>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <div className="flex gap-1.5 flex-wrap flex-1">
                      {pickSlots.map((s) => {
                        const sel = chosen === s.slot;
                        return (
                          <button
                            key={s.slot}
                            onClick={() => setOne(i, s.slot)}
                            title={`Slot ${s.slot + 1}${s.type ? ` · ${s.type}` : ""}`}
                            className={cn("flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors", sel ? "border-primary bg-primary/10 ring-1 ring-primary/30" : "border-border hover:bg-muted")}
                          >
                            <span className="font-bold tabular-nums">{s.slot + 1}</span>
                            <span className="h-3 w-3 rounded-full border border-black/10" style={{ background: s.color }} />
                            {sel && <Check className="h-3 w-3 text-primary" />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {rawGcodeBambu && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0" />
                Ham .gcode: slot eşlemesi dilimlemede sabittir; AMS'i yukarıdaki sıraya göre yükle. Uygulamadan tam eşleme için .3mf yükle.
              </p>
            )}

            {isBambu && (
              <button onClick={() => setUseAms((v) => !v)} className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
                <span className={cn("h-4 w-4 rounded border flex items-center justify-center", useAms ? "bg-primary border-primary" : "border-border")}>
                  {useAms && <Check className="h-3 w-3 text-primary-foreground" />}
                </span>
                AMS kullan (kapalıysa harici makaradan basar)
              </button>
            )}
          </div>
        )}

        {progress && <div className="mt-1"><PrintProgress p={progress} /></div>}

        <DialogFooter>
          <Button variant="ghost" onClick={onBack} disabled={printing}>Geri</Button>
          <Button disabled={printing} onClick={start}>
            {printing ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Gönderiliyor…</> : <><Play className="h-4 w-4 mr-1.5" />Bas ({printColors.length} renk)</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
