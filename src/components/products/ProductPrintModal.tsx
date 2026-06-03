"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Printer, Play, Loader2, FileBox, Package } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  SlotStep, PrintProgress, runPrintStream,
  type PrintableModel, type PrintProg, type PrintPrefs,
} from "@/components/printers/print-flow";

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

function fmtSize(b: number) {
  return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}

/**
 * Ürünler listesinden hızlı baskı: bu ürünün modeli OLAN yazıcıları gösterir.
 * Tek renkli (Elegoo) → parçaya bas, yüklenip baskı başlar. Çok renkli (Bambu/Snapmaker)
 * → renk/slot eşleme adımı (SlotStep) açılır, oradan basılır. Akış paylaşılan print-flow
 * modülünden gelir → Bambu artık Detay'a gitmeden buradan da basabilir.
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

  const [printing, setPrinting] = useState(false);
  const [progress, setProgress] = useState<PrintProg | null>(null);
  // Çok renkli baskıda seçilen parça + yazıcı → SlotStep'e geçilir.
  const [picked, setPicked] = useState<{ file: ModelFile; printer: PrinterCfg } | null>(null);

  // Bu ürün için dosyası OLAN yazıcılar (sadece basılabilir olanlar listelenir).
  const groups = useMemo(() => {
    const fileArr = Array.isArray(files) ? files : [];
    const cfgArr = Array.isArray(printers) ? printers : [];
    return cfgArr
      .map((pr) => ({ printer: pr, parts: fileArr.filter((f) => f.printerConfigId === pr.id) }))
      .filter((g) => g.parts.length > 0);
  }, [files, printers]);

  const isMultiColor = (pr: PrinterCfg) => pr.brand === "bambu" || pr.brand === "snapmaker";

  async function runPrint(fileId: string, opts: { amsMapping?: number[]; useAms?: boolean; prefs?: PrintPrefs } = {}) {
    setPrinting(true);
    setProgress({ stage: "upload", pct: 0 });
    try {
      await runPrintStream(fileId, opts, setProgress);
      toast.success("Baskı başlatıldı 🎉");
      setTimeout(() => qc.invalidateQueries({ queryKey: ["printers"] }), 800);
      setTimeout(onClose, 750);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Baskı başlatılamadı");
      setProgress(null);
    } finally {
      setPrinting(false);
    }
  }

  const startPart = (printer: PrinterCfg, part: ModelFile) => {
    if (isMultiColor(printer)) setPicked({ file: part, printer });
    else runPrint(part.id);
  };

  // ── Renk/slot eşleme adımı (Bambu/Snapmaker) ──
  if (picked) {
    const model: PrintableModel = {
      fileId: picked.file.id,
      productId,
      productName,
      imageUrl: null,
      label: picked.file.label,
      originalName: picked.file.originalName,
      sizeBytes: picked.file.sizeBytes,
      gramaj: picked.file.gramaj,
    };
    return (
      <SlotStep
        printerId={picked.printer.id}
        model={model}
        isBambu={picked.printer.brand === "bambu"}
        isSnapmaker={picked.printer.brand === "snapmaker"}
        printing={printing}
        progress={progress}
        onBack={() => { setPicked(null); setProgress(null); }}
        onClose={onClose}
        onConfirm={(opts) => runPrint(picked.file.id, opts)}
      />
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !printing && onClose()}>
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
              Bu ürün için hiçbir yazıcıya baskı dosyası yüklenmemiş. Ürün detayındaki Baskı Dosyaları kartından yükleyebilirsin.
            </p>
          </div>
        ) : (
          <div className="space-y-3 max-h-[55vh] overflow-y-auto -mx-1 px-1">
            {groups.map(({ printer, parts }) => {
              const multi = isMultiColor(printer);
              return (
                <div key={printer.id} className="rounded-xl border overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30">
                    <span
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{ background: printer.accent || "var(--primary)" }}
                    />
                    <span className="text-sm font-semibold truncate">{printer.name}</span>
                    <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{parts.length} parça</span>
                    {multi && (
                      <span className="ml-auto text-[10px] text-muted-foreground shrink-0">renk eşlemeli</span>
                    )}
                  </div>
                  <div className="divide-y">
                    {parts.map((part, i) => {
                      const isBusy = printing && progress != null;
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
                          <Button
                            size="sm"
                            className="h-8 gap-1.5 shrink-0"
                            disabled={printing}
                            onClick={() => startPart(printer, part)}
                          >
                            {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : multi ? <Printer className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                            {multi ? "Renk seç" : "Bas"}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {progress && <div className="mt-1"><PrintProgress p={progress} /></div>}
      </DialogContent>
    </Dialog>
  );
}
