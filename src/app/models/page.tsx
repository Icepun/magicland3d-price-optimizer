"use client";
/* eslint-disable @next/next/no-img-element */

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Boxes, Search, Package, Play, Loader2, Layers, FileBox } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  SlotStep, PrintProgress, runPrintStream,
  type PrintableModel, type PrintProg, type PrintPrefs,
} from "@/components/printers/print-flow";

interface LibPrinter { id: string; name: string; brand: string; type: string }
interface LibFile { id: string; printerConfigId: string; label: string | null; originalName: string; sizeBytes: number; gramaj: number | null; fileType: string }
interface LibProduct { productId: string; name: string; imageUrl: string | null; files: LibFile[] }

function fmtSize(b: number) {
  return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}

export default function ModelsPage() {
  const { data, isLoading } = useQuery<{ products: LibProduct[]; printers: LibPrinter[] }>({
    queryKey: ["models"],
    queryFn: () => fetch("/api/models").then((r) => r.json()),
    staleTime: 0,
  });
  const [q, setQ] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [parts, setParts] = useState<{ product: LibProduct; printer: LibPrinter } | null>(null);

  const printers = useMemo(() => data?.printers ?? [], [data]);
  const allProducts = useMemo(() => data?.products ?? [], [data]);
  const totalParts = useMemo(() => allProducts.reduce((s, p) => s + p.files.length, 0), [allProducts]);

  const products = useMemo(() => {
    let list = allProducts;
    const query = q.trim().toLocaleLowerCase("tr-TR");
    if (query) list = list.filter((p) => p.name.toLocaleLowerCase("tr-TR").includes(query));
    if (onlyMissing && printers.length) {
      list = list.filter((p) => printers.some((pr) => !p.files.some((f) => f.printerConfigId === pr.id)));
    }
    return list;
  }, [allProducts, q, onlyMissing, printers]);

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      {/* Başlık — gradient şerit */}
      <div className="relative overflow-hidden rounded-2xl border bg-card p-5">
        <div className="pointer-events-none absolute -top-10 -right-10 h-40 w-40 rounded-full opacity-40 blur-2xl" style={{ background: "radial-gradient(circle, oklch(0.66 0.20 278 / 40%), transparent 70%)" }} />
        <div className="relative flex items-center gap-3">
          <div className="flex items-center justify-center h-12 w-12 rounded-xl bg-primary/12 border border-primary/25 shrink-0">
            <Boxes className="h-6 w-6 text-primary" />
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold tracking-tight">Model Kütüphanesi</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Ürünlerin baskı dosyaları. Yeşil yazıcı rozetine tıkla → parçaları gör ve bas.
            </p>
          </div>
          <div className="hidden sm:flex items-center gap-4 text-right">
            <Stat value={allProducts.length} label="ürün" />
            <Stat value={totalParts} label="parça" />
            <Stat value={printers.length} label="yazıcı" />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Ürün ara…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>
        <Button variant={onlyMissing ? "default" : "outline"} size="sm" onClick={() => setOnlyMissing((v) => !v)}>
          Eksik dosyası olanlar
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[76px] w-full rounded-xl" />)}</div>
      ) : printers.length === 0 ? (
        <EmptyHint title="Önce yazıcı ekle" desc="Yazıcılar → Yönet'ten yazıcılarını ekledikten sonra ürünlere baskı dosyası yükleyebilirsin." />
      ) : products.length === 0 ? (
        <EmptyHint title="Henüz model yok" desc="Bir ürünün detay sayfasındaki 'Baskı Dosyaları' kartından parça parça dosya yükle; hepsi burada toplanır." />
      ) : (
        <div className="space-y-2">
          {products.map((p, i) => (
            <Card
              key={p.productId}
              className="group transition-all hover:border-primary/30 hover:shadow-[0_4px_20px_oklch(0.66_0.2_278_/_8%)] animate-in fade-in slide-in-from-bottom-1"
              style={{ animationDelay: `${Math.min(i, 12) * 35}ms`, animationFillMode: "both" }}
            >
              <CardContent className="p-3 flex items-center gap-3">
                <div className="h-12 w-12 shrink-0 rounded-lg border bg-muted flex items-center justify-center overflow-hidden">
                  {p.imageUrl ? <img src={p.imageUrl} alt="" className="max-w-full max-h-full object-contain" /> : <Package className="h-5 w-5 text-muted-foreground/40" />}
                </div>
                <div className="min-w-0 flex-1">
                  <Link href={`/products/${p.productId}`} className="font-medium text-sm hover:underline truncate block" title={p.name}>{p.name}</Link>
                  <p className="text-[11px] text-muted-foreground tabular-nums">{p.files.length} parça</p>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap justify-end max-w-[58%]">
                  {printers.map((pr) => {
                    const cnt = p.files.filter((f) => f.printerConfigId === pr.id).length;
                    const has = cnt > 0;
                    return (
                      <button
                        key={pr.id}
                        disabled={!has}
                        onClick={() => { if (has) setParts({ product: p, printer: pr }); }}
                        className={cn(
                          "inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border transition-colors",
                          has
                            ? "border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20 cursor-pointer"
                            : "border-dashed border-border text-muted-foreground/45"
                        )}
                        title={has ? `${pr.name}: parçaları gör & bas` : `${pr.name}: dosya yok`}
                      >
                        {has && <Play className="h-3 w-3" />}
                        {pr.name}
                        {has && <span className="ml-0.5 tabular-nums opacity-80">·{cnt}</span>}
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {parts && (
        <PartsModal
          product={parts.product}
          printer={parts.printer}
          onClose={() => setParts(null)}
        />
      )}
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <p className="text-xl font-bold tabular-nums leading-none">{value}</p>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground mt-1">{label}</p>
    </div>
  );
}

function EmptyHint({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-xl border border-dashed py-16 text-center">
      <Boxes className="h-10 w-10 mx-auto text-muted-foreground/30" />
      <p className="mt-3 font-medium">{title}</p>
      <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">{desc}</p>
    </div>
  );
}

function PartsModal({ product, printer, onClose }: { product: LibProduct; printer: LibPrinter; onClose: () => void }) {
  const qc = useQueryClient();
  const parts = product.files.filter((f) => f.printerConfigId === printer.id);
  const multiColor = printer.brand === "bambu" || printer.brand === "snapmaker";

  const [printing, setPrinting] = useState(false);
  const [progress, setProgress] = useState<PrintProg | null>(null);
  const [picked, setPicked] = useState<LibFile | null>(null);

  const runPrint = async (fileId: string, opts: { amsMapping?: number[]; useAms?: boolean; prefs?: PrintPrefs } = {}) => {
    setPrinting(true);
    setProgress({ stage: "upload", pct: 0 });
    try {
      await runPrintStream(fileId, opts, setProgress);
      toast.success("Baskı başlatıldı 🎉");
      setTimeout(() => qc.invalidateQueries({ queryKey: ["printers"] }), 800);
      setTimeout(onClose, 750);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Başlatılamadı");
      setProgress(null);
    } finally {
      setPrinting(false);
    }
  };

  const startPart = (part: LibFile) => { if (multiColor) setPicked(part); else runPrint(part.id); };

  // Çok renkli (Bambu/Snapmaker) → renk/slot eşleme adımı (paylaşılan SlotStep).
  if (picked) {
    const model: PrintableModel = {
      fileId: picked.id, productId: product.productId, productName: product.name, imageUrl: product.imageUrl,
      label: picked.label, originalName: picked.originalName, sizeBytes: picked.sizeBytes, gramaj: picked.gramaj,
    };
    return (
      <SlotStep
        printerId={printer.id} model={model} isBambu={printer.brand === "bambu"} isSnapmaker={printer.brand === "snapmaker"} printing={printing} progress={progress}
        onBack={() => { setPicked(null); setProgress(null); }} onClose={onClose} onConfirm={(opts) => runPrint(picked.id, opts)}
      />
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !printing && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Layers className="h-4 w-4 text-primary" /> {product.name}</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">{printer.name} · {parts.length} parça. {multiColor ? "Parçaya bas → renk/slot eşle → baskı." : "Bir parçaya bas → yazıcıya yüklenip baskı başlar."}</p>
        </DialogHeader>
        <div className="space-y-1.5 max-h-[55vh] overflow-y-auto -mx-1 px-1">
          {parts.map((part, i) => (
            <div key={part.id} className="flex items-center gap-2.5 rounded-lg border p-2">
              <span className="flex items-center justify-center h-7 w-7 rounded bg-primary/10 text-primary text-xs font-bold tabular-nums shrink-0">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{part.label || part.originalName}</p>
                <p className="text-[10px] text-muted-foreground/70 truncate flex items-center gap-1.5">
                  <FileBox className="h-3 w-3" /> {fmtSize(part.sizeBytes)}{part.gramaj ? ` · ${part.gramaj} gr` : ""}
                </p>
              </div>
              <Button size="sm" className="h-8 gap-1.5 shrink-0" disabled={printing} onClick={() => startPart(part)}>
                {printing && progress ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} {multiColor ? "Renk seç" : "Bas"}
              </Button>
            </div>
          ))}
        </div>
        {progress && <div className="mt-1"><PrintProgress p={progress} /></div>}
        <p className="text-[11px] text-muted-foreground/70">
          Çok parçalı baskıda parçaları sırayla bas (biri biterken diğerini başlat). Otomatik kuyruk sonraki güncellemede.
        </p>
      </DialogContent>
    </Dialog>
  );
}
