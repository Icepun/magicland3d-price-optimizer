"use client";

import { useMemo, useState } from "react";
import { ViewerLoadingShell } from "@/components/printers/ViewerLoadingShell";
import dynamic from "next/dynamic";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FileBox, Trash2, Play, Cloud, HardDrive, Loader2, Search, Check,
  ArrowDownWideNarrow, Clock3, Box, Layers,
} from "lucide-react";
import { vizKeyForModel } from "@/lib/gcode-viz/viz-cache";

// three.js yalnız izleyici açılınca yüklensin.
const GcodeViewerDialog = dynamic(
  () => import("@/components/printers/GcodeViewer").then((m) => m.GcodeViewerDialog),
  { ssr: false, loading: () => <ViewerLoadingShell /> },
);
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  SlotStep,
  type PrintableModel, type PrintPrefs,
} from "@/components/printers/print-flow";
import { startBackgroundPrint } from "@/lib/print-jobs";
import { dedupeFiles, familyDisplayName, printerFamilyKey } from "@/core/printers/printer-family";

/** Yazıcılar sayfasının canlı yazıcı listesinden (PanelPrinter) gereken alanlar. */
export interface LivePrinter {
  id: string;
  name: string;
  brand: string;
  model?: string | null;
  type?: string | null;
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
  /** Görselin KENDİSİ değil, VAR MI bilgisi — görsel `/api/models/<id>/preview` ucundan gelir. */
  hasThumbnail: boolean;
  contentMd5: string | null;
  createdAt: string;
  printer: { id: string; name: string; brand: string; model?: string | null; type?: string | null; accent: string } | null;
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
  /**
   * AİLE: aynı marka + modeldeki yazıcılar (ör. iki Snapmaker U1) aynı dosyayı basar. Dosyanın
   * hangi yazıcıya yüklendiği artık önemsiz — aile içinde boştaki herhangi bir yazıcıda basılır.
   * Silinmiş yazıcının dosyası kendi başına bir "aile"dir (basılamaz, yalnız silinebilir).
   */
  const aileOf = (it: CustomPrintRow) =>
    it.printer
      ? printerFamilyKey({ id: it.printer.id, type: it.printer.type ?? null, brand: it.printer.brand, model: it.printer.model ?? null })
      : `tek:${it.printerConfigId}`;
  const canliAile = useMemo(() => {
    const m = new Map<string, LivePrinter[]>();
    for (const p of printers) {
      const k = printerFamilyKey({ id: p.id, type: p.type ?? null, brand: p.brand, model: p.model ?? null });
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return m;
  }, [printers]);

  // Aynı dosya aynı aileye iki kez yüklenmişse listede BİR kez görünür (en yenisi — API sırası).
  const items = useMemo(() => {
    const tum = data?.items ?? [];
    const aileBasina = new Map<string, CustomPrintRow[]>();
    for (const it of tum) {
      const k = aileOf(it);
      aileBasina.set(k, [...(aileBasina.get(k) ?? []), it]);
    }
    const kalan = new Set([...aileBasina.values()].flatMap((liste) => dedupeFiles(liste)).map((it) => it.id));
    return tum.filter((it) => kalan.has(it.id));
  }, [data]);
  const summary = data?.summary;

  // ── Filtre / arama / sıralama ──────────────────────────────────────────────
  const [q, setQ] = useState("");
  const [printerFilter, setPrinterFilter] = useState<string | null>(null); // aile anahtarı
  const [sortBySize, setSortBySize] = useState(false);

  // Filtre çipleri: AİLE başına (iki U1 tek çip: "Snapmaker U1").
  const printerChips = useMemo(() => {
    const counts = new Map<string, { id: string; name: string; accent: string; count: number }>();
    for (const it of items) {
      const key = aileOf(it);
      const cur = counts.get(key);
      if (cur) cur.count++;
      else {
        const uyeSayisi = canliAile.get(key)?.length ?? 1;
        const ad = !it.printer
          ? "Silinmiş yazıcı"
          : uyeSayisi > 1
            ? familyDisplayName({ ...it.printer, type: it.printer.type ?? null, model: it.printer.model ?? null })
            : it.printer.name;
        counts.set(key, { id: key, name: ad, accent: it.printer?.accent ?? "#9ca3af", count: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }, [items, canliAile]);

  const filtered = useMemo(() => {
    const query = q.trim().toLocaleLowerCase("tr-TR");
    let list = items.filter(
      (it) =>
        (!printerFilter || aileOf(it) === printerFilter) &&
        (!query || it.originalName.toLocaleLowerCase("tr-TR").includes(query))
    );
    if (sortBySize) list = [...list].sort((a, b) => b.sizeBytes - a.sizeBytes);
    return list; // varsayılan sıralama API'den: en yeni üstte
  }, [items, q, printerFilter, sortBySize]);

  /**
   * Bu dosya ŞU AN nerede basılabilir? Önce yüklendiği yazıcı, o meşgulse aynı ailedeki boştaki
   * yazıcı. Hiçbiri uygun değilse neden uygun olmadığı döner (düğmenin ipucu).
   */
  const hedefYazici = (it: CustomPrintRow): { hedef: LivePrinter | null; neden: string } => {
    const uyeler = canliAile.get(aileOf(it)) ?? [];
    const sirali = [...uyeler].sort((a, b) => Number(b.id === it.printerConfigId) - Number(a.id === it.printerConfigId));
    const bos = sirali.find((p) => p.online && p.status !== "printing" && p.status !== "paused");
    if (bos) return { hedef: bos, neden: "" };
    if (uyeler.length === 0) return { hedef: null, neden: "Yazıcı yok" };
    if (uyeler.every((p) => !p.online)) return { hedef: null, neden: "Çevrimdışı" };
    return { hedef: null, neden: "Meşgul" };
  };

  // ── Kopya dosyalar (aynı ailede aynı içerik) — tek tıkla temizlik ───────────
  const kopyalar = useQuery<{ count: number; bytes: number }>({
    queryKey: ["model-file-duplicates"],
    queryFn: async () => {
      const r = await fetch("/api/printers/model-files/duplicates");
      if (!r.ok) throw new Error("Kopyalar okunamadı");
      return r.json();
    },
    staleTime: 60_000,
  });
  const [kopyaOnay, setKopyaOnay] = useState(false);
  const kopyaTemizle = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/printers/model-files/duplicates", { method: "POST" });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Temizlenemedi");
      }
      return r.json() as Promise<{ deleted: number; bytes: number }>;
    },
    onSuccess: (res) => {
      setKopyaOnay(false);
      toast.success(`${res.deleted} kopya temizlendi · ${fmtSize(res.bytes)} boşaldı`);
      qc.setQueryData(["model-file-duplicates"], { count: 0, bytes: 0 });
      void qc.invalidateQueries({ queryKey: ["custom-prints"] });
      void qc.invalidateQueries({ queryKey: ["product-models"] });
      void qc.invalidateQueries({ queryKey: ["printable-models"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Temizlenemedi"),
  });

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

  // ARKA PLANDA başlat + arşivi kapat → ilerleme kartta, hata pop-up. Kullanıcı beklemez.
  const runPrint = (fileId: string, printerId: string, label: string, opts: { amsMapping?: number[]; useAms?: boolean; prefs?: PrintPrefs }) => {
    startBackgroundPrint(qc, { printerId, fileId, label, printOpts: opts });
    setReprint(null);
    onClose();
  };

  const startReprint = (row: CustomPrintRow) => {
    // Yüklendiği yazıcı meşgulse aynı ailedeki BOŞTAKİ yazıcı seçilir (ör. diğer U1).
    const { hedef: live, neden } = hedefYazici(row);
    if (!live) {
      toast.error(neden === "Yazıcı yok" ? "Bu dosyanın yazıcısı artık yok" : neden === "Çevrimdışı" ? "Yazıcı çevrimdışı" : "Yazıcı şu an meşgul");
      return;
    }
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
      imageUrl: r.hasThumbnail ? `/api/models/${r.id}/preview` : null,
      label: null, originalName: r.originalName, sizeBytes: r.sizeBytes, gramaj: r.gramaj,
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

        {/* Kopya dosyalar — aynı yazıcı ailesine birden çok kez yüklenmiş aynı dosya */}
        {(kopyalar.data?.count ?? 0) > 0 && (
          <div className="flex items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 animate-in fade-in slide-in-from-top-1 duration-300">
            <Layers className="h-4 w-4 text-amber-500 shrink-0" />
            <p className="flex-1 text-xs">
              Aynı dosyanın <span className="font-semibold tabular-nums">{kopyalar.data!.count}</span> fazladan kopyası var
              <span className="text-muted-foreground"> · {fmtSize(kopyalar.data!.bytes)}</span>
            </p>
            <Button
              size="sm" variant="outline" className="h-7 text-xs shrink-0 transition-transform active:scale-95"
              onClick={() => setKopyaOnay(true)}
            >
              Kopyaları temizle
            </Button>
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
            <p className="text-[11px] text-muted-foreground/70">&quot;Özel Baskı&quot; ile baskı dosyası yükleyince burada listelenir.</p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">Filtreye uyan dosya yok.</p>
        ) : (
          <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-1.5">
            {filtered.map((it) => {
              const { hedef, neden } = hedefYazici(it);
              const canPrint = !!hedef;
              // Dosya başka bir kardeş yazıcıda basılacaksa düğme bunu söyler ("Bas · U1 Üst").
              const baskaYazicida = !!hedef && hedef.id !== it.printerConfigId;
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
                    {it.hasThumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/models/${it.id}/preview`}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
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
                    size="sm" variant="outline" className="h-8 gap-1 text-xs shrink-0 max-w-[9.5rem] transition-transform active:scale-95"
                    disabled={!canPrint || printing}
                    title={canPrint ? `${hedef!.name} üzerinde bas` : neden}
                    onClick={() => startReprint(it)}
                  >
                    <Play className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{baskaYazicida ? `Bas · ${hedef!.name}` : "Bas"}</span>
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

      {/* Kopya temizliği onayı — her dosyanın bir kopyası kalır. */}
      <Dialog open={kopyaOnay} onOpenChange={(o) => !o && !kopyaTemizle.isPending && setKopyaOnay(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Layers className="h-4 w-4 text-amber-500" /> Kopyaları temizle
            </DialogTitle>
            <p className="text-xs text-muted-foreground mt-1">
              <span className="font-medium text-foreground tabular-nums">{kopyalar.data?.count ?? 0} fazladan kopya</span> silinecek
              ({fmtSize(kopyalar.data?.bytes ?? 0)}). Her dosyanın bir kopyası kalır ve aynı modeldeki tüm yazıcılarda basılabilir.
            </p>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={kopyaTemizle.isPending} onClick={() => setKopyaOnay(false)}>Vazgeç</Button>
            <Button size="sm" disabled={kopyaTemizle.isPending} onClick={() => kopyaTemizle.mutate()} className="gap-1.5">
              {kopyaTemizle.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              {kopyaTemizle.isPending ? "Temizleniyor…" : "Temizle"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
