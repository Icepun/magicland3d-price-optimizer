"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FileBox, Trash2, Play, Cloud, HardDrive, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  SlotStep, runPrintStream,
  type PrintableModel, type PrintProg, type PrintPrefs,
} from "@/components/printers/print-flow";

/** Yazıcılar sayfasının canlı yazıcı listesinden (PanelPrinter) gereken alanlar. */
export interface LivePrinter {
  id: string;
  name: string;
  brand: string;
  accent: string;
  online: boolean;
  status: string;
}

interface CustomPrintRow {
  id: string;
  printerConfigId: string;
  originalName: string;
  fileType: string;
  sizeBytes: number;
  gramaj: number | null;
  estPrintMin: number | null;
  isCloud: boolean;
  createdAt: string;
  printer: { id: string; name: string; brand: string; accent: string } | null;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
function fmtDur(min: number | null): string {
  if (!min || min <= 0) return "";
  const h = Math.floor(min / 60), m = min % 60;
  return h > 0 ? `${h}sa ${m}dk` : `${m}dk`;
}
function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("tr-TR", { day: "2-digit", month: "short" });
  } catch { return ""; }
}

/**
 * Özel Baskılar arşivi — Yazıcılar sayfasından açılır. Yüklenmiş ürüne-bağlı-olmayan baskı dosyalarını
 * (bulut/yerel) listeler; ait olduğu yazıcı ile TEKRAR bas (mevcut SlotStep akışı) veya SİL (R2/disk
 * temizliğiyle). Böylece buluta yüklenen özel baskılar görünür + yönetilebilir kalır (orphan birikmez).
 */
