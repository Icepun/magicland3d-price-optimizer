"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Printer, Play, Loader2, FileBox, Package, CheckCircle2, ChevronRight } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface ModelFile {
  id: string;
  printerConfigId: string;
  label: string | null;
  originalName: string;
  sizeBytes: number;
  gramaj: number | null;
  fileType: string;
}
interface PrinterCfg {
  id: string;
  name: string;
  brand: string;
  type: string;
  enabled: boolean;
  accent: string | null;
}

type Stage = "status" | "upload" | "start" | "confirm" | "done";
const STAGE_LABEL: Record<Stage, string> = {
  status: "Yazıcı kontrol ediliyor…",
  upload: "Dosya yükleniyor…",
  start: "Baskı başlatılıyor…",
  confirm: "Onaylanıyor…",
  done: "Baskı başladı!",
};

function fmtSize(b: number) {
  return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}

/**
 * Ürünler listesinden hızlı baskı: bu ürünün modeli OLAN yazıcıları gösterir,
 * parçaya basınca yazıcıya yükleyip baskıyı başlatır. NDJSON akışını satır satır
 * okuyup belirli (determinate) ilerleme çubuğu gösterir — asla boş ekran.
 * (Bambu, AMS renk eşleştirmesi gerektirdiği için Modeller/Detay sayfasına yönlendirilir.)
 */
export function ProductPrintModal({
  productId,
  productName,
  onClose,
}: {
  productId: string;
  productName: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: files, isLoading: lf } = useQuery<ModelFile[]>({
    queryKey: ["product-models", productId],
    queryFn: () => fetch(`/api/products/${productId}/models`).then((r) => r.json()),
    staleTime: 30_000,
  });
  const { data: printers, isLoading: lp } = useQuery<PrinterCfg[]>({
    queryKey: ["printer-configs"],
    queryFn: () => fetch("/api/printers/config").then((r) => r.json()),
    staleTime: 60_000,
  });
  const isLoading = lf || lp;

  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const printing = busyFile !== null;

  // Bu ürün için dosyası OLAN yazıcılar (sadece basılabilir olanlar listelenir).
  const groups = useMemo(() => {
    const fileArr = Array.isArray(files) ? files : [];
    const cfgArr = Array.isArray(printers) ? printers : [];
    return cfgArr
      .map((pr) => ({ printer: pr, parts: fileArr.filter((f) => f.printerConfigId === pr.id) }))
      .filter((g) => g.parts.length > 0);
  }, [files, printers]);

  async function runPrint(fileId: string) {
    setBusyFile(fileId);
    setStage("status");
    setPct(null);
    try {
      const res = await fetch(`/api/models/${fileId}/print`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok || !res.body) {
        const b = await res.json().catch(() => ({}) as { error?: string });
        throw new Error((b as { error?: string }).error || "Baskı başlatılamadı");
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let errored = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          let o: { stage?: string; pct?: number; message?: string };
          try {
            o = JSON.parse(t);
          } catch {
            continue;
          }
          if (o.stage === "upload") {
            setStage("upload");
            setPct(typeof o.pct === "number" ? o.pct : null);
          } else if (o.stage === "start") {
            setStage("start");
            setPct(null);
          } else if (o.stage === "confirm") setStage("confirm");
          else if (o.stage === "done") setStage("done");
          else if (o.stage === "status") setStage("status");
          else if (o.stage === "error") {
            errored = true;
            toast.error(o.message || "Yazıcı baskıyı reddetti");
          }
        }
      }
      if (!errored) {
        setStage("done");
        toast.success("Baskı başlatıldı 🎉");
        setTimeout(() => qc.invalidateQueries({ queryKey: ["printers"] }), 800);
        setTimeout(onClose, 750);
      } else {
        setStage(null);
      }
    } catch (e) {
      setStage(null);
      toast.error(e instanceof Error ? e.message : "Baskı başlatılamadı");
    } finally {
      setBusyFile(null);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Printer className="h-4 w-4 text-primary" /> Baskı başlat
          </DialogTitle>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{productName}</p>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <div className="rounded-xl border border-dashed py-10 text-center">
            <Package className="h-9 w-9 mx-auto text-muted-foreground/30" />
            <p className="mt-3 font-medium text-sm">Baskı dosyası yok</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">
              Bu ürün için hiçbir yazıcıya baskı dosyası yüklenmemiş.
            </p>
            <Link
              href={`/products/${productId}`}
              onClick={onClose}
              className="inline-flex items-center gap-1 text-xs text-primary mt-3 hover:underline"
            >
              Ürün detayında yükle <ChevronRight className="h-3 w-3" />
            </Link>
          </div>
        ) : (
          <div className="space-y-3 max-h-[55vh] overflow-y-auto -mx-1 px-1">
            {groups.map(({ printer, parts }) => {
              const canPrint = printer.type === "moonraker";
              return (
                <div key={printer.id} className="rounded-xl border overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30">
                    <span
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{ background: printer.accent || "var(--primary)" }}
                    />
                    <span className="text-sm font-semibold truncate">{printer.name}</span>
                    <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{parts.length} parça</span>
                    {!canPrint && (
                      <span className="ml-auto text-[10px] text-amber-600 dark:text-amber-400 shrink-0">
                        Bambu — Detay’dan
                      </span>
                    )}
                  </div>
                  <div className="divide-y">
                    {parts.map((part, i) => {
                      const isBusy = busyFile === part.id;
                      return (
                        <div key={part.id} className="flex items-center gap-2.5 px-3 py-2">
                          <span className="flex items-center justify-center h-6 w-6 rounded bg-primary/10 text-primary text-[11px] font-bold tabular-nums shrink-0">
                            {i + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium truncate">{part.label || part.originalName}</p>
                            <p className="text-[10px] text-muted-foreground/70 truncate flex items-center gap-1">
                              <FileBox className="h-3 w-3" /> {fmtSize(part.sizeBytes)}
                              {part.gramaj ? ` · ${part.gramaj} gr` : ""}
                            </p>
                          </div>
                          {canPrint ? (
                            <Button
                              size="sm"
                              className="h-8 gap-1.5 shrink-0"
                              disabled={printing}
                              onClick={() => runPrint(part.id)}
                            >
                              {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Bas
                            </Button>
                          ) : (
                            <Link
                              href={`/products/${productId}`}
                              onClick={onClose}
                              className="shrink-0 inline-flex items-center h-8 px-2.5 rounded-md border text-xs font-medium hover:bg-muted/50 transition-colors"
                            >
                              Aç
                            </Link>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Canlı ilerleme — belirli (determinate) çubuk; asla donuk/boş ekran */}
        {stage && (
          <div className="rounded-lg border bg-card px-3 py-2.5 space-y-1.5 animate-in fade-in slide-in-from-bottom-1">
            <div className="flex items-center gap-2 text-xs font-medium">
              {stage === "done" ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              )}
              {STAGE_LABEL[stage]}
              {stage === "upload" && pct != null && (
                <span className="ml-auto tabular-nums text-muted-foreground">%{Math.round(pct)}</span>
              )}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              {stage === "done" ? (
                <div className="h-full w-full rounded-full bg-green-500 transition-all duration-300" />
              ) : stage === "upload" && pct != null ? (
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${Math.max(4, Math.min(100, pct))}%` }}
                />
              ) : (
                <div
                  className="h-full w-1/3 rounded-full bg-primary"
                  style={{ animation: "indeterminate-bar 1.6s ease-in-out infinite" }}
                />
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
