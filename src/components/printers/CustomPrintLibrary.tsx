"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FileBox, Trash2, Play, Cloud, HardDrive, Loader2, Search, Check,
  ArrowDownWideNarrow, Clock3, Box,
} from "lucide-react";
import { vizKeyForModel } from "@/lib/gcode-viz/viz-cache";

// three.js yalnız izleyici açılınca yüklensin.
const GcodeViewerDialog = dynamic(() => import("@/components/printers/GcodeViewer").then((m) => m.GcodeViewerDialog), { ssr: false });
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  SlotStep,
  type PrintableModel, type PrintPrefs,
} from "@/components/printers/print-flow";
import { startBackgroundPrint } from "@/lib/print-jobs";

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
  thumbnail: string | null;
  contentMd5: string | null;
  createdAt: string;
  printer: { id: string; name: string; brand: string; accent: string } | null;
}
interface CustomPrintResponse {
  items: CustomPrintRow[];
  summary: {
    count: number;
    customCloudBytes: number;
    customLocalBytes: number;
    cloudTotalBytes: number;
    cloudTotalCount: number;
  };
}

function fmtSize(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
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
 * Özel Baskılar arşivi v2 — Yazıcılar sayfasından açılır. Ürüne bağlı olmayan baskı dosyalarını
 * yönetir: yazıcı filtresi + arama + sıralama, önizleme görselleri, ÇOKLU seçim + toplu silme
 * (bulut/disk temizliğiyle), depolama özeti (özel baskılar + tüm modellerin bulut kullanımı).
 */
export function CustomPrintLibrary({ printers, onClose }: { printers: LivePrinter[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<CustomPrintResponse>({
    queryKey: ["custom-prints"],
    queryFn: async () => {
      const r = await fetch("/api/custom-print");
      if (!r.ok) throw new Error("Liste alınamadı");
      const j = await r.json();
      return j && Array.isArray(j.items)
        ? (j as CustomPrintResponse)
        : { items: [], summary: { count: 0, customCloudBytes: 0, customLocalBytes: 0, cloudTotalBytes: 0, cloudTotalCount: 0 } };
    },
  });
  const items = useMemo(() => data?.items ?? [], [data]);
  const summary = data?.summary;

  // ── Filtre / arama / sıralama ──────────────────────────────────────────────
  const [q, setQ] = useState("");
  const [printerFilter, setPrinterFilter] = useState<string | null>(null); // printerConfigId
  const [sortBySize, setSortBySize] = useState(false);

  // Filtre çipleri: arşivdeki dosyaların ait olduğu yazıcılar + adet.
  const printerChips = useMemo(() => {
    const counts = new Map<string, { id: string; name: string; accent: string; count: number }>();
    for (const it of items) {
      const key = it.printerConfigId;
      const cur = counts.get(key);
      if (cur) cur.count++;
      else counts.set(key, { id: key, name: it.printer?.name ?? "Silinmiş yazıcı", accent: it.printer?.accent ?? "#9ca3af", count: 1 });
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }, [items]);

  const filtered = useMemo(() => {
    const query = q.trim().toLocaleLowerCase("tr-TR");
    let list = items.filter(
      (it) =>
        (!printerFilter || it.printerConfigId === printerFilter) &&
        (!query || it.originalName.toLocaleLowerCase("tr-TR").includes(query))
    );
    if (sortBySize) list = [...list].sort((a, b) => b.sizeBytes - a.sizeBytes);
    return list; // varsayılan sıralama API'den: en yeni üstte
  }, [items, q, printerFilter, sortBySize]);

  // ── Çoklu seçim ───────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedInView = filtered.filter((it) => selected.has(it.id));
  const allInViewSelected = filtered.length > 0 && selectedInView.length === filtered.length;
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  const toggleAllInView = () =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (allInViewSelected) filtered.forEach((it) => n.delete(it.id));
      else filtered.forEach((it) => n.add(it.id));
      return n;
    });

  // ── Baskı akışı ───────────────────────────────────────────────────────────
  const [reprint, setReprint] = useState<{ row: CustomPrintRow; printer: LivePrinter } | null>(null);
  const printing = false; // baskı ARKA PLANDA (modal kilitlenmez) → ilerleme yazıcı kartında
  const liveById = useMemo(() => new Map(printers.map((p) => [p.id, p])), [printers]);

  // ARKA PLANDA başlat + arşivi kapat → ilerleme kartta, hata pop-up. Kullanıcı beklemez.
  const runPrint = (fileId: string, printerId: string, label: string, opts: { amsMapping?: number[]; useAms?: boolean; prefs?: PrintPrefs }) => {
    startBackgroundPrint(qc, { printerId, fileId, label, printOpts: opts });
    setReprint(null);
    onClose();
  };

  const startReprint = (row: CustomPrintRow) => {
    const live = liveById.get(row.printerConfigId);
    if (!live) { toast.error("Bu dosyanın yazıcısı artık yok"); return; }
    if (!live.online) { toast.error(`${live.name} çevrimdışı`); return; }
    if (live.status === "printing" || live.status === "paused") { toast.error(`${live.name} şu an meşgul`); return; }
    // Renk eşleme (SlotStep) SADECE çok renkli makinelerde. Elegoo tek ekstruder: SlotStep'te
    // slot seçimi gerçek gcode remap'i yapar → direkt bas.
    if (live.brand === "bambu" || live.brand === "snapmaker") setReprint({ row, printer: live });
    else runPrint(row.id, live.id, row.originalName, {});
  };

  // ── Silme (tekli + toplu — aynı onay diyaloğu) ────────────────────────────
  const [confirmDel, setConfirmDel] = useState<{ rows: CustomPrintRow[] } | null>(null);
  const [viewer3d, setViewer3d] = useState<CustomPrintRow | null>(null);
  const del = useMutation({
    mutationFn: async (rows: CustomPrintRow[]) => {
      const r = await fetch("/api/custom-print/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: rows.map((x) => x.id) }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Silinemedi");
      }
      return r.json() as Promise<{ deleted: number }>;
    },
    // OPTIMISTIC: satırları + özet boyutlarını cache'te düş → refetch yok.
    onSuccess: (res, rows) => {
      const ids = new Set(rows.map((x) => x.id));
      qc.setQueryData<CustomPrintResponse>(["custom-prints"], (old) => {
        if (!old) return old;
        const removed = old.items.filter((it) => ids.has(it.id));
        const cloudBytes = removed.reduce((s, it) => s + (it.isCloud ? it.sizeBytes : 0), 0);
        const localBytes = removed.reduce((s, it) => s + (!it.isCloud ? it.sizeBytes : 0), 0);
        return {
          items: old.items.filter((it) => !ids.has(it.id)),
          summary: {
            ...old.summary,
            count: old.summary.count - removed.length,
            customCloudBytes: Math.max(0, old.summary.customCloudBytes - cloudBytes),
            customLocalBytes: Math.max(0, old.summary.customLocalBytes - localBytes),
            cloudTotalBytes: Math.max(0, old.summary.cloudTotalBytes - cloudBytes),
            cloudTotalCount: Math.max(0, old.summary.cloudTotalCount - removed.filter((r2) => r2.isCloud).length),
          },
        };
      });
      setSelected((prev) => {
        const n = new Set(prev);
        ids.forEach((id) => n.delete(id));
        return n;
      });
      setConfirmDel(null);
      toast.success(res.deleted > 1 ? `${res.deleted} özel baskı silindi` : "Özel baskı silindi");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Silinemedi"),
  });

  // ── Renk eşleme adımı (Bambu/Snapmaker tekrar baskısı) ────────────────────
  if (reprint) {
    const r = reprint.row;
    const model: PrintableModel = {
      fileId: r.id, productId: "__custom__", productName: r.originalName,
      imageUrl: r.thumbnail, label: null, originalName: r.originalName, sizeBytes: r.sizeBytes, gramaj: r.gramaj,
    };
    return (
      <SlotStep
        printerId={reprint.printer.id}
        model={model}
        isBambu={reprint.printer.brand === "bambu"}
        isSnapmaker={reprint.printer.brand === "snapmaker"}
        printing={false}
        progress={null}
        onBack={() => setReprint(null)}
        onClose={onClose}
        onConfirm={(opts) => runPrint(reprint.row.id, reprint.printer.id, reprint.row.originalName, opts)}
      />
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !printing && onClose()}>
      <DialogContent className="max-w-2xl max-h-[88vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileBox className="h-4 w-4 text-primary" /> Özel Baskılar
            {summary && summary.count > 0 && (
              <span className="text-xs font-normal text-muted-foreground">· {summary.count} dosya</span>
            )}
          </DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Ürüne bağlı olmayan baskı dosyaların — filtrele, tekrar bas veya toplu temizle.
          </p>
        </DialogHeader>

        {/* Depolama özeti */}
        {summary && summary.count > 0 && (
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl border bg-primary/[0.05] border-primary/20 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1"><Cloud className="h-3 w-3 text-primary" /> Bulutta</p>
              <p className="text-sm font-bold tabular-nums mt-0.5">{fmtSize(summary.customCloudBytes)}</p>
            </div>
            <div className="rounded-xl border bg-muted/30 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1"><HardDrive className="h-3 w-3" /> Yerelde</p>
              <p className="text-sm font-bold tabular-nums mt-0.5">{fmtSize(summary.customLocalBytes)}</p>
            </div>
            <div className="rounded-xl border bg-muted/30 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1"><Cloud className="h-3 w-3" /> Toplam bulut · tüm modeller</p>
              <p className="text-sm font-bold tabular-nums mt-0.5">{fmtSize(summary.cloudTotalBytes)} <span className="text-[10px] font-normal text-muted-foreground">/ {summary.cloudTotalCount} dosya</span></p>
            </div>
          </div>
        )}

        {/* Arama + sıralama */}
        {items.length > 0 && (
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Dosya ara…" className="pl-8 h-8 text-xs" />
            </div>
            <Button
              size="sm" variant="outline" className="h-8 gap-1.5 text-xs shrink-0"
              onClick={() => setSortBySize((v) => !v)}
              title={sortBySize ? "Boyuta göre (büyük → küçük)" : "Tarihe göre (yeni → eski)"}
            >
              {sortBySize ? <ArrowDownWideNarrow className="h-3.5 w-3.5" /> : <Clock3 className="h-3.5 w-3.5" />}
              {sortBySize ? "Büyük" : "Yeni"}
            </Button>
          </div>
        )}

        {/* Yazıcı filtre çipleri */}
        {printerChips.length > 1 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => setPrinterFilter(null)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                !printerFilter ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted"
              )}
            >
              Tümü ({items.length})
            </button>
            {printerChips.map((c) => (
              <button
                key={c.id}
                onClick={() => setPrinterFilter((cur) => (cur === c.id ? null : c.id))}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  printerFilter === c.id ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted"
                )}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: c.accent }} />
                {c.name} ({c.count})
              </button>
            ))}
          </div>
        )}

        {/* Tümünü seç + toplu sil */}
        {filtered.length > 0 && (
          <div className="flex items-center gap-2">
            <button onClick={toggleAllInView} className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
              <span className={cn("h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors", allInViewSelected ? "bg-primary border-primary" : "border-border")}>
                {allInViewSelected && <Check className="h-3 w-3 text-primary-foreground" />}
              </span>
              Görünenleri seç ({filtered.length})
            </button>
            {selected.size > 0 && (
              <Button
                size="sm" variant="destructive" className="h-7 gap-1.5 text-xs ml-auto motion-safe:animate-in motion-safe:fade-in"
                disabled={del.isPending || printing}
                onClick={() => setConfirmDel({ rows: items.filter((it) => selected.has(it.id)) })}
              >
                <Trash2 className="h-3.5 w-3.5" /> Sil ({selected.size})
              </Button>
            )}
          </div>
        )}

        {/* Liste */}
        {isLoading ? (
          <div className="py-12 text-center"><Loader2 className="h-5 w-5 mx-auto animate-spin text-muted-foreground" /></div>
        ) : items.length === 0 ? (
          <div className="py-12 text-center space-y-1.5">
            <FileBox className="h-8 w-8 mx-auto text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">Henüz özel baskı yüklemedin.</p>
            <p className="text-[11px] text-muted-foreground/70">&quot;Özel Baskı&quot; ile gcode/3mf yükleyince burada listelenir.</p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">Filtreye uyan dosya yok.</p>
        ) : (
          <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-1.5">
            {filtered.map((it) => {
              const live = liveById.get(it.printerConfigId);
              const busy = live?.status === "printing" || live?.status === "paused";
              const canPrint = !!live && live.online && !busy;
              const isSel = selected.has(it.id);
              return (
                <div
                  key={it.id}
                  className={cn(
                    "flex items-center gap-2.5 rounded-xl border p-2.5 transition-colors",
                    isSel ? "border-primary/40 bg-primary/[0.06]" : "bg-muted/20 hover:bg-muted/40"
                  )}
                >
                  <button
                    onClick={() => toggleOne(it.id)}
                    className={cn("h-4 w-4 rounded border flex items-center justify-center shrink-0 transition-colors", isSel ? "bg-primary border-primary" : "border-border hover:border-primary/50")}
                    title={isSel ? "Seçimi kaldır" : "Seç"}
                  >
                    {isSel && <Check className="h-3 w-3 text-primary-foreground" />}
                  </button>
                  <div className="flex items-center justify-center h-11 w-11 rounded-lg bg-background border shrink-0 overflow-hidden">
                    {it.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={it.thumbnail} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <FileBox className="h-4 w-4 text-muted-foreground" />
                    )}
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
                    size="icon" variant="ghost" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-primary"
                    title="3D önizleme — katman katman izle"
                    onClick={() => setViewer3d(it)}
                  >
                    <Box className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm" variant="outline" className="h-8 gap-1 text-xs shrink-0"
                    disabled={!canPrint || printing}
                    title={!live ? "Yazıcı yok" : !live.online ? "Çevrimdışı" : busy ? "Meşgul" : "Tekrar bas"}
                    onClick={() => startReprint(it)}
                  >
                    <Play className="h-3.5 w-3.5" /> Bas
                  </Button>
                  <Button
                    size="icon" variant="ghost"
                    className="h-8 w-8 shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                    disabled={del.isPending || printing}
                    title="Sil"
                    onClick={() => setConfirmDel({ rows: [it] })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}

      </DialogContent>

      {viewer3d && (
        <GcodeViewerDialog
          fileId={viewer3d.id}
          cacheKey={vizKeyForModel(viewer3d)}
          name={viewer3d.originalName}
          onClose={() => setViewer3d(null)}
        />
      )}

      {/* Silme onayı — tekli/toplu ortak; kalıcı işlem (bulut/disk dosyaları da gider). */}
      <Dialog open={!!confirmDel} onOpenChange={(o) => !o && !del.isPending && setConfirmDel(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Trash2 className="h-4 w-4 text-destructive" /> {confirmDel && confirmDel.rows.length > 1 ? `${confirmDel.rows.length} özel baskıyı sil` : "Özel baskıyı sil"}
            </DialogTitle>
            <p className="text-xs text-muted-foreground mt-1 break-all">
              {confirmDel && confirmDel.rows.length > 1 ? (
                <>Seçilen <span className="font-medium text-foreground">{confirmDel.rows.length} dosya</span> (toplam {fmtSize(confirmDel.rows.reduce((s, r) => s + r.sizeBytes, 0))}) kalıcı olarak silinecek — buluttaki kopyalar dahil. Bu işlem geri alınamaz.</>
              ) : (
                <><span className="font-medium text-foreground">{confirmDel?.rows[0]?.originalName}</span> kalıcı olarak silinecek{confirmDel?.rows[0]?.isCloud ? " (buluttaki dosya dahil)" : ""}. Bu işlem geri alınamaz.</>
              )}
            </p>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={del.isPending} onClick={() => setConfirmDel(null)}>Vazgeç</Button>
            <Button variant="destructive" size="sm" disabled={del.isPending} onClick={() => confirmDel && del.mutate(confirmDel.rows)}>
              {del.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Sil
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
