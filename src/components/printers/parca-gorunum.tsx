"use client";
/* eslint-disable @next/next/no-img-element */
/**
 * BASKI PARÇASININ ORTAK GÖRÜNÜMÜ — "ne basıyorum?" sorusunun cevabı.
 *
 * Parça dört ekranda listeleniyor: ürünün Baskı Dosyaları kartı, Yazıcılar → Baskı Başlat,
 * Ürünler → hızlı baskı ve Model Kütüphanesi. Önceki üçü yalnız dosya adı ve gramaj yazıyordu;
 * altı parçalı bir üründe hangisini bastığını addan tahmin etmek gerekiyordu. Görsel, süre,
 * gramaj ve renkler artık hepsinde AYNI bileşenle çizilir.
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Box, CalendarClock, Clock3, Package, Weight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useDakika } from "@/lib/client-state";
import { thumbUrl } from "@/lib/image";
import { bitisMetni, fmtGram, fmtSure, gorunenAd, turEtiketi } from "@/lib/model-dosya-gorunum";

export interface ParcaBilgisi {
  /** Baskı dosyasının kimliği — önizleme görseli bununla çekilir. */
  id: string;
  label: string | null;
  originalName: string;
  sizeBytes: number;
  gramaj: number | null;
  estPrintMin?: number | null;
  hasThumbnail?: boolean;
  renkler?: string[];
  fileType?: string;
  sliced?: boolean | null;
}

