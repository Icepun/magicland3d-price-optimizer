"use client";
/* eslint-disable @next/next/no-img-element */

import { fetchJson } from "@/lib/fetch-json";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Boxes, Search, Package, Play, Loader2, Layers, FileBox, Pencil, Trash2, Check, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { thumbUrl } from "@/lib/image";
import { toast } from "sonner";
import {
  SlotStep, PrintProgress, runPrintStream,
  type PrintableModel, type PrintProg, type PrintPrefs,
} from "@/components/printers/print-flow";
import { vizKeyForModel } from "@/lib/gcode-viz/viz-cache";
import {
  gramajByPrinter, gramajCompareText, missingFiles, missingGramajFiles,
  searchProduct, sortProducts, type SortMode,
} from "./models-view";

// three.js ilk pakete girmesin — izleyici yalnız açıldığında iner.
const GcodeViewerDialog = dynamic(
  () => import("@/components/printers/GcodeViewer").then((m) => m.GcodeViewerDialog),
  { ssr: false }
);

interface LibPrinter { id: string; name: string; brand: string; type: string }
interface LibFile { id: string; printerConfigId: string; label: string | null; originalName: string; sizeBytes: number; gramaj: number | null; estPrintMin: number | null; fileType: string; hasThumbnail: boolean; contentMd5: string | null; sharedWith: number }
interface LibProduct { productId: string; name: string; imageUrl: string | null; files: LibFile[]; totalBytes: number }
interface LibStorage {
  /** Buluttaki GERÇEK kullanım (aynı dosya varyantlarda paylaşılıyorsa bir kez sayılır). */
  totalBytes: number;
  rowBytes: number;
  sharedBytes: number;
  fileCount: number;
  byPrinter: Array<{ printerConfigId: string; bytes: number; files: number }>;
  largest: Array<{ id: string; productId: string; productName: string; printerConfigId: string; name: string; sizeBytes: number }>;
}

/** Dakikayı "2sa 18dk" biçiminde yaz — dosya adlarındaki yazımla aynı okunsun. */
function fmtSure(dk: number | null | undefined): string {
  if (dk == null || !Number.isFinite(dk) || dk <= 0) return "—";
  const sa = Math.floor(dk / 60);
  const kalan = Math.round(dk % 60);
  return sa > 0 ? `${sa}sa ${kalan}dk` : `${kalan}dk`;
}

