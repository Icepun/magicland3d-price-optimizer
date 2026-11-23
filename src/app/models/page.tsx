"use client";
/* eslint-disable @next/next/no-img-element */

import { fetchJson } from "@/lib/fetch-json";
import { ViewerLoadingShell } from "@/components/printers/ViewerLoadingShell";
import dynamic from "next/dynamic";
import { memo, useCallback, useDeferredValue, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
  Boxes, Search, Package, Play, Loader2, Layers, Pencil, Trash2, Check, X, Plus,
  ChevronRight, Printer, CircleDashed, ArrowUpRight, AlertTriangle, RefreshCw, HardDrive,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { thumbUrl } from "@/lib/image";
import { toast } from "sonner";
import {
  SlotStep, PrintProgress, runPrintStream,
  type PrintableModel, type PrintProg,
  type BaskiSecenekleri,
} from "@/components/printers/print-flow";
import { vizKeyForModel } from "@/lib/gcode-viz/viz-cache";
import { useDisariBirakmayiYut } from "@/lib/dosya-birakma";
import { ParcaBilgiSatiri, ParcaGorseli } from "@/components/printers/parca-gorunum";
import { bilgiyiIsle, useEksikBilgiyiTamamla } from "@/lib/dosya-bilgisi";
import { gorunenAd } from "@/lib/model-dosya-gorunum";
import { aileDosyalari, aileIkizleri, gramajByPrinter, gramajCompareText, missingGramajFiles } from "./models-view";
import {
  hucreAciklamasi, kapsamAileleri, kapsamOzeti, modelSatirlari, satirAra, satirSirala, satirUyar, varyantAdi,
  type KapsamAilesi, type KapsamFiltresi, type KapsamHucresi, type KapsamSirasi, type ModelSatiri,
} from "./kapsam-view";
import { DosyaEkleDialog, type DosyaEkleHedefi } from "./DosyaEkleDialog";

// three.js ilk pakete girmesin — izleyici yalnız açıldığında iner.
const GcodeViewerDialog = dynamic(
  () => import("@/components/printers/GcodeViewer").then((m) => m.GcodeViewerDialog),
  // Parça inerken ekran BOŞ kalmasın: tıklamanın işe yaradığı anında görünsün.
  { ssr: false, loading: () => <ViewerLoadingShell /> }
);

interface LibPrinter { id: string; name: string; brand: string; type: string; model: string | null }
interface LibFile { id: string; printerConfigId: string; label: string | null; originalName: string; sizeBytes: number; gramaj: number | null; estPrintMin: number | null; fileType: string; hasThumbnail: boolean; contentMd5: string | null; sharedWith: number; renkler?: string[] }
interface LibProduct { productId: string; name: string; imageUrl: string | null; files: LibFile[]; totalBytes: number; variantGroupId?: string | null; variantGroupName?: string | null }
interface LibStorage {
  /** Buluttaki GERÇEK kullanım (aynı dosya varyantlarda paylaşılıyorsa bir kez sayılır). */
  totalBytes: number;
  rowBytes: number;
  sharedBytes: number;
  fileCount: number;
}
/** Kapalı ya da silinmiş yazıcıya ait (hiçbir sütunda görünmeyen) dosya. */
interface SahipsizDosya extends LibFile { productId: string; productName: string; yaziciAdi: string | null }

type Satir = ModelSatiri<LibProduct>;

function fmtSize(b: number) {
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)} GB`;
  return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}

// Magicland paleti: zümrüt = dosyası var, lavanta = eksik (turuncu yok).
const YESIL = "#34D399";
const SIRALAR: Array<[KapsamSirasi, string]> = [
  ["ad", "Ad"],
  ["eksik", "Eksikler önce"],
  ["parca", "Parça"],
  ["boyut", "Boyut"],
];

export default function ModelsPage() {
  const qc = useQueryClient();
  // Elde doğru veri varken ekranı gri kutulara çevirmiyoruz: önbellek gösterilir, tazeleme
  // arka planda olur. (Eskiden `staleTime: 0` yüzünden her girişte tüm liste yeniden iniyordu.)
  const { data, isLoading, isError, isFetching, refetch } = useQuery<{
    products: LibProduct[];
    printers: LibPrinter[];
    storage?: LibStorage;
    kapaliYazicilar?: Array<{ id: string; name: string }>;
  }>({
    queryKey: ["models"],
    queryFn: () => fetchJson("/api/models"),
    staleTime: 60_000,
    // Açılışta TAZELE (elde liste varsa o gösterilir, yenisi arkada gelir). Eskiden genel ayar yüzünden
    // hiç tazelenmiyordu: ürün sayfasında yüklenen dosya burada "Ekle" görünüyor, aynı dosya ikinci
    // kez yükleniyordu (denetim, 23 Kas 2026).
    refetchOnMount: true,
  });
  const [q, setQ] = useState("");
  // 280+ satır her tuşta yeniden süzülmesin: yazı akıcı kalır, liste bir an sonra yetişir.
  const sorgu = useDeferredValue(q);
  const [filtre, setFiltre] = useState<KapsamFiltresi>({ tur: "tumu" });
  const [sira, setSira] = useState<KapsamSirasi>("ad");
  const [acik, setAcik] = useState<ReadonlySet<string>>(() => new Set());
  // Parça penceresi ürünün KİMLİĞİNİ tutar, ürün her çizimde güncel listeden okunur. Eskiden açılış
  // anındaki kopya tutuluyordu: silinen parça pencerede kalıyor, yeni ad görünmüyordu.
  const [parts, setParts] = useState<{ productId: string; aile: KapsamAilesi } | null>(null);
  const [sahipsizAcik, setSahipsizAcik] = useState(false);
  const [ekle, setEkle] = useState<DosyaEkleHedefi | null>(null);
  useDisariBirakmayiYut();

  const printers = useMemo(() => data?.printers ?? [], [data]);
  const hamUrunler = useMemo(() => data?.products ?? [], [data]);
  const storage = data?.storage;
  /**
   * Görünen (açık) yazıcıların dosyaları tabloya, KAPALI/SİLİNMİŞ yazıcılarınkiler ayrı listeye.
   * Eskiden ikisi karışıktı: hiçbir hücrede görünmeyen dosyalar başlıktaki parça sayısına ve satır
   * boyutuna giriyor, bu sayfadan da silinemiyordu.
   */
  const { allProducts, sahipsizler } = useMemo(() => {
    const acik = new Set(printers.map((p) => p.id));
    const adlar = new Map((data?.kapaliYazicilar ?? []).map((y) => [y.id, y.name]));
    const yetim: SahipsizDosya[] = [];
    const urunler = hamUrunler.map((u) => {
      const gorunen = u.files.filter((f) => acik.has(f.printerConfigId));
      if (gorunen.length === u.files.length) return u;
      for (const f of u.files) {
        if (!acik.has(f.printerConfigId)) yetim.push({ ...f, productId: u.productId, productName: u.name, yaziciAdi: adlar.get(f.printerConfigId) ?? null });
      }
      return { ...u, files: gorunen, totalBytes: gorunen.reduce((t, f) => t + (f.sizeBytes ?? 0), 0) };
    });
    return { allProducts: urunler, sahipsizler: yetim };
  }, [hamUrunler, printers, data?.kapaliYazicilar]);
  const parcaUrunu = parts ? hamUrunler.find((u) => u.productId === parts.productId) ?? null : null;

  // İki Snapmaker U1 aynı dosyayı basar → TEK sütun.
  const aileler = useMemo(() => kapsamAileleri(printers), [printers]);
  const tumSatirlar = useMemo(() => modelSatirlari(allProducts, aileler), [allProducts, aileler]);
  const ozet = useMemo(() => kapsamOzeti(tumSatirlar, aileler), [tumSatirlar, aileler]);
  const toplamParca = useMemo(() => tumSatirlar.reduce((s, r) => s + r.parca, 0), [tumSatirlar]);

  const { satirlar, eslesenParcalar } = useMemo(() => {
    const eslesen = new Map<string, number>();
    const kalan = tumSatirlar.filter((s) => {
      const a = satirAra(s, sorgu);
      if (!a.eslesti || !satirUyar(s, aileler, filtre)) return false;
      if (a.eslesenParca > 0) eslesen.set(s.anahtar, a.eslesenParca);
      return true;
    });
    return { satirlar: satirSirala(kalan, sira), eslesenParcalar: eslesen };
  }, [tumSatirlar, sorgu, aileler, filtre, sira]);

  const acKapa = useCallback((anahtar: string) => {
    setAcik((eski) => {
      const yeni = new Set(eski);
      if (yeni.has(anahtar)) yeni.delete(anahtar);
      else yeni.add(anahtar);
      return yeni;
    });
  }, []);

  /**
   * Hücreye tıklama: dolu → parçaları gör ve bas · boş → dosya ekle.
   * `urunIdx` verilmezse satırın (tüm varyantların) hücresidir.
   */
  const hucreTikla = useCallback((satir: Satir, aileIdx: number, urunIdx: number | null) => {
    const aile = aileler[aileIdx];
    if (!aile) return;
    const tekli = satir.urunler.length === 1;
    const idx = urunIdx ?? (tekli ? 0 : null);
    const ekleHedefi = (productId: string, ad: string, tumVaryantlar: boolean): DosyaEkleHedefi => ({
      productId, ad, aileAdi: aile.ad, printerConfigId: aile.yazicilar[0].id,
      varyantSayisi: satir.urunler.length, tumVaryantlar,
    });
    if (idx != null) {
      const urun = satir.urunler[idx];
      const h = satir.varyantHucreleri[idx][aileIdx];
      if (h.durum === "var") setParts({ productId: urun.productId, aile });
      else setEkle(ekleHedefi(urun.productId, urun.name, false));
      return;
    }
    const h = satir.hucreler[aileIdx];
    if (h.durum === "yok") {
      // Hiçbir varyantta yok → dosya grubun tamamına eklenir (pencerede kapatılabilir).
      // Anahtar kilitli (grupSabit): kapatılınca dosya adı görünmeyen ilk varyanta gidiyordu.
      setEkle({ ...ekleHedefi(satir.urunler[0].productId, satir.ad, true), grupSabit: true });
    } else if (h.durum === "var" && h.ayniDosyalar) {
      // Renk varyantları aynı dosyayı taşıyor → hangisinden açıldığı fark etmez.
      setParts({ productId: satir.urunler[0].productId, aile });
    } else {
      // Kısmen dolu ya da varyantların dosyaları farklı → hangisi olduğunu kullanıcı seçsin.
      setAcik((eski) => new Set(eski).add(satir.anahtar));
    }
  }, [aileler]);

  const tazele = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["models"] });
    // Ürün sayfasındaki kart ve "Baskı Başlat" listesi de yeni dosyayı görsün.
    qc.removeQueries({ queryKey: ["product-models"] });
    void qc.invalidateQueries({ queryKey: ["printable-models"] });
  }, [qc]);

  const suzgecVar = filtre.tur !== "tumu" || q.trim() !== "";
  const kolonlar = `minmax(0,1fr) repeat(${Math.max(1, aileler.length)}, minmax(64px,104px)) 72px`;

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-4 p-6">
      {/* Başlık — tek satır; sayfanın işi aşağıdaki tablo. */}
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 animate-in fade-in slide-in-from-top-2 duration-500 motion-reduce:animate-none">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-[#9B5CFF] to-[#4F8CFF] text-white shadow-[0_12px_30px_-12px_rgba(122,126,255,0.9)]">
            <Boxes className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Model Kütüphanesi</h1>
            <p className="text-xs text-muted-foreground">
              Hangi modelin baskı dosyası var, hangisinin yok.{" "}
              <Link href="/planner" className="group/plan inline-flex items-center gap-0.5 font-medium text-[#A9AEFF] transition-colors hover:text-[#C9D2F2]">
                Üretim Planı
                <ArrowUpRight className="h-3 w-3 transition-transform group-hover/plan:-translate-y-px group-hover/plan:translate-x-px" />
              </Link>
            </p>
          </div>
        </div>
        {!isLoading && !(isError && !data) && (
          <div className="flex items-stretch gap-2">
            <Stat value={ozet.toplam} label="model" />
            <Stat value={toplamParca} label="parça" />
            {/*
              Buluttaki GERÇEK kullanım. Satırları toplamak yanlış olurdu: aynı dosya varyant
              ürünlerde paylaşılıyor ve bulutta bir kez duruyor (ölçüldü: satır toplamı 8,39 GB,
              gerçek 5,59 GB).
            */}
            {storage && storage.totalBytes > 0 && (
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
        )}
      </header>

      {/* Yenileme düştü ama elde liste var: liste kalır, kısa şerit çıkar. */}
      {isError && data && (
        <div className="flex items-center justify-between gap-3 rounded-2xl bg-[#7A7EFF]/[0.06] px-4 py-2.5 ring-1 ring-[#7A7EFF]/25 animate-in fade-in slide-in-from-top-1 duration-300">
          <p className="flex min-w-0 items-center gap-2 text-xs font-medium text-[#C9D2F2]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[#A9AEFF]" />
            Liste güncellenemedi — son alınan gösteriliyor.
          </p>
          <Button variant="outline" size="sm" className="h-7 shrink-0 gap-1.5 rounded-lg text-xs" disabled={isFetching} onClick={() => void refetch()}>
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} /> Tekrar dene
          </Button>
        </div>
      )}

      {isLoading ? (
        <Iskelet />
      ) : isError && !data ? (
        // Okunamadı ≠ yazıcı/ürün yok: eskiden "Önce yazıcı ekle" ve "0 model" yazıyordu.
        <div className="rounded-2xl bg-rose-500/[0.05] py-14 text-center ring-1 ring-rose-400/25 animate-in fade-in duration-300">
          <AlertTriangle className="mx-auto h-9 w-9 text-rose-300/80" />
          <p className="mt-3 font-medium">Model listesi yüklenemedi</p>
          <p className="mt-1 text-sm text-muted-foreground">Bağlantını kontrol edip tekrar dene.</p>
          <Button variant="outline" size="sm" className="mt-4 gap-1.5" disabled={isFetching} onClick={() => void refetch()}>
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} /> Tekrar dene
          </Button>
        </div>
      ) : printers.length === 0 ? (
        <EmptyHint title="Önce yazıcı ekle" desc="Yazıcılar → Yönet'ten yazıcılarını ekledikten sonra ürünlere baskı dosyası yükleyebilirsin." />
      ) : tumSatirlar.length === 0 ? (
        <EmptyHint title="Henüz ürün yok" desc="Ürün ekledikçe burada listelenir; her biri için hangi yazıcının dosyası olduğunu görürsün." />
      ) : (
        <>
          {/* KAPSAMA — yazıcı başına kaç modelin dosyası var; aynı zamanda süzgeç. */}
          <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(230px,1fr))]">
            {aileler.map((aile, i) => (
              <KapsamKarti
                key={aile.anahtar}
                aile={aile}
                varSayisi={ozet.aileVar[i] ?? 0}
                toplam={ozet.toplam}
                secili={filtre.tur === "aile" && filtre.aile === aile.anahtar ? filtre.durum : null}
                onSec={(durum) =>
                  setFiltre((f) =>
                    f.tur === "aile" && f.aile === aile.anahtar && f.durum === durum
                      ? { tur: "tumu" }
                      : { tur: "aile", aile: aile.anahtar, durum },
                  )
                }
                sira={i}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] max-w-sm flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              {/* Arama parça adlarında da çalışır — dosya adı çoğu zaman aranan bilgiyi taşır. */}
              <Input placeholder="Model veya parça ara…" value={q} onChange={(e) => setQ(e.target.value)} className="h-9 rounded-xl border-white/[0.08] bg-white/[0.03] pl-9 pr-8 dark:bg-white/[0.03] focus-visible:border-[#7A7EFF]/50 focus-visible:ring-[#7A7EFF]/25" />
              {q && (
                <button
                  type="button"
                  onClick={() => setQ("")}
                  aria-label="Aramayı temizle"
                  className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-0.5 rounded-xl bg-white/[0.03] p-1 ring-1 ring-white/[0.07]">
              <Sekme active={filtre.tur === "tumu"} onClick={() => setFiltre({ tur: "tumu" })} sayi={ozet.toplam}>Tümü</Sekme>
              <Sekme active={filtre.tur === "dosyali"} onClick={() => setFiltre({ tur: "dosyali" })} sayi={ozet.dosyali}>Dosyası var</Sekme>
              <Sekme active={filtre.tur === "dosyasiz"} onClick={() => setFiltre({ tur: "dosyasiz" })} sayi={ozet.dosyasiz}>Dosyası yok</Sekme>
            </div>

            <div className="ml-auto flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground">Sırala</span>
              {SIRALAR.map(([mod, etiket]) => (
                <FilterChip key={mod} active={sira === mod} onClick={() => setSira(mod)}>
                  {etiket}
                </FilterChip>
              ))}
            </div>
          </div>

          {/* TABLO — satır = model, sütun = yazıcı. Sütunlar hizalı olduğu için boşluklar yukarıdan aşağı okunur. */}
          {/* `overflow-clip` (hidden DEĞİL): hidden kaydırma bağlamı açar ve başlık yapışmaz. */}
          <div className="overflow-clip rounded-2xl bg-card ring-1 ring-white/[0.07] shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_18px_40px_-28px_rgba(0,0,0,0.8)] animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none">
            <div
              className="sticky top-0 z-10 grid items-center gap-2 rounded-t-2xl border-b border-white/[0.06] bg-card/95 px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur"
              style={{ gridTemplateColumns: kolonlar }}
            >
              <span className="pl-7">
                Model
                <span className="ml-2 font-normal normal-case tracking-normal text-muted-foreground/70 tabular-nums">
                  {satirlar.length === tumSatirlar.length ? `${tumSatirlar.length}` : `${satirlar.length} / ${tumSatirlar.length}`}
                </span>
              </span>
              {aileler.map((a) => (
                <span key={a.anahtar} className="truncate text-center" title={a.yazicilar.map((y) => y.name).join(", ")}>
                  {a.kisaAd}
                </span>
              ))}
              <span className="text-right">Boyut</span>
            </div>

            {satirlar.length === 0 ? (
              <div className="px-4 py-12 text-center animate-in fade-in duration-300">
                <Search className="mx-auto h-8 w-8 text-muted-foreground/30" />
                <p className="mt-2 text-sm font-medium">Buna uyan model yok</p>
                {suzgecVar && (
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => { setQ(""); setFiltre({ tur: "tumu" }); }}>
                    Süzgeci temizle
                  </Button>
                )}
              </div>
            ) : (
              <div className="divide-y divide-white/[0.05]">
                {satirlar.map((s, i) => (
                  <SatirGorunumu
                    key={s.anahtar}
                    satir={s}
                    aileler={aileler}
                    kolonlar={kolonlar}
                    acik={acik.has(s.anahtar)}
                    eslesenParca={eslesenParcalar.get(s.anahtar) ?? 0}
                    sira={i}
                    onAcKapa={acKapa}
                    onHucre={hucreTikla}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Kapalı / silinmiş yazıcıların dosyaları: görünmüyor ama bulutta yer tutuyor → göster, silinebilsin. */}
          {sahipsizler.length > 0 && (
            <button
              type="button"
              onClick={() => setSahipsizAcik(true)}
              className="group flex w-full items-center gap-3 rounded-2xl bg-[#7A7EFF]/[0.05] px-4 py-3 text-left ring-1 ring-[#7A7EFF]/20 transition-[background-color,transform] hover:bg-[#7A7EFF]/[0.09] active:scale-[0.995] animate-in fade-in slide-in-from-bottom-1 duration-300"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#7A7EFF]/15 text-[#C9D2F2] ring-1 ring-[#7A7EFF]/25">
                <HardDrive className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  {sahipsizler.length} dosya kapalı ya da silinmiş yazıcılara ait
                </span>
                <span className="block text-xs text-muted-foreground">
                  Tabloda görünmüyor · {fmtSize(sahipsizler.reduce((t, f) => t + (f.sizeBytes ?? 0), 0))} yer tutuyor
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-[#A9AEFF]">
                Gör ve sil <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </button>
          )}

          {/* Açıklama — renkler tek başına bilgi taşımasın. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Check className="h-3 w-3" style={{ color: YESIL }} /> dosyası var — tıkla, parçaları gör ve bas
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CircleDashed className="h-3 w-3" style={{ color: "var(--panel-amber)" }} /> bazı varyantlarda eksik
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Plus className="h-3 w-3" /> yok — tıkla, dosya ekle
            </span>
          </div>
        </>
      )}

      {parts && parcaUrunu && (
        <PartsModal
          product={parcaUrunu}
          aile={parts.aile}
          printers={printers}
          onClose={() => setParts(null)}
          onDegisti={tazele}
        />
      )}
      {sahipsizAcik && (
        <SahipsizDosyalarPenceresi dosyalar={sahipsizler} onClose={() => setSahipsizAcik(false)} onSilindi={tazele} />
      )}
      {ekle && <DosyaEkleDialog hedef={ekle} onClose={() => setEkle(null)} onEklendi={tazele} />}
    </div>
  );
}

/** Bir yazıcının kapsaması: kaç modelin dosyası var. İki düğme listeyi o yazıcıya göre süzer. */
function KapsamKarti({
  aile, varSayisi, toplam, secili, onSec, sira,
}: {
  aile: KapsamAilesi;
  varSayisi: number;
  toplam: number;
  secili: "var" | "yok" | null;
  onSec: (durum: "var" | "yok") => void;
  sira: number;
}) {
  const yok = Math.max(0, toplam - varSayisi);
  const oran = toplam > 0 ? varSayisi / toplam : 0;
  const altAd = aile.yazicilar.length > 1 ? `${aile.yazicilar.length} yazıcı · ${aile.yazicilar.map((y) => y.name).join(", ")}` : aile.yazicilar[0]?.name;
  return (
    <div
      className={cn(
        "rounded-2xl p-4 ring-1 transition-[box-shadow,transform,background-color] duration-300 hover:-translate-y-0.5 motion-reduce:hover:translate-y-0",
        "animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-500 motion-reduce:animate-none",
        secili
          ? "bg-gradient-to-br from-[#9B5CFF]/15 to-[#4F8CFF]/[0.06] ring-[#7A7EFF]/40 shadow-[0_20px_40px_-30px_rgba(122,126,255,0.7)]"
          : "bg-card ring-white/[0.07] hover:ring-white/[0.12] hover:shadow-[0_20px_40px_-30px_rgba(122,126,255,0.55)]",
      )}
      style={{ animationDelay: `${sira * 60}ms` }}
    >
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-[#9B5CFF]/25 to-[#4F8CFF]/20 text-[#C9D2F2] ring-1 ring-white/10">
          <Printer className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-tight">{aile.ad}</p>
          {altAd && altAd !== aile.ad && <p className="truncate text-[10px] text-muted-foreground" title={altAd}>{altAd}</p>}
        </div>
        <p className="shrink-0 text-right tabular-nums leading-none">
          <AnimatedNumber value={Math.round(oran * 100)} format={(n) => `%${Math.round(n)}`} className="text-xl font-semibold tracking-tight" />
        </p>
      </div>

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.06]" role="progressbar" aria-valuemin={0} aria-valuemax={toplam} aria-valuenow={varSayisi} aria-label={`${aile.ad}: ${varSayisi}/${toplam} modelin dosyası var`}>
        <div
          className="h-full origin-left rounded-full transition-[width] duration-700 ease-out [animation:panel-bar-fill_0.8s_cubic-bezier(.2,.8,.2,1)_both] motion-reduce:[animation:none]"
          style={{ width: `${Math.round(oran * 1000) / 10}%`, background: `linear-gradient(90deg, rgb(52 211 153 / 0.55), ${YESIL})`, animationDelay: `${120 + sira * 70}ms` }}
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-1.5">
        <KapsamDugmesi active={secili === "var"} onClick={() => onSec("var")} renk={YESIL} sayi={varSayisi} etiket="dosyası var" ipucu={`Yalnız ${aile.ad} dosyası olanları göster`} ikon={<Check className="h-3 w-3" />} />
        <KapsamDugmesi active={secili === "yok"} onClick={() => onSec("yok")} renk="var(--panel-amber)" sayi={yok} etiket="eksik" ipucu={`Yalnız ${aile.ad} dosyası eksik olanları göster`} ikon={<CircleDashed className="h-3 w-3" />} />
      </div>
    </div>
  );
}

function KapsamDugmesi({
  active, onClick, renk, sayi, etiket, ipucu, ikon,
}: { active: boolean; onClick: () => void; renk: string; sayi: number; etiket: string; ipucu: string; ikon: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={active ? "Süzgeci kaldır" : ipucu}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition-all active:scale-[0.97]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7A7EFF]/60",
        active ? "font-semibold" : "border-white/[0.08] bg-white/[0.02] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground",
      )}
      style={active ? { borderColor: `color-mix(in oklch, ${renk} 55%, transparent)`, backgroundColor: `color-mix(in oklch, ${renk} 14%, transparent)`, color: renk } : undefined}
    >
      <span style={active ? undefined : { color: renk }}>{ikon}</span>
      <span className="font-mono font-semibold tabular-nums">{sayi}</span>
      <span>{etiket}</span>
    </button>
  );
}

/** Tablo hücresi: var (yeşil, parça sayısı) · kısmen (amber, kaç varyantta) · yok (kesikli, "ekle"). */
function Hucre({ h, aciklama, onClick }: { h: KapsamHucresi; aciklama: string; onClick: () => void }) {
  const ortak = "group/h flex h-7 w-full items-center justify-center gap-1 rounded-lg border text-[11px] transition-all duration-150 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7A7EFF]/60";
  if (h.durum === "var") {
    return (
      <button
        type="button"
        onClick={onClick}
        title={`${aciklama} — parçaları gör ve bas`}
        className={cn(ortak, "hover:brightness-125")}
        style={{ color: YESIL, borderColor: `color-mix(in oklch, ${YESIL} 32%, transparent)`, backgroundColor: `color-mix(in oklch, ${YESIL} 12%, transparent)` }}
      >
        <Check className="h-3.5 w-3.5" />
        <span className="font-mono font-semibold tabular-nums">{h.parca}</span>
      </button>
    );
  }
  if (h.durum === "kismi") {
    return (
      <button
        type="button"
        onClick={onClick}
        title={`${aciklama} — varyantları aç`}
        className={cn(ortak, "hover:brightness-125")}
        style={{ color: "var(--panel-amber)", borderColor: "var(--panel-amber-line)", backgroundColor: "var(--panel-amber-soft)" }}
      >
        <CircleDashed className="h-3.5 w-3.5" />
        <span className="font-mono font-semibold tabular-nums">{h.varyantVar}/{h.varyantToplam}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${aciklama} — dosya ekle`}
      className={cn(ortak, "border-dashed border-white/[0.09] text-muted-foreground/35 hover:border-[#7A7EFF]/50 hover:bg-[#7A7EFF]/10 hover:text-[#C9D2F2]")}
    >
      <span className="group-hover/h:hidden">—</span>
      <span className="hidden items-center gap-1 font-medium group-hover/h:inline-flex">
        <Plus className="h-3 w-3" /> Ekle
      </span>
    </button>
  );
}