export function fmtBoyut(b: number): string {
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)} GB`;
  return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}

const onizlemeYolu = (id: string) => `/api/models/${id}/preview`;
/** Tür bilinmiyorsa dosya adından çıkar. */
const turu = (p: ParcaBilgisi) => p.fileType || (/\.3mf$/i.test(p.originalName) ? "3mf" : "gcode");

/** Küçük resmin üstüne gelince açılan büyük önizleme — pencere kenarında kırpılmasın diye gövdeye çizilir. */
function BuyukOnizleme({ src, hedef }: { src: string; hedef: DOMRect }) {
  const BOY = 236;
  // Önce SOLA açılır: sağda satırın kendi adı ve bilgileri var, onları kapatmasın.
  const solda = hedef.left - 12 - BOY >= 8;
  const sol = solda ? hedef.left - 12 - BOY : Math.min(hedef.right + 12, window.innerWidth - BOY - 8);
  const ust = Math.min(Math.max(8, hedef.top + hedef.height / 2 - BOY / 2), window.innerHeight - BOY - 8);
  return createPortal(
    <div
      className="pointer-events-none fixed z-[70] rounded-xl border bg-popover p-1.5 shadow-2xl shadow-black/40 animate-in fade-in zoom-in-95 duration-150"
      style={{ left: sol, top: ust, width: BOY, height: BOY }}
    >
      <img src={src} alt="" className="h-full w-full rounded-lg object-contain" />
    </div>,
    document.body,
  );
}

const GORSEL_BOYU = {
  sm: "h-11 w-11 rounded-md",
  md: "h-14 w-14 rounded-lg",
  lg: "h-[72px] w-[72px] rounded-lg",
  xl: "h-32 w-32 rounded-xl",
} as const;

/**
 * Parçanın önizlemesi: dilimleyicinin dosyaya gömdüğü görsel. Yoksa (ve verilmişse) ürünün
 * fotoğrafı, o da yoksa kutu ikonu. Üstüne gelince büyür; `onClick` verilirse düğmedir.
 */
export function ParcaGorseli({
  p, boyut = "md", sira, okunuyor = false, yedekGorsel, onClick, buyut = true, className,
}: {
  p: ParcaBilgisi;
  boyut?: keyof typeof GORSEL_BOYU;
  /** Sol altta gösterilecek sıra numarası (0 tabanlı). */
  sira?: number;
  okunuyor?: boolean;
  /** Parçanın kendi görseli yoksa gösterilecek ürün fotoğrafı. */
  yedekGorsel?: string | null;
  onClick?: () => void;
  /** Üstüne gelince büyük önizleme açılsın mı (zaten büyük çizilen yerde gereksiz). */
  buyut?: boolean;
  className?: string;
}) {
  const [hata, setHata] = useState(false);
  const [yedekHata, setYedekHata] = useState(false);
  const [buyuk, setBuyuk] = useState<DOMRect | null>(null);
  // `hasThumbnail` hiç verilmemişse (eski çağrı) dene: yoksa görsel sessizce yedeğe düşer.
  const gorselVar = p.hasThumbnail !== false && !hata;
  const yedek = !gorselVar && yedekGorsel && !yedekHata ? thumbUrl(yedekGorsel) : null;
  const src = onizlemeYolu(p.id);
  const ad = gorunenAd(p);

  const icerik = (
    <>
      {gorselVar ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setHata(true)}
          className="h-full w-full object-contain animate-in fade-in zoom-in-95 duration-500"
        />
      ) : okunuyor ? (
        <Skeleton className="h-full w-full rounded-none" />
      ) : yedek ? (
        <img src={yedek} alt="" loading="lazy" decoding="async" onError={() => setYedekHata(true)} className="h-full w-full object-contain" />
      ) : (
        <Box className={cn("opacity-60", boyut === "xl" ? "h-9 w-9" : "h-5 w-5")} />
      )}
      {sira != null && (
        <span className="absolute bottom-0 left-0 rounded-tr-md bg-background/85 px-1 text-[9px] font-bold leading-tight tabular-nums text-primary">
          {sira + 1}
        </span>
      )}
    </>
  );
  const sinif = cn(
    "relative flex shrink-0 items-center justify-center overflow-hidden border border-border/60 bg-gradient-to-br from-primary/15 to-primary/5 text-primary",
    GORSEL_BOYU[boyut],
    onClick && "transition-transform duration-200 hover:scale-[1.04] active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    className,
  );
  const fare = buyut && gorselVar
    ? {
        onMouseEnter: (e: React.MouseEvent<HTMLElement>) => setBuyuk(e.currentTarget.getBoundingClientRect()),
        onMouseLeave: () => setBuyuk(null),
      }
    : {};

  return (
    <>
      {onClick ? (
        <button type="button" onClick={onClick} onBlur={() => setBuyuk(null)} aria-label={`${ad} — 3B önizleme`} title={gorselVar ? undefined : "3B önizleme"} className={sinif} {...fare}>
          {icerik}
        </button>
      ) : (
        <div className={sinif} {...fare}>{icerik}</div>
      )}
      {buyuk && gorselVar && <BuyukOnizleme src={src} hedef={buyuk} />}
    </>
  );
}

/** Kullanılan renkler — üst üste binen noktalar. */
export function RenkNoktalari({ renkler, sayiyla = true }: { renkler: readonly string[]; sayiyla?: boolean }) {
  if (!renkler.length) return null;
  return (
    <span className="inline-flex items-center" title={`${renkler.length} renk`}>
      {renkler.map((hex, i) => (
        <span
          key={`${hex}-${i}`}
          className={cn("h-3 w-3 rounded-full border border-background ring-1 ring-border/70", i > 0 && "-ml-1")}
          style={{ backgroundColor: hex }}
        />
      ))}
      {sayiyla && renkler.length > 1 && <span className="ml-1 tabular-nums">{renkler.length} renk</span>}
    </span>
  );
}

/** Dosyanın kendi bilgileri tek satırda: tür · süre · gramaj · renkler · boyut. */
export function ParcaBilgiSatiri({
  p, okunuyor = false, className,
}: { p: ParcaBilgisi; okunuyor?: boolean; className?: string }) {
  const sureVar = p.estPrintMin != null && p.estPrintMin > 0;
  const gramVar = p.gramaj != null && p.gramaj > 0;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground", className)}>
      <span className="rounded border border-border/70 px-1 font-mono text-[9px] font-semibold leading-4 tracking-wide text-muted-foreground/80">
        {turEtiketi(turu(p))}
      </span>
      {sureVar && (
        <span className="inline-flex items-center gap-1 tabular-nums text-foreground/80 animate-in fade-in duration-300" title="Tahmini baskı süresi">
          <Clock3 className="h-3 w-3 text-muted-foreground" /> {fmtSure(p.estPrintMin)}
        </span>
      )}
      {gramVar && (
        <span className="inline-flex items-center gap-1 tabular-nums text-foreground/80 animate-in fade-in duration-300" title="Kullanılan filament">
          <Weight className="h-3 w-3 text-muted-foreground" /> {fmtGram(p.gramaj)}
        </span>
      )}
      {okunuyor && (!sureVar || !gramVar) && (
        <span className="inline-flex items-center gap-1.5" aria-label="Dosya bilgisi okunuyor">
          <Skeleton className="h-3.5 w-14 rounded" />
          <Skeleton className="h-3.5 w-11 rounded" />
        </span>
      )}
      <RenkNoktalari renkler={p.renkler ?? []} />
      <span className="tabular-nums text-muted-foreground/70">{fmtBoyut(p.sizeBytes)}</span>
      {p.sliced === false && (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400" title="Bu dosya dilimlenmemiş; yazıcıya gönderilemez.">
          <AlertTriangle className="h-2.5 w-2.5" /> Dilimlenmemiş
        </span>
      )}
    </div>
  );
}

function Olcu({ ikon, etiket, deger, vurgulu }: { ikon: React.ReactNode; etiket: string; deger: string; vurgulu?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border bg-background/60 px-2.5 py-1.5">
      <p className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {ikon} {etiket}
      </p>
      <p className={cn("mt-0.5 truncate text-sm font-semibold tabular-nums", vurgulu && "text-primary")}>{deger}</p>
    </div>
  );
}

/**
 * BASKI ÖZETİ — başlatmadan önceki son adımda: büyük görsel, parça adı, ürün ve rakamlar.
 * "Yanlış parçayı mı basıyorum?" sorusu burada cevaplanır.
 */
export function ParcaOzetKarti({
  p, urunAdi, yaziciAdi, urunGorseli, renkler, okunuyor = false, className,
}: {
  p: ParcaBilgisi;
  /** Parçanın ait olduğu ürün — parça adından farklıysa altına yazılır. */
  urunAdi?: string | null;
  yaziciAdi?: string | null;
  urunGorseli?: string | null;
  /** Renkler başka bir kaynaktan da gelebilir (renk eşleme adımı dosyayı ayrıca okuyor). */
  renkler?: readonly string[];
  okunuyor?: boolean;
  className?: string;
}) {
  const simdi = useDakika();
  const ad = gorunenAd(p);
  const renkListesi = renkler?.length ? renkler : (p.renkler ?? []);
  const bitis = bitisMetni(simdi, p.estPrintMin);
  const sureVar = p.estPrintMin != null && p.estPrintMin > 0;
  const gramVar = p.gramaj != null && p.gramaj > 0;
  return (
    <div
      className={cn(
        "flex items-stretch gap-3 rounded-xl border bg-muted/25 p-2.5 animate-in fade-in slide-in-from-bottom-1 duration-300",
        className,
      )}
    >
      <ParcaGorseli p={p} boyut="xl" okunuyor={okunuyor} yedekGorsel={urunGorseli} buyut={false} />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold leading-tight" title={ad}>{ad}</p>
          {(urunAdi && urunAdi !== ad) || yaziciAdi ? (
            <p className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              {urunAdi && urunAdi !== ad && (
                <>
                  <Package className="h-3 w-3 shrink-0" />
                  <span className="truncate" title={urunAdi}>{urunAdi}</span>
                </>
              )}
              {yaziciAdi && <span className="shrink-0">{urunAdi && urunAdi !== ad ? "· " : ""}{yaziciAdi}</span>}
            </p>
          ) : null}
        </div>

        {(sureVar || gramVar || okunuyor) && (
          <div className="grid grid-cols-3 gap-1.5">
            {sureVar ? (
              <Olcu ikon={<Clock3 className="h-3 w-3" />} etiket="Süre" deger={fmtSure(p.estPrintMin)} />
            ) : okunuyor ? <Skeleton className="h-[46px] rounded-lg" /> : null}
            {gramVar ? (
              <Olcu ikon={<Weight className="h-3 w-3" />} etiket="Filament" deger={fmtGram(p.gramaj)} />
            ) : okunuyor ? <Skeleton className="h-[46px] rounded-lg" /> : null}
            {bitis && <Olcu ikon={<CalendarClock className="h-3 w-3" />} etiket="Biter" deger={bitis} vurgulu />}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span className="rounded border border-border/70 px-1 font-mono text-[9px] font-semibold leading-4 tracking-wide text-muted-foreground/80">
            {turEtiketi(turu(p))}
          </span>
          <RenkNoktalari renkler={renkListesi} />
          <span className="tabular-nums text-muted-foreground/70">{fmtBoyut(p.sizeBytes)}</span>
        </div>
      </div>
    </div>
  );
}