function fmtSize(b: number) {
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)} GB`;
  return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}

export default function ModelsPage() {
  // Elde doğru veri varken ekranı gri kutulara çevirmiyoruz: önbellek gösterilir, tazeleme
  // arka planda olur. (Eskiden `staleTime: 0` yüzünden her girişte tüm liste yeniden iniyordu.)
  const { data, isLoading } = useQuery<{ products: LibProduct[]; printers: LibPrinter[]; storage?: LibStorage }>({
    queryKey: ["models"],
    queryFn: () => fetchJson("/api/models"),
    staleTime: 60_000,
  });
  const [q, setQ] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  /** Eksik filtresi hangi yazıcı için? null = herhangi biri (eski, kaba davranış). */
  const [missingPrinter, setMissingPrinter] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("name");
  const [parts, setParts] = useState<{ product: LibProduct; printer: LibPrinter } | null>(null);

  const printers = useMemo(() => data?.printers ?? [], [data]);
  const allProducts = useMemo(() => data?.products ?? [], [data]);
  const storage = data?.storage;
  const totalParts = useMemo(() => allProducts.reduce((s, p) => s + p.files.length, 0), [allProducts]);

  const printerIds = useMemo(() => printers.map((p) => p.id), [printers]);

  /** Arama sonucu: hangi ürün kalacak + hangi PARÇA eşleşti (kullanıcı nedenini görsün). */
  const eslesmeler = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of allProducts) {
      const hit = searchProduct(p, q);
      if (hit.matches) map.set(p.productId, hit.nameMatched ? [] : hit.matchedFileIds);
    }
    return map;
  }, [allProducts, q]);

  const products = useMemo(() => {
    let list = allProducts.filter((p) => eslesmeler.has(p.productId));
    if (onlyMissing && printerIds.length) {
      list = list.filter((p) => missingFiles(p, printerIds, missingPrinter));
    }
    return sortProducts(list, sortMode);
  }, [allProducts, eslesmeler, onlyMissing, missingPrinter, printerIds, sortMode]);

  return (
    <div className="p-6 space-y-5 mx-auto w-full max-w-[1600px]">
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
              Ürünlerin baskı dosyaları. Yeşil yazıcı rozetine tıkla → parçaları gör ve bas.{" "}
              <Link href="/planner" className="font-medium text-primary hover:underline">
                Üretim Planı
              </Link>{" "}
              hangi ürünü hangi yazıcıya göndereceğini söyler.
            </p>
          </div>
          <div className="hidden sm:flex items-center gap-4 text-right">
            <Stat value={allProducts.length} label="ürün" />
            <Stat value={totalParts} label="parça" />
            <Stat value={printers.length} label="yazıcı" />
            {/*
              Buluttaki GERÇEK kullanım. Satırları toplamak yanlış olurdu: aynı dosya varyant
              ürünlerde paylaşılıyor ve bulutta bir kez duruyor (ölçüldü: satır toplamı 8,39 GB,
              gerçek 5,59 GB).
            */}
            {storage && (
              <Stat
                text={fmtSize(storage.totalBytes)}
                label="yer"
                title={
                  storage.sharedBytes > 0
                    ? `${fmtSize(storage.sharedBytes)} varyantlar arasında paylaşılıyor — bir kez sayıldı`
                    : undefined
                }
              />
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          {/* Arama artık parça adlarında da çalışıyor — 470 parçanın adı arama dışındaydı. */}
          <Input placeholder="Ürün veya parça ara…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>

        <Button variant={onlyMissing ? "default" : "outline"} size="sm" onClick={() => setOnlyMissing((v) => !v)}>
          Eksik dosyası olanlar
        </Button>
        {/*
          Yazıcı seçilebilir: dört yazıcıdan HERHANGİ birinde eksik olan neredeyse her ürün
          olduğu için (kapsama 95/89/75/70 · 110) genel filtre işe yaramıyordu.
        */}
        {onlyMissing && printers.length > 1 && (
          <div className="flex items-center gap-1 flex-wrap">
            <FilterChip active={missingPrinter === null} onClick={() => setMissingPrinter(null)}>
              herhangi biri
            </FilterChip>
            {printers.map((pr) => {
              const kapsam = allProducts.filter((p) => p.files.some((f) => f.printerConfigId === pr.id)).length;
              return (
                <FilterChip
                  key={pr.id}
                  active={missingPrinter === pr.id}
                  onClick={() => setMissingPrinter((v) => (v === pr.id ? null : pr.id))}
                  title={`${kapsam}/${allProducts.length} üründe dosyası var`}
                >
                  {pr.name}
                </FilterChip>
              );
            })}
          </div>
        )}

        <div className="ml-auto flex items-center gap-1">
          <span className="text-[11px] text-muted-foreground">Sırala</span>
          {([
            ["name", "Ad"],
            ["parts", "Parça"],
            ["size", "Boyut"],
          ] as Array<[SortMode, string]>).map(([mode, label]) => (
            <FilterChip key={mode} active={sortMode === mode} onClick={() => setSortMode(mode)}>
              {label}
            </FilterChip>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[172px] w-full rounded-xl" />)}
        </div>
      ) : printers.length === 0 ? (
        <EmptyHint title="Önce yazıcı ekle" desc="Yazıcılar → Yönet'ten yazıcılarını ekledikten sonra ürünlere baskı dosyası yükleyebilirsin." />
      ) : products.length === 0 ? (
        <EmptyHint title="Henüz model yok" desc="Bir ürünün detay sayfasındaki 'Baskı Dosyaları' kartından parça parça dosya yükle; hepsi burada toplanır." />
      ) : (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
          {products.map((p, i) => {
            const eslesenParca = eslesmeler.get(p.productId)?.length ?? 0;
            return (
              <Card
                key={p.productId}
                className="group flex flex-col overflow-hidden transition-all hover:border-primary/30 hover:shadow-[0_6px_24px_oklch(0.66_0.2_278_/_10%)] animate-in fade-in slide-in-from-bottom-1"
                style={{ animationDelay: `${Math.min(i, 12) * 30}ms`, animationFillMode: "both" }}
              >
                <CardContent className="flex flex-1 flex-col gap-3 p-3">
                  <div className="flex items-start gap-3">
                    <div className="h-16 w-16 shrink-0 rounded-lg border bg-muted/60 flex items-center justify-center overflow-hidden">
                      {p.imageUrl
                        ? <img src={thumbUrl(p.imageUrl) ?? undefined} alt="" className="max-w-full max-h-full object-contain" />
                        : <Package className="h-6 w-6 text-muted-foreground/35" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/products/${p.productId}`}
                        className="block text-[15px] font-semibold leading-snug hover:underline line-clamp-2"
                        title={p.name}
                      >
                        {p.name}
                      </Link>
                      {/* Sayılar mono + tabular: bu sayfa bir makine göstergesi gibi okunmalı. */}
                      <p className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
                        {p.files.length} parça
                        {p.totalBytes > 0 && <span className="text-muted-foreground/60"> · {fmtSize(p.totalBytes)}</span>}
                      </p>
                      {eslesenParca > 0 && (
                        <p className="mt-0.5 font-mono text-[11px] text-primary/80">{eslesenParca} parça eşleşti</p>
                      )}
                    </div>
                  </div>

                  {/*
                    MAKİNE ŞERİDİ — bu sayfanın imzası.
                    Dört bölme, HER KARTTA AYNI SIRADA. Dolu = o yazıcının dosyası var (adet
                    yazılı), kesikli = eksik. Sıra sabit olduğu için kartları yukarıdan aşağı
                    tarayıp kapsama boşluklarını tek bakışta görürsün — eski satır düzeninde
                    rozetler sağa sıkıştığı ve sırası kaydığı için bu imkânsızdı.
                  */}
                  <div className="mt-auto grid grid-cols-4 gap-1.5">
                    {printers.map((pr) => {
                      const cnt = p.files.filter((f) => f.printerConfigId === pr.id).length;
                      const has = cnt > 0;
                      return (
                        <button
                          key={pr.id}
                          disabled={!has}
                          onClick={() => { if (has) setParts({ product: p, printer: pr }); }}
                          title={has ? `${pr.name} · ${cnt} parça — parçaları gör ve bas` : `${pr.name}: dosya yok`}
                          className={cn(
                            "flex flex-col items-center gap-0.5 rounded-md border px-1 py-1.5 transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            has
                              ? "border-primary/25 bg-primary/10 text-primary hover:bg-primary/20 cursor-pointer"
                              : "border-dashed border-border/70 text-muted-foreground/40"
                          )}
                        >
                          <span className="w-full truncate text-center text-[9px] font-semibold uppercase tracking-wide">
                            {shortPrinter(pr.name)}
                          </span>
                          <span className="font-mono text-[11px] leading-none tabular-nums">
                            {has ? cnt : "—"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {parts && (
        <PartsModal
          product={parts.product}
          printer={parts.printer}
          printers={printers}
          onClose={() => setParts(null)}
        />
      )}
    </div>
  );
}

/**
 * Makine şeridi için kısa ad. Şerit dört eşit bölmeye ayrıldığı için tam ad sığmaz;
 * kullanıcının makineyi tanıdığı ayırt edici parçayı bırakırız ("Neptune 4 Pro" → "N4 PRO").
 * Tam ad her bölmenin ipucunda duruyor.
 */
function shortPrinter(name: string): string {
  const n = name.trim();
  // "Neptune 4 Pro" → "N4 PRO" · "Neptune 4 Plus" → "N4 PLUS"
  const neptune = /neptune\s*(\d+)\s*(pro|plus|max)?/i.exec(n);
  if (neptune) {
    return `N${neptune[1]}${neptune[2] ? ` ${neptune[2]}` : ""}`.toLocaleUpperCase("tr-TR");
  }
  // "Bambu Lab A1 Combo" → "A1" · "Snapmaker U1" → "U1"
  const model = /(?:^|\s)([a-z]\d[a-z0-9]*)(?:\s|$)/i.exec(n);
  if (model) return model[1].toLocaleUpperCase("tr-TR");
  return n.slice(0, 7).toLocaleUpperCase("tr-TR");
}

function FilterChip({
  active, onClick, title, children,
}: { active: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-primary/40 bg-primary/12 text-primary"
          : "border-border text-muted-foreground hover:bg-muted"
      )}
    >
      {children}
    </button>
  );
}

function Stat({ value, text, label, title }: { value?: number; text?: string; label: string; title?: string }) {
  return (
    <div title={title}>
      <p className="text-xl font-bold tabular-nums leading-none">{text ?? value}</p>
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

function PartsModal({
  product, printer, printers, onClose,
}: { product: LibProduct; printer: LibPrinter; printers: LibPrinter[]; onClose: () => void }) {
  const qc = useQueryClient();
  const parts = product.files.filter((f) => f.printerConfigId === printer.id);
  const multiColor = printer.brand === "bambu" || printer.brand === "snapmaker";

  // ── Yazıcılar arası filament karşılaştırması ────────────────────────────────────────
  // Aynı ürünün dört yazıcı için ayrı dosyaları farklı miktarda filament harcıyor (destek,
  // dolgu, dilimleyici ayarı). Bu fark hiçbir yerde görünmüyordu.
  // ⚠️ Bu gramaj ÜRÜN MALİYETİNDEN tamamen ayrı bir alan — maliyeti etkilemez.
  const [gramajlar, setGramajlar] = useState<Record<string, number | null>>({});
  const [sureler, setSureler] = useState<Record<string, number | null>>({});
  const [okuma, setOkuma] = useState<{ done: number; total: number } | null>(null);
  const dosyalar = useMemo(
    () => product.files.map((f) => ({ ...f, gramaj: gramajlar[f.id] ?? f.gramaj })),
    [product.files, gramajlar]
  );
  const printerIds = useMemo(() => printers.map((p) => p.id), [printers]);
  const karsilastirma = useMemo(() => gramajByPrinter(dosyalar, printerIds), [dosyalar, printerIds]);
  const karsilastirmaMetni = useMemo(() => gramajCompareText(karsilastirma), [karsilastirma]);
  const eksikler = useMemo(() => missingGramajFiles(dosyalar), [dosyalar]);

  const gramajlariOku = async () => {
    setOkuma({ done: 0, total: eksikler.length });
    for (const [i, f] of eksikler.entries()) {
      try {
        const r = await fetchJson<{ gramaj: number | null; estPrintMin: number | null }>(
          `/api/models/${f.id}/gramaj`, { method: "POST" }
        );
        setGramajlar((prev) => ({ ...prev, [f.id]: r.gramaj }));
        setSureler((prev) => ({ ...prev, [f.id]: r.estPrintMin }));
      } catch {
        // Tek dosya okunamazsa diğerleri devam etsin; sonuç zaten "—" kalır.
        setGramajlar((prev) => ({ ...prev, [f.id]: null }));
      }
      setOkuma({ done: i + 1, total: eksikler.length });
    }
    setOkuma(null);
    qc.invalidateQueries({ queryKey: ["models"] });
  };

  const [printing, setPrinting] = useState(false);
  const [progress, setProgress] = useState<PrintProg | null>(null);
  const [picked, setPicked] = useState<LibFile | null>(null);
  /** 3B izleyicide açık parça — basmakla ilgisi yok, yalnız inceleme. */
  const [viewer, setViewer] = useState<LibFile | null>(null);
  /** Yeniden adlandırılan parça (id) ve yazılan metin. */
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  /** Silme onayı bekleyen parça — onay penceresi neyin gideceğini gösterir. */
  const [deleting, setDeleting] = useState<LibFile | null>(null);
  const [busy, setBusy] = useState(false);

  const renameSave = async () => {
    if (!renaming) return;
    const label = renaming.value.trim();
    setBusy(true);
    try {
      await fetchJson(`/api/models/${renaming.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // Boş bırakılırsa etiket kaldırılır → dosyanın kendi adı görünür.
        body: JSON.stringify({ label: label || null }),
      });
      setRenaming(null);
      await qc.invalidateQueries({ queryKey: ["models"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Kaydedilemedi");
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      // Paylaşılan dosyada TÜM kayıtlar silinir (kullanıcı onay penceresinde bunu gördü);
      // bulut nesnesi zaten yalnız son referans kalkınca siliniyor.
      const allVariants = deleting.sharedWith > 1 ? "?allVariants=1" : "";
      await fetchJson(`/api/models/${deleting.id}${allVariants}`, { method: "DELETE" });
      toast.success("Dosya silindi");
      setDeleting(null);
      await qc.invalidateQueries({ queryKey: ["models"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Silinemedi");
    } finally {
      setBusy(false);
    }
  };

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

  // Çok renkli (Bambu/Snapmaker) → renk eşleme adımı (paylaşılan SlotStep).
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
          <p className="text-xs text-muted-foreground mt-1">{printer.name} · {parts.length} parça. {multiColor ? "Parçaya bas → renkleri seç → baskı başlar." : "Bir parçaya bas → yazıcıya yüklenip baskı başlar."}</p>
        </DialogHeader>

        {/* Hangi makine bu ürünü daha az filamentle basıyor? */}
        {karsilastirma.length > 1 && (
          <div className="rounded-lg border bg-muted/30 p-2.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-medium text-muted-foreground">Filament tüketimi</p>
              {eksikler.length > 0 && !okuma && (
                <Button size="sm" variant="ghost" className="h-6 text-[11px] px-2" onClick={gramajlariOku}>
                  {eksikler.length} parçayı ölç
                </Button>
              )}
              {okuma && (
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  Ölçülüyor {okuma.done}/{okuma.total}
                </span>
              )}
            </div>
            {okuma && (
              <div className="h-1 rounded-full bg-border overflow-hidden">
                <div
                  className="h-full bg-primary transition-[width] duration-300"
                  style={{ width: `${okuma.total ? (okuma.done / okuma.total) * 100 : 0}%` }}
                />
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              {karsilastirma.map((row) => {
                const pr = printers.find((p) => p.id === row.printerConfigId);
                const eksikVar = row.known < row.total;
                return (
                  <span
                    key={row.printerConfigId}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] tabular-nums",
                      row.lowest
                        ? "border-green-500/40 bg-green-500/10 text-green-400 font-medium"
                        : "border-border text-muted-foreground"
                    )}
                    title={eksikVar ? `${row.total} parçanın ${row.known} tanesi ölçüldü` : undefined}
                  >
                    {pr?.name ?? "Yazıcı"}
                    {/* BİLİNMEYEN ≠ SIFIR: okunmamış gramaj "0 gr" değil "—". */}
                    <b className="font-semibold">{row.grams == null ? "—" : `${row.grams} gr`}</b>
                    {eksikVar && row.grams != null && <span className="opacity-60">·eksik</span>}
                  </span>
                );
              })}
            </div>
            {karsilastirmaMetni && (
              <p className="text-[11px] text-muted-foreground/80">{karsilastirmaMetni}</p>
            )}
          </div>
        )}
        <div className="space-y-1.5 max-h-[55vh] overflow-y-auto -mx-1 px-1">
          {parts.map((part, i) => (
            <div key={part.id} className="flex items-center gap-2.5 rounded-lg border p-2">
              {/*
                ÖNİZLEME: dosya adı tek başına "hangi parça bu?" sorusunu cevaplamıyordu —
                altı parçalı bir üründe hangisini basacağını addan tahmin etmek gerekiyordu.
                Görsel varsa gösterilir; her hâlde tıklanabilir ve 3B izleyiciyi açar.
              */}
              <button
                type="button"
                onClick={() => setViewer(part)}
                title="3B önizleme — modeli döndür, katman katman incele"
                className="group/th relative flex items-center justify-center h-11 w-11 shrink-0 rounded-md border bg-muted/40 overflow-hidden transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {part.hasThumbnail ? (
                  <img
                    src={`/api/models/${part.id}/preview`}
                    alt=""
                    loading="lazy"
                    className="max-w-full max-h-full object-contain"
                  />
                ) : (
                  <FileBox className="h-4 w-4 text-muted-foreground/40" />
                )}
                <span className="absolute inset-0 flex items-center justify-center bg-background/70 text-[9px] font-bold text-primary opacity-0 transition-opacity group-hover/th:opacity-100">
                  3B
                </span>
              </button>
              <span className="flex items-center justify-center h-7 w-7 rounded bg-primary/10 text-primary text-xs font-bold tabular-nums shrink-0">{i + 1}</span>
              <div className="min-w-0 flex-1">
                {renaming?.id === part.id ? (
                  <div className="flex items-center gap-1">
                    <Input
                      autoFocus
                      value={renaming.value}
                      onChange={(e) => setRenaming({ id: part.id, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void renameSave();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      placeholder={part.originalName}
                      className="h-7 text-sm"
                    />
                    <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" disabled={busy} onClick={() => void renameSave()} title="Kaydet">
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => setRenaming(null)} title="Vazgeç">
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ) : (
                  <>
                    <p className="text-sm font-medium truncate">{part.label || part.originalName}</p>
                    <p className="text-[10px] text-muted-foreground/70 truncate flex items-center gap-1.5">
                      <FileBox className="h-3 w-3" /> {fmtSize(part.sizeBytes)}
                      {(gramajlar[part.id] ?? part.gramaj) ? ` · ${gramajlar[part.id] ?? part.gramaj} gr` : ""}
                      {(sureler[part.id] ?? part.estPrintMin) ? ` · ${fmtSure(sureler[part.id] ?? part.estPrintMin)}` : ""}
                      {part.sharedWith > 1 && (
                        <span className="text-amber-400/80" title={`Bu dosya ${part.sharedWith} üründe kullanılıyor`}>
                          · {part.sharedWith} üründe
                        </span>
                      )}
                    </p>
                  </>
                )}
              </div>
              {renaming?.id !== part.id && (
                <div className="flex items-center gap-0.5 shrink-0">
                  <Button
                    size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    title="Adını değiştir"
                    onClick={() => setRenaming({ id: part.id, value: part.label ?? "" })}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    title="Sil"
                    onClick={() => setDeleting(part)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
              <Button size="sm" className="h-8 gap-1.5 shrink-0" disabled={printing} onClick={() => startPart(part)}>
                {printing && progress ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} {multiColor ? "Renk seç" : "Bas"}
              </Button>
            </div>
          ))}
        </div>
        {progress && <div className="mt-1"><PrintProgress p={progress} /></div>}
        {/* Sıra otomatik ilerlemiyor: her parçayı kullanıcı başlatır. Söz verip yapmamak yerine
            ne olduğunu olduğu gibi yaz; planlama Üretim Planı'nda. */}
        <p className="text-[11px] text-muted-foreground/70">
          Parçalar tek tek basılır: biri bitince buradan diğerini başlat.{" "}
          <Link href="/planner" className="text-primary hover:underline">
            Üretim Planı
          </Link>{" "}
          sıranın ne olduğunu gösterir.
        </p>
      </DialogContent>
      {/*
        SİLME ONAYI — neyin gideceğini SÖYLER. Paylaşılan dosyada uyarı şart: kullanıcı bir
        üründen silerken diğer varyantlardan da kalktığını bilmezse sessiz veri kaybı olur.
      */}
      {deleting && (
        <Dialog open onOpenChange={(o) => !o && !busy && setDeleting(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-destructive">Bu dosya silinsin mi?</DialogTitle>
            </DialogHeader>
            <div className="space-y-2 text-sm">
              <p className="font-medium break-words">{deleting.label || deleting.originalName}</p>
              <p className="text-xs text-muted-foreground">
                {printer.name} · {fmtSize(deleting.sizeBytes)}
                {deleting.gramaj ? ` · ${deleting.gramaj} gr` : ""}
              </p>
              {deleting.sharedWith > 1 && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-300">
                  Bu dosya {deleting.sharedWith} üründe kullanılıyor. Silersen hepsinden kalkar.
                </p>
              )}
              <p className="text-xs text-muted-foreground">Bu işlem geri alınamaz.</p>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => setDeleting(null)} disabled={busy}>
                Vazgeç
              </Button>
              <Button variant="destructive" size="sm" onClick={() => void confirmDelete()} disabled={busy}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Sil
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {viewer && (
        // `liveLayer` verilmiyor: burada basılan bir iş yok, sadece inceleme. İzleyici o zaman
        // "canlı olmayan" kipte açılır (katman kilidi ve "Canlıya dön" düğmesi çıkmaz).
        <GcodeViewerDialog
          fileId={viewer.id}
          cacheKey={vizKeyForModel(viewer)}
          name={viewer.label || viewer.originalName}
          onClose={() => setViewer(null)}
        />
      )}
    </Dialog>
  );
}