const DURUM_RENGI: Record<Satir["durum"], string | null> = { tam: YESIL, eksik: "var(--panel-amber)", yok: null };

/** Bir model: tek satır; varyantları varsa açılır. */
const SatirGorunumu = memo(function SatirGorunumu({
  satir, aileler, kolonlar, acik, eslesenParca, sira, onAcKapa, onHucre,
}: {
  satir: Satir;
  aileler: KapsamAilesi[];
  kolonlar: string;
  acik: boolean;
  eslesenParca: number;
  sira: number;
  onAcKapa: (anahtar: string) => void;
  onHucre: (satir: Satir, aileIdx: number, urunIdx: number | null) => void;
}) {
  const coklu = satir.urunler.length > 1;
  const renk = DURUM_RENGI[satir.durum];
  return (
    <div
      className="animate-in fade-in"
      style={{ animationDelay: `${Math.min(sira, 14) * 18}ms`, animationFillMode: "both", animationDuration: "260ms" }}
    >
      <div
        className={cn("relative grid items-center gap-2 px-3 py-1.5 transition-colors duration-200 hover:bg-white/[0.03]", acik && "bg-white/[0.025]")}
        style={{ gridTemplateColumns: kolonlar }}
      >
        {/* Durum çizgisi: tam yeşil · eksik amber · dosyasız boş — tabloyu kenardan da okunur kılar. */}
        {renk && <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full" style={{ backgroundColor: renk }} aria-hidden />}

        <div className="flex min-w-0 items-center gap-2">
          {coklu ? (
            <button
              type="button"
              onClick={() => onAcKapa(satir.anahtar)}
              aria-expanded={acik}
              aria-label={acik ? "Varyantları gizle" : "Varyantları göster"}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronRight className={cn("h-3.5 w-3.5 transition-transform duration-200", acik && "rotate-90")} />
            </button>
          ) : (
            <span className="w-5 shrink-0" />
          )}
          <KartGorseli src={satir.gorsel} />
          <div className="min-w-0 flex-1">
            {coklu ? (
              <button
                type="button"
                onClick={() => onAcKapa(satir.anahtar)}
                className="block max-w-full truncate text-left text-[13px] font-medium leading-tight hover:underline"
                title={satir.ad}
              >
                {satir.ad}
              </button>
            ) : (
              <Link
                href={`/products/${satir.urunler[0].productId}`}
                className="block truncate text-[13px] font-medium leading-tight hover:underline"
                title={satir.ad}
              >
                {satir.ad}
              </Link>
            )}
            {(coklu || eslesenParca > 0) && (
              <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                {/* Varyant adları satırda: aynı adlı iki grup (PS5 / Xbox) ancak böyle ayırt ediliyor. */}
                {coklu && (
                  <span className="truncate">
                    <span className="font-medium text-foreground/70">{satir.urunler.length} varyant</span>
                    {" · "}
                    {satir.urunler.map((u) => varyantAdi(u, satir.ad)).join(" · ")}
                  </span>
                )}
                {eslesenParca > 0 && <span className="shrink-0 font-medium text-[#A9AEFF]">{eslesenParca} parça eşleşti</span>}
              </p>
            )}
          </div>
        </div>

        {aileler.map((a, ai) => (
          <Hucre
            key={a.anahtar}
            h={satir.hucreler[ai]}
            aciklama={hucreAciklamasi(satir.hucreler[ai], a.ad)}
            onClick={() => onHucre(satir, ai, null)}
          />
        ))}

        <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground/70">
          {satir.boyut > 0 ? fmtSize(satir.boyut) : "—"}
        </span>
      </div>

      {/* Varyantlar — her biri kendi ürün sayfasına gider, hücreleri ayrı ayrı doldurulur. */}
      {coklu && acik && (
        <div className="border-t border-white/[0.05] bg-white/[0.015] animate-in fade-in slide-in-from-top-1 duration-200">
          {satir.urunler.map((u, ui) => (
            <div
              key={u.productId}
              className="grid items-center gap-2 px-3 py-1 transition-colors hover:bg-white/[0.03]"
              style={{ gridTemplateColumns: kolonlar }}
            >
              <div className="flex min-w-0 items-center gap-2 pl-[52px]">
                <span className="h-1 w-1 shrink-0 rounded-full bg-[#A9AEFF]/50" />
                <Link
                  href={`/products/${u.productId}`}
                  className="group/v flex min-w-0 items-center gap-1 text-xs text-foreground/85 hover:text-foreground hover:underline"
                  title={u.name}
                >
                  <span className="truncate">{varyantAdi(u, satir.ad)}</span>
                  <ArrowUpRight className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/v:opacity-60" />
                </Link>
              </div>
              {aileler.map((a, ai) => (
                <Hucre
                  key={a.anahtar}
                  h={satir.varyantHucreleri[ui][ai]}
                  aciklama={hucreAciklamasi(satir.varyantHucreleri[ui][ai], a.ad)}
                  onClick={() => onHucre(satir, ai, ui)}
                />
              ))}
              <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground/60">
                {u.totalBytes > 0 ? fmtSize(u.totalBytes) : "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

/** Model görseli — dosya bu bilgisayarda yoksa (yalnız diğer makinede duran yerel görsel) kırık
 * resim yerine boş kutu ikonu. */
function KartGorseli({ src }: { src: string | null }) {
  const [kirik, setKirik] = useState(false);
  const url = src ? thumbUrl(src) : null;
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white/[0.04] ring-1 ring-white/[0.08]">
      {url && !kirik
        ? <img src={url} alt="" loading="lazy" decoding="async" className="max-h-full max-w-full object-contain" onError={() => setKirik(true)} />
        : <Package className="h-4 w-4 text-muted-foreground/35" />}
    </div>
  );
}

/** Üç parçalı süzgeç sekmesi — yanında kaç model olduğu yazar. */
function Sekme({ active, onClick, sayi, children }: { active: boolean; onClick: () => void; sayi: number; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-all duration-200 active:scale-[0.97]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7A7EFF]/60",
        active
          ? "bg-gradient-to-br from-[#9B5CFF]/25 to-[#4F8CFF]/15 text-foreground ring-1 ring-[#7A7EFF]/30"
          : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
      )}
    >
      {children}
      <span className={cn("font-mono text-[10px] tabular-nums", active ? "text-[#C9D2F2]" : "text-muted-foreground/70")}>
        <AnimatedNumber value={sayi} />
      </span>
    </button>
  );
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
        "rounded-lg border px-2 py-1 text-[11px] font-medium transition-all active:scale-[0.97]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7A7EFF]/60",
        active
          ? "border-[#7A7EFF]/35 bg-[#7A7EFF]/15 text-[#C9D2F2]"
          : "border-white/[0.08] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function Stat({ value, text, label, title }: { value?: number; text?: string; label: string; title?: string }) {
  return (
    <div
      title={title}
      className="min-w-[76px] rounded-xl bg-card px-3.5 py-2 ring-1 ring-white/[0.07] transition-[transform,box-shadow] duration-300 hover:-translate-y-0.5 hover:ring-white/[0.12] animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none"
    >
      <p className="text-lg font-semibold leading-none tracking-tight tabular-nums">
        {text ?? <AnimatedNumber value={value ?? 0} />}
      </p>
      <p className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
    </div>
  );
}

/** Yüklenirken sayfanın iskeleti: kapsama kartları + tablo satırları kadar yer tutar. */
function Iskelet() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(230px,1fr))]">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[118px] w-full rounded-2xl" />)}
      </div>
      <Skeleton className="h-9 w-full max-w-xl rounded-xl" />
      <div className="overflow-hidden rounded-2xl ring-1 ring-white/[0.07]">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 border-b border-border/50 px-3 py-2 last:border-b-0">
            <Skeleton className="h-8 w-8 rounded-md" />
            <Skeleton className="h-3.5 flex-1" style={{ maxWidth: `${38 + ((i * 17) % 34)}%` }} />
            <div className="ml-auto flex gap-2">
              <Skeleton className="h-7 w-20 rounded-md" />
              <Skeleton className="h-7 w-20 rounded-md" />
              <Skeleton className="h-7 w-20 rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyHint({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-2xl py-16 text-center ring-1 ring-white/[0.07] animate-in fade-in duration-300">
      <Boxes className="h-10 w-10 mx-auto text-muted-foreground/30" />
      <p className="mt-3 font-medium">{title}</p>
      <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">{desc}</p>
    </div>
  );
}