export function CustomPrintLibrary({ printers, onClose }: { printers: LivePrinter[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: items = [], isLoading } = useQuery<CustomPrintRow[]>({
    queryKey: ["custom-prints"],
    queryFn: () => fetch("/api/custom-print").then((r) => r.json()),
  });

  const [reprint, setReprint] = useState<{ row: CustomPrintRow; printer: LivePrinter } | null>(null);
  const [printing, setPrinting] = useState(false);
  const [progress, setProgress] = useState<PrintProg | null>(null);

  const liveById = useMemo(() => new Map(printers.map((p) => [p.id, p])), [printers]);

  const del = useMutation({
    mutationFn: (fileId: string) => fetch(`/api/models/${fileId}`, { method: "DELETE" }).then((r) => r.json()),
    // OPTIMISTIC: listeden çıkar → refetch yok. Sunucu R2 objesini/disk dosyasını da temizler.
    onSuccess: (_d, fileId) => {
      qc.setQueryData<CustomPrintRow[]>(["custom-prints"], (old) =>
        Array.isArray(old) ? old.filter((f) => f.id !== fileId) : old,
      );
      toast.success("Özel baskı silindi");
    },
    onError: () => toast.error("Silinemedi"),
  });

  const startReprint = (row: CustomPrintRow) => {
    const live = liveById.get(row.printerConfigId);
    if (!live) { toast.error("Bu dosyanın yazıcısı artık yok"); return; }
    if (!live.online) { toast.error(`${live.name} çevrimdışı`); return; }
    if (live.status === "printing" || live.status === "paused") { toast.error(`${live.name} şu an meşgul`); return; }
    setProgress(null);
    setReprint({ row, printer: live });
  };

  const runPrint = async (opts: { amsMapping?: number[]; useAms?: boolean; prefs?: PrintPrefs }) => {
    if (!reprint) return;
    setPrinting(true);
    setProgress({ stage: "upload", pct: 0 });
    try {
      await runPrintStream(reprint.row.id, opts, setProgress);
      toast.success("Baskı başlatıldı 🎉");
      setReprint(null);
      onClose();
      setTimeout(() => qc.invalidateQueries({ queryKey: ["printers"] }), 800);
    } catch (e) {
      toast.error((e as Error).message);
      setProgress(null);
    } finally {
      setPrinting(false);
    }
  };

  // Renk eşleme + baskı adımı (tekrar baskı) — mevcut paylaşılan SlotStep'i aynen kullan.
  if (reprint) {
    const r = reprint.row;
    const model: PrintableModel = {
      fileId: r.id, productId: "__custom__", productName: r.originalName,
      imageUrl: null, label: null, originalName: r.originalName, sizeBytes: r.sizeBytes, gramaj: r.gramaj,
    };
    return (
      <SlotStep
        printerId={reprint.printer.id}
        model={model}
        isBambu={reprint.printer.brand === "bambu"}
        isSnapmaker={reprint.printer.brand === "snapmaker"}
        printing={printing}
        progress={progress}
        onBack={() => { setReprint(null); setProgress(null); }}
        onClose={onClose}
        onConfirm={runPrint}
      />
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileBox className="h-4 w-4 text-primary" /> Özel Baskılar
            {items.length > 0 && <span className="text-xs font-normal text-muted-foreground">· {items.length} dosya</span>}
          </DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Ürüne bağlı olmayan yüklediğin baskı dosyaları — ait olduğu yazıcıyla tekrar bas veya temizle.
          </p>
        </DialogHeader>

        {isLoading ? (
          <div className="py-12 text-center"><Loader2 className="h-5 w-5 mx-auto animate-spin text-muted-foreground" /></div>
        ) : items.length === 0 ? (
          <div className="py-12 text-center space-y-1.5">
            <FileBox className="h-8 w-8 mx-auto text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">Henüz özel baskı yüklemedin.</p>
            <p className="text-[11px] text-muted-foreground/70">&quot;Özel Baskı&quot; ile gcode/3mf yükleyince burada listelenir.</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-1.5">
            {items.map((it) => {
              const live = liveById.get(it.printerConfigId);
              const busy = live?.status === "printing" || live?.status === "paused";
              const canPrint = !!live && live.online && !busy;
              return (
                <div key={it.id} className="flex items-center gap-3 rounded-xl border bg-muted/20 p-2.5 transition-colors hover:bg-muted/40">
                  <div className="flex items-center justify-center h-9 w-9 rounded-lg bg-background border shrink-0">
                    <FileBox className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate" title={it.originalName}>{it.originalName}</p>
                    <div className="flex items-center gap-1.5 flex-wrap text-[10px] text-muted-foreground mt-0.5">
                      <span className="inline-flex items-center gap-1">
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: it.printer?.accent || "#9ca3af" }} />
                        {it.printer?.name ?? "yazıcı silinmiş"}
                      </span>
                      <span>·</span>
                      <span className="tabular-nums">{fmtSize(it.sizeBytes)}</span>
                      {fmtDur(it.estPrintMin) && <><span>·</span><span className="tabular-nums">{fmtDur(it.estPrintMin)}</span></>}
                      {it.gramaj ? <><span>·</span><span className="tabular-nums">{Math.round(it.gramaj)}g</span></> : null}
                      <span>·</span>
                      <span>{fmtDate(it.createdAt)}</span>
                      <span className={cn("inline-flex items-center gap-0.5 rounded px-1 py-px font-medium", it.isCloud ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
                        {it.isCloud ? <Cloud className="h-2.5 w-2.5" /> : <HardDrive className="h-2.5 w-2.5" />}
                        {it.isCloud ? "Bulut" : "Yerel"}
                      </span>
                    </div>
                  </div>
                  <Button
                    size="sm" variant="outline" className="h-8 gap-1 text-xs shrink-0"
                    disabled={!canPrint}
                    title={!live ? "Yazıcı yok" : !live.online ? "Çevrimdışı" : busy ? "Meşgul" : "Tekrar bas"}
                    onClick={() => startReprint(it)}
                  >
                    <Play className="h-3.5 w-3.5" /> Bas
                  </Button>
                  <Button
                    size="icon" variant="ghost"
                    className="h-8 w-8 shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                    disabled={del.isPending}
                    title="Sil"
                    onClick={() => del.mutate(it.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