/** Kapalı / silinmiş yazıcıların dosyaları — listele ve tek seferde sil. */
function SahipsizDosyalarPenceresi({
  dosyalar, onClose, onSilindi,
}: { dosyalar: SahipsizDosya[]; onClose: () => void; onSilindi: () => void }) {
  const [onay, setOnay] = useState(false);
  const [busy, setBusy] = useState(false);
  const toplam = dosyalar.reduce((t, f) => t + (f.sizeBytes ?? 0), 0);
  const sil = async () => {
    setBusy(true);
    try {
      const r = await fetchJson<{ silinen: number }>("/api/models/sahipsiz-sil", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: dosyalar.map((f) => f.id) }),
      });
      toast.success(`${r.silinen} dosya silindi`);
      onSilindi();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Silinemedi");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <HardDrive className="h-4 w-4 text-[#A9AEFF]" /> Sahipsiz dosyalar
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            Kapalı ya da silinmiş yazıcılara ait {dosyalar.length} dosya · {fmtSize(toplam)}
          </p>
        </DialogHeader>
        <div className="-mx-1 max-h-[50vh] space-y-1 overflow-y-auto px-1">
          {dosyalar.map((f, i) => (
            <div
              key={f.id}
              className="flex items-center gap-2.5 rounded-lg border border-white/[0.06] px-2.5 py-1.5 text-xs animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-300"
              style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{f.label || f.originalName}</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {f.productName} · {f.yaziciAdi ? `${f.yaziciAdi} (kapalı)` : "silinmiş yazıcı"}
                </p>
              </div>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{fmtSize(f.sizeBytes ?? 0)}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Kapat</Button>
          {onay ? (
            <Button size="sm" className="gap-1.5 bg-rose-500 text-white hover:bg-rose-500/90" disabled={busy} onClick={() => void sil()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Evet, {dosyalar.length} dosyayı sil
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="gap-1.5 text-rose-400 hover:bg-rose-500/10 hover:text-rose-300" onClick={() => setOnay(true)}>
              <Trash2 className="h-3.5 w-3.5" /> Hepsini sil
            </Button>
          )}
        </div>
        {onay && <p className="text-right text-[11px] text-muted-foreground">Bu işlem geri alınamaz.</p>}
      </DialogContent>
    </Dialog>
  );
}

function PartsModal({
  product, aile, printers, onClose, onDegisti,
}: {
  product: LibProduct; aile: KapsamAilesi; printers: LibPrinter[]; onClose: () => void;
  /** Silme / ad değişikliğinden sonra: liste + diğer ekranların model listeleri tazelensin. */
  onDegisti: () => void;
}) {
  const qc = useQueryClient();
  // Tablo iki U1'i tek sütunda gösteriyor; hangisinde basılacağı BURADA seçilir.
  const [printerId, setPrinterId] = useState(aile.yazicilar[0].id);
  const printer: LibPrinter =
    printers.find((p) => p.id === printerId) ??
    printers.find((p) => p.id === aile.yazicilar[0].id) ??
    { id: printerId, name: aile.ad, brand: "", type: "", model: null };

  const multiColor = printer.brand === "bambu" || printer.brand === "snapmaker";

  // ── Yazıcılar arası filament karşılaştırması ────────────────────────────────────────
  // Aynı ürünün dört yazıcı için ayrı dosyaları farklı miktarda filament harcıyor (destek,
  // dolgu, dilimleyici ayarı). Bu fark hiçbir yerde görünmüyordu.
  // ⚠️ Bu gramaj ÜRÜN MALİYETİNDEN tamamen ayrı bir alan — maliyeti etkilemez.
  /** Dosyadan okunan değerler (düğmeyle ya da arka planda) — sunucu listesi tazelenene dek üstte durur. */
  const [okunan, setOkunan] = useState<Record<string, { gramaj: number | null; estPrintMin: number | null; hasThumbnail?: boolean }>>({});
  const [okuma, setOkuma] = useState<{ done: number; total: number } | null>(null);
  /**
   * Silinen parçalar ve yeni adlar, liste tazelenene kadar ÜSTTE tutulur — "Dosya silindi" deyip
   * parçayı göstermeye devam etmesin, yeni ad hemen görünsün.
   */
  const [silinenler, setSilinenler] = useState<ReadonlySet<string>>(() => new Set());
  const [yeniAdlar, setYeniAdlar] = useState<Record<string, string | null>>({});
  const dosyalar = useMemo(
    () =>
      product.files
        .filter((f) => !silinenler.has(f.id))
        .map((f) => (f.id in yeniAdlar ? { ...f, label: yeniAdlar[f.id] } : f))
        .map((f) => (okunan[f.id] ? bilgiyiIsle(f, okunan[f.id]) : f)),
    [product.files, okunan, silinenler, yeniAdlar]
  );
  const printerIds = useMemo(() => printers.map((p) => p.id), [printers]);
  const karsilastirma = useMemo(() => gramajByPrinter(dosyalar, printerIds), [dosyalar, printerIds]);
  const karsilastirmaMetni = useMemo(() => gramajCompareText(karsilastirma), [karsilastirma]);
  const eksikler = useMemo(() => missingGramajFiles(dosyalar), [dosyalar]);

  const gramajlariOku = async () => {
    setOkuma({ done: 0, total: eksikler.length });
    for (const [i, f] of eksikler.entries()) {
      try {
        const r = await fetchJson<{ gramaj: number | null; estPrintMin: number | null; hasThumbnail?: boolean }>(
          `/api/models/${f.id}/gramaj`, { method: "POST" }
        );
        setOkunan((prev) => ({ ...prev, [f.id]: r }));
      } catch {
        // Tek dosya okunamazsa diğerleri devam etsin; sonuç zaten "—" kalır.
      }
      setOkuma({ done: i + 1, total: eksikler.length });
    }
    setOkuma(null);
    void qc.invalidateQueries({ queryKey: ["models"] });
  };

  // Aile: ikinci U1, ilk U1'e yüklenen dosyaları da görür ve basar (aynı içerik bir kez).
  const parts = useMemo(() => aileDosyalari(dosyalar, printer.id, printers), [dosyalar, printer.id, printers]);

  const [printing, setPrinting] = useState(false);
  const [progress, setProgress] = useState<PrintProg | null>(null);
  const [picked, setPicked] = useState<LibFile | null>(null);
  // Listelenen parçaların eksik bilgisi (süre / gramaj / önizleme) arka planda okunur.
  const okunanlar = useEksikBilgiyiTamamla(parts, !picked && !okuma, (id, b) => {
    setOkunan((prev) => ({ ...prev, [id]: b }));
  });
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
    const hedef = dosyalar.find((f) => f.id === renaming.id);
    setBusy(true);
    try {
      // Paylaşılan dosyada ad TÜM varyantlarda değişir (eskiden yalnız bu satırda değişiyordu).
      const tumu = hedef && hedef.sharedWith > 1 ? "?allVariants=1" : "";
      await fetchJson(`/api/models/${renaming.id}${tumu}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // Boş bırakılırsa etiket kaldırılır → dosyanın kendi adı görünür.
        body: JSON.stringify({ label: label || null }),
      });
      setYeniAdlar((m) => ({ ...m, [renaming.id]: label || null }));
      setRenaming(null);
      onDegisti(); // beklenmez — düğmeler soğuk hesap boyunca kilitli kalmasın
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Kaydedilemedi");
    } finally {
      setBusy(false);
    }
  };

  /** Silinecek parçanın ailedeki ikiz kopyaları (aynı içerik, ailenin başka yazıcısında). */
  const ikizler = useMemo(() => (deleting ? aileIkizleri(dosyalar, deleting, printers) : []), [deleting, dosyalar, printers]);

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      // Paylaşılan dosyada TÜM kayıtlar silinir (kullanıcı onay penceresinde bunu gördü); ikiz
      // kopyalar da birlikte gider. Bulut nesnesi yalnız son referans kalkınca silinir.
      const sorgu = new URLSearchParams();
      if (deleting.sharedWith > 1 || ikizler.some((f) => f.sharedWith > 1)) sorgu.set("allVariants", "1");
      if (ikizler.length) sorgu.set("ek", ikizler.map((f) => f.id).join(","));
      const qs = sorgu.toString();
      await fetchJson(`/api/models/${deleting.id}${qs ? `?${qs}` : ""}`, { method: "DELETE" });
      const giden = [deleting.id, ...ikizler.map((f) => f.id)];
      setSilinenler((m) => new Set([...m, ...giden]));
      toast.success(ikizler.length ? `Dosya ve ${ikizler.length} kopyası silindi` : "Dosya silindi");
      setDeleting(null);
      onDegisti(); // beklenmez
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Silinemedi");
    } finally {
      setBusy(false);
    }
  };

  const runPrint = async (fileId: string, opts: BaskiSecenekleri = {}) => {
    setPrinting(true);
    setProgress({ stage: "upload", pct: 0 });
    try {
      const { uyari } = await runPrintStream(fileId, opts, setProgress);
      toast.success("Baskı başlatıldı 🎉");
      if (uyari) toast.warning(uyari, { duration: 12000 });
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
    const dosya = parts.find((f) => f.id === picked.id) ?? picked; // en güncel bilgiyle
    const model: PrintableModel = {
      fileId: dosya.id, productId: product.productId, productName: product.name, imageUrl: product.imageUrl,
      label: dosya.label, originalName: dosya.originalName, sizeBytes: dosya.sizeBytes, gramaj: dosya.gramaj,
      estPrintMin: dosya.estPrintMin, hasThumbnail: dosya.hasThumbnail, renkler: dosya.renkler, fileType: dosya.fileType,
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 min-w-0 pr-8"><Layers className="h-4 w-4 text-primary shrink-0" /> <span className="truncate">{product.name}</span></DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">{printer.name} · {parts.length} parça. {multiColor ? "Parçaya bas → renkleri seç → baskı başlar." : "Bir parçaya bas → yazıcıya yüklenip baskı başlar."}</p>
        </DialogHeader>

        {aile.yazicilar.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-muted-foreground">Hangi yazıcıda?</span>
            <div className="flex items-center gap-0.5 rounded-xl bg-white/[0.03] p-1 ring-1 ring-white/[0.07]">
              {aile.yazicilar.map((y) => (
                <button
                  key={y.id}
                  type="button"
                  disabled={printing}
                  onClick={() => setPrinterId(y.id)}
                  aria-pressed={printerId === y.id}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-all active:scale-[0.97] disabled:opacity-60",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    printerId === y.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {y.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Hangi makine bu ürünü daha az filamentle basıyor? */}
        {karsilastirma.length > 1 && (
          <div className="rounded-xl bg-white/[0.03] p-2.5 space-y-2 ring-1 ring-white/[0.07]">
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
                  className="h-full bg-gradient-to-r from-[#9B5CFF] to-[#4F8CFF] transition-[width] duration-300"
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
                        ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 font-medium"
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
            <div key={part.id} className="flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.015] p-2 transition-colors hover:border-white/[0.12] animate-in fade-in duration-200">
              {/*
                ÖNİZLEME: dosya adı tek başına "hangi parça bu?" sorusunu cevaplamıyordu —
                altı parçalı bir üründe hangisini basacağını addan tahmin etmek gerekiyordu.
                Görsel varsa gösterilir; her hâlde tıklanabilir ve 3B izleyiciyi açar.
              */}
              <ParcaGorseli p={part} boyut="lg" sira={i} okunuyor={okunanlar.has(part.id)} onClick={() => setViewer(part)} />
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
                      maxLength={80}
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
                    <p className="text-sm font-medium truncate" title={part.originalName}>{gorunenAd(part)}</p>
                    <ParcaBilgiSatiri p={part} okunuyor={okunanlar.has(part.id)} className="mt-1" />
                    {part.sharedWith > 1 && (
                      <p className="mt-0.5 text-[10px] text-[#A9AEFF]" title={`Bu dosya ${part.sharedWith} üründe kullanılıyor`}>
                        {part.sharedWith} üründe kullanılıyor
                      </p>
                    )}
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
                    size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-400"
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
          <Link href="/planner" className="text-[#A9AEFF] hover:underline">
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
              <DialogTitle className="text-rose-400">Bu dosya silinsin mi?</DialogTitle>
            </DialogHeader>
            <div className="space-y-2 text-sm">
              <p className="font-medium break-words">{deleting.label || deleting.originalName}</p>
              <p className="text-xs text-muted-foreground">
                {printers.find((p) => p.id === deleting.printerConfigId)?.name ?? printer.name} · {fmtSize(deleting.sizeBytes)}
                {deleting.gramaj ? ` · ${deleting.gramaj} gr` : ""}
              </p>
              {deleting.sharedWith > 1 && (
                <p className="rounded-lg border border-[#7A7EFF]/35 bg-[#7A7EFF]/10 p-2 text-xs text-[#C9D2F2]">
                  Bu dosya {deleting.sharedWith} üründe kullanılıyor. Silersen hepsinden kalkar.
                </p>
              )}
              {ikizler.length > 0 && (
                <p className="rounded-lg border border-[#7A7EFF]/35 bg-[#7A7EFF]/10 p-2 text-xs text-[#C9D2F2]">
                  Aynı dosyanın {ikizler.length} kopyası daha var (
                  {[...new Set(ikizler.map((f) => printers.find((p) => p.id === f.printerConfigId)?.name ?? "başka yazıcı"))].join(", ")}
                  ) — onlar da silinir.
                </p>
              )}
              <p className="text-xs text-muted-foreground">Bu işlem geri alınamaz.</p>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => setDeleting(null)} disabled={busy}>
                Vazgeç
              </Button>
              <Button size="sm" className="gap-1.5 bg-rose-500 text-white hover:bg-rose-500/90" onClick={() => void confirmDelete()} disabled={busy}>
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
