"use client";
/* eslint-disable @next/next/no-img-element */

import { TimelapseStrip } from "@/components/printers/TimelapseGallery";
import { ViewerLoadingShell } from "@/components/printers/ViewerLoadingShell";
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Printer, Box, Flame, Layers, Clock, CheckCircle2, Loader2, Sparkles, Power,
  RefreshCw, Settings2, Plus, Trash2, Pause, Play, Ban, Pencil, WifiOff,
  Check, X, Search, Package, Link2, ArrowRight, AlertTriangle,
  Upload, FileBox, Weight, ChevronLeft, ChevronRight, FolderOpen, HardDrive,
  Lightbulb, Gauge, Rotate3d, Minus, Hourglass, Eye, RectangleHorizontal, Activity, Scissors, Camera,
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
import { usePrefersReducedMotion } from "@/lib/client-state";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { toast } from "sonner";
import { uploadCustomModel, type UploadProgress } from "@/lib/upload-model";
import { vizKeyForModel, getSprites, getPack, kareAnahtari } from "@/lib/gcode-viz/viz-cache";
import { setUploadsActive } from "@/lib/gcode-viz/viz-uploads";
// Görselleştirme boru hattı three (~539KB) çeker → DİNAMİK yükle (Yazıcılar initial bundle'ında değil).
const vizPipe = () => import("@/lib/gcode-viz/viz-pipeline");
import {
  SlotStep,
  type PrintableModel, type PrintPrefs,
} from "@/components/printers/print-flow";
import { CustomPrintLibrary } from "@/components/printers/CustomPrintLibrary";
import { startBackgroundPrint, activePrintKey, type ActivePrint } from "@/lib/print-jobs";
import type { VizPack } from "@/lib/gcode-viz/viz-pack";
// Ürün görselleri KÜÇÜK hâliyle çekilir: ham dosyalar 1,33 MB, küçüğü 21 KB (62 kat).
// Baskı Başlat seçicisinde 67 görsel var → ~89 MB yerine ~1,4 MB.
import { thumbUrl } from "@/lib/image";
// Kart görünümünün SAF kararları (durum tonu, kare seçimi, katman rozeti, nozul ölçeği…)
// test edilebilir tek yerde. Tipler API sözleşmesinin aynası — sapma testte tsc ile yakalanır.
import {
  bedFrameFor, buildSlotChips, connectionNotice, formatRemaining, intraLayerFraction,
  baskiYeniBittiMi,
  jobImageCandidates, layerBadgeText, nozzleDot, orderWarnings, pickBuildFrame, pickImage,
  resolvePackLayerIndex, resolveRemaining, resolveStage, resolveStatusVisual, slotLabel,
  type NozzleDot, type PanelPrinter, type PrinterJob, type PrinterStatus, type SlotChip,
  type StageFrame, type StatusTone, type StatusVisual,
} from "./panel-view";
// Kontrol düğmelerinin kararları (hangi düğme etkin, hangi hız kademesi seçilebilir, iptal
// onayında ne yazacak…) — saf ve test edilebilir tek yerde.
import {
  PENDING_LABEL, cancelSummary, clampLayerValue, layerStepTarget, nextFinishing, pauseLayerRange,
  pausedReminder, pendingBadgeLabel, resolveSpeedView, slotToolColors, transportControls,
  troubleList, parcaIptalDurumu,
  type CancelSummary, type LayerRange, type SpeedView, type TroubleItem,
} from "./panel-controls";
// Komut durumu YAZICI BAŞINA tutulur — tek mutation gözlemcisi eşzamanlı komutları karıştırıyordu.
import {
  NO_PENDING, addPending, anyPending, pendingFor, removePending, type PendingMap,
} from "./pending-actions";

// 3B izleyici three (~539KB) çeker → yalnız açıldığında yüklensin.
// Parça inerken ekran BOŞ kalmasın: tıklamanın işe yaradığı anında görünsün.
const GcodeViewerDialog = dynamic(
  () => import("@/components/printers/GcodeViewer").then((m) => m.GcodeViewerDialog),
  { ssr: false, loading: () => <ViewerLoadingShell /> },
);

/** Parça seçici de ayrı parça — yalnız gerektiğinde iner. */
const PartCancelDialog = dynamic(
  () => import("@/components/printers/PartCancelDialog").then((m) => m.PartCancelDialog),
  { ssr: false },
);

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

const EMPTY_LAST_JOBS = new Map<string, PrinterJob>();

function samePrinterJob(left: PrinterJob | undefined, right: PrinterJob): boolean {
  return !!left &&
    left.productName === right.productName &&
    left.productImage === right.productImage &&
    left.startedAt === right.startedAt &&
    left.endsAt === right.endsAt &&
    left.progress === right.progress &&
    left.remainingSec === right.remainingSec &&
    left.layerCurrent === right.layerCurrent &&
    left.layerTotal === right.layerTotal &&
    left.filamentType === right.filamentType &&
    left.filamentColor === right.filamentColor;
}

function createLastJobsStore() {
  let snapshot = EMPTY_LAST_JOBS;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update: (printers: PanelPrinter[]) => {
      const next = new Map(snapshot);
      let changed = false;
      for (const printer of printers) {
        if (printer.online && printer.job && (printer.status === "printing" || printer.status === "paused")) {
          if (!samePrinterJob(next.get(printer.id), printer.job)) {
            next.set(printer.id, printer.job);
            changed = true;
          }
        } else if (printer.online && (printer.status === "idle" || printer.status === "finished")) {
          changed = next.delete(printer.id) || changed;
        }
      }
      if (!changed) return;
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
  };
}

const EMPTY_PAUSED_SINCE: Record<string, number> = {};

/**
 * "Bu yazıcı ne zamandır duraklatılmış?" — hiçbir uçtan gelmiyor, ilk görüldüğü an damgalanıyor.
 * Bu yüzden metin ALT SINIR olarak yazılır (`pausedReminder`), kesin süre gibi değil.
 * Dış depo olarak tutulur (render sırasında ref okumadan, effect'te setState etmeden).
 */
function createPausedSinceStore() {
  let snapshot = EMPTY_PAUSED_SINCE;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update: (printers: PanelPrinter[]) => {
      const next: Record<string, number> = {};
      for (const p of printers) {
        // ÇEVRİMDIŞI olurken damga DÜŞMEZ: kısa bir ağ kesintisi 3 saatlik duraklamayı
        // sıfırdan başlatıyordu. Damga yalnız yazıcı çevrimiçiyken ve artık duraklamamışken silinir.
        if (p.online && p.status !== "paused") continue;
        if (p.status === "paused" || snapshot[p.id] != null) next[p.id] = snapshot[p.id] ?? Date.now();
      }
      const keys = Object.keys(next);
      const prevKeys = Object.keys(snapshot);
      if (keys.length === prevKeys.length && prevKeys.every((k) => snapshot[k] === next[k])) return;
      snapshot = keys.length ? next : EMPTY_PAUSED_SINCE;
      listeners.forEach((listener) => listener());
    },
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const alpha = (oklch: string, pct: number) => oklch.replace(")", ` / ${pct}%)`);

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    // Kullanıcıya adres/durum kodu düşmesin — sade bir mesaj yeter.
    throw new Error(body?.error || "İşlem tamamlanamadı");
  }
  return r.json() as Promise<T>;
}

// ── Komut ucu: POST /api/printers/<id>/action ──────────────────────────────
type ActionVars =
  | { id: string; action: "pause" | "resume" | "cancel" }
  | { id: string; action: "start"; filename?: string }
  | { id: string; action: "speed"; speedPercent?: number; speedLevel?: number }
  | { id: string; action: "light"; light: boolean | "toggle" }
  | { id: string; action: "pauseAtLayer"; layer: number | null }
  | { id: string; action: "changeFilament" };

type ActionKind = ActionVars["action"];

interface ActionResult {
  ok?: boolean;
  /** Yazıcı yeni durumu ONAYLADI → iyimser gösterim güvenle korunur. */
  verified?: boolean;
  state?: string;
  light?: boolean | null;
  speedPercent?: number;
  speedLevel?: number;
  pauseAtLayer?: number | null;
}

const SUCCESS_LABEL: Record<ActionKind, string> = {
  pause: "Duraklatıldı",
  resume: "Devam ettirildi",
  cancel: "İptal edildi",
  start: "Baskı başlatıldı",
  speed: "Hız değişti",
  light: "Işık değişti",
  pauseAtLayer: "Katman duraklatması güncellendi",
  changeFilament: "Filament değişimi için duraklatılıyor",
};

/** `layer: null` KORUNMALI (kaldırma komutu); undefined alanlar düşer. */
function actionBody(v: ActionVars): Record<string, unknown> {
  return { ...v, id: undefined };
}

/** Komut gönderilir gönderilmez kartta görünecek iyimser değişiklik (yoksa null). */
function optimisticPatch(v: ActionVars): ((p: PanelPrinter) => Partial<PanelPrinter>) | null {
  if (v.action === "pause") return () => ({ status: "paused" as PrinterStatus });
  if (v.action === "resume") return () => ({ status: "printing" as PrinterStatus });
  if (v.action === "cancel") return () => ({ status: "idle" as PrinterStatus, job: null });
  if (v.action === "light") {
    return (p) => (p.light.readable && typeof v.light === "boolean" ? { light: { ...p.light, on: v.light } } : {});
  }
  if (v.action === "speed") {
    return (p) =>
      v.speedLevel != null
        ? { speed: { ...p.speed, level: v.speedLevel } }
        : v.speedPercent != null
          ? { speed: { ...p.speed, percent: v.speedPercent } }
          : {};
  }
  if (v.action === "pauseAtLayer") return () => ({ pauseAtLayer: v.layer });
  return null;
}

export default function PrintersPage() {
  const qc = useQueryClient();
  const reduceMotion = usePrefersReducedMotion();
  // Komut YOLDAYKEN yoklama durur: iyimser durum (ör. "iptal edildi") 5 saniye sonra gelen
  // henüz-değişmemiş gerçekle EZİLİYOR, kart iki kez zıplıyordu (Moonraker iptali 65sn sürebilir).
  const [pendingMap, setPendingMap] = useState<PendingMap<ActionKind>>(NO_PENDING);
  const commandInFlight = anyPending(pendingMap);
  /** Bu mount'taki İLK çekim mi? Yalnız o istek sunucu önbelleğini atlar. */
  const ilkCekimRef = useRef(true);
  const { data, dataUpdatedAt, isLoading, refetch } = useQuery<PrintersResponse>({
    queryKey: ["printers"],
    // İlk çekimde `?fresh=1`: sunucudaki 4 saniyelik önbelleği ve çevrimdışı geri çekilmesini
    // atlar. Düzenli 5 saniyelik yoklama önbelleği kullanmaya devam eder — yazıcıları boşuna
    // yormamak için sadece MOUNT'ta taze isteniyor.
    queryFn: ({ signal }) =>
      fetchJson<PrintersResponse>(ilkCekimRef.current ? "/api/printers?fresh=1" : "/api/printers", { signal })
        .finally(() => { ilkCekimRef.current = false; }),
    /**
     * Aktif baskı varken daha SIK, boştayken daha SEYREK.
     *
     * Isınmış istek 6-32 ms (ölçüldü) — basarken 2 saniye ucuz ve tazelik doğrudan
     * hissediliyor. Boştaki yazıcıda gösterilecek bir değişiklik yok, 15 saniye yeter:
     * her tur yazıcıya sorgu, ürün eşleştirmesi ve panel işi demek.
     */
    refetchInterval: (q) => {
      if (commandInFlight) return false;
      const basan = (q.state.data?.printers ?? []).some((p) => p.status === "printing" || p.status === "paused");
      return basan ? 2000 : 15000;
    },
    staleTime: 0,
    // ⚠️ Uygulamanın GENEL ayarı `refetchOnMount: false` (ekranlar arası geçiş önbellekten
    // anında gelsin diye). Bu sayfa için YANLIŞ: sayfayı açtığında son önbellek gösteriliyor
    // ve ilk tazeleme ancak 5 saniyelik sayaç dolunca geliyordu — kullanıcı "ekranı açıyorum,
    // son açık haliyle görüyorum, 5 saniye sonra kendine geliyor" dedi. Yazıcı durumu
    // saniyesi saniyesine doğru olmalı: burada genel ayar bilerek geçersiz kılınıyor.
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });

  // Canlı geri sayım (now) saniyede bir güncellenir → tüm yazıcı kartları o sıklıkta render olur.
  // Yazıcılar ÇOĞU zaman boştadır; boştayken saniyelik tik = sürekli boşa arka-plan render (jank).
  // Bu yüzden tik YALNIZCA aktif iş varken çalışır. Boştayken now=0 (SSR ile de uyumlu, geri sayım yok).
  // (SSR/prerender ile ilk client render'ı now=0 kalarak eşleşir → hydration mismatch olmaz.)
  // Duraklatılmış baskı da "aktif": üstteki hatırlatma sayacı onunla ilerliyor.
  const anyActive = (data?.printers ?? []).some((p) => p.status === "printing" || p.status === "paused");
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyActive]);
  // Yeni baskı uzun bir boşluktan sonra başlarsa önceki baskıdan kalmış saati bir kare bile
  // kullanma; son veri zamanını alt sınır yap, 1 sn'lik sayaç oradan devam etsin.
  const clockNow = anyActive ? Math.max(now, dataUpdatedAt) : dataUpdatedAt;

  /**
   * BASKI BİTİNCE TIMELAPSE LİSTESİNİ TAZELE.
   *
   * Video listesi 5 dakikalık `staleTime` ile duruyor ve uygulamanın genel ayarı
   * `refetchOnMount: false` — yani bir kez çekildikten sonra onu yeniden çekecek HİÇBİR ŞEY
   * yoktu. Kullanıcı yeni videoyu ancak Hub'ı kapatıp açınca görüyordu (önbellek sıfırlanınca).
   *
   * ⚠️ Video baskı biter bitmez HAZIR OLMUYOR: yazıcı kareleri birleştirip dosyayı yazana
   * kadar birkaç saniye geçiyor. Tek seferlik tazeleme çoğu zaman boş dönerdi; bu yüzden
   * kısa aralıklarla birkaç kez deneniyor.
   */
  const oncekiDurum = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const liste = data?.printers ?? [];
    const zamanlayicilar: ReturnType<typeof setTimeout>[] = [];
    for (const p of liste) {
      const onceki = oncekiDurum.current.get(p.id);
      oncekiDurum.current.set(p.id, p.status);
      if (!baskiYeniBittiMi(onceki, p.status)) continue;
      // Şerit ekranda MONTELİ olduğu için `invalidateQueries` onu yeniden çeker
      // (pasif sorguda `removeQueries` gerekirdi — bkz. fiyat önbelleği dersi).
      const tazele = () => qc.invalidateQueries({ queryKey: ["timelapse", p.id] });
      tazele();
      for (const gecikme of [8_000, 30_000, 90_000]) zamanlayicilar.push(setTimeout(tazele, gecikme));
    }
    return () => { for (const z of zamanlayicilar) clearTimeout(z); };
  }, [data, qc]);

  const [manualRefresh, setManualRefresh] = useState(false); // "Yenile" butonunun kendi durumu (arka-plan poll'undan bağımsız)
  const retryNow = () => { setManualRefresh(true); refetch().finally(() => setManualRefresh(false)); };
  const [manageOpen, setManageOpen] = useState(false);
  const [matchTarget, setMatchTarget] = useState<{ id: string; filename: string } | null>(null);
  const [startTarget, setStartTarget] = useState<{ id: string; name: string; brand: string } | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);

  const printers = useMemo(() => data?.printers ?? [], [data]);
  const simulated = data?.simulated ?? false;
  const onlineCount = printers.filter((p) => p.online).length;
  const printingCount = printers.filter((p) => p.status === "printing").length;
  const idleCount = printers.filter((p) => p.online && p.status === "idle").length;

  // MADDE 18: duraklatmanın NE ZAMAN başladığı hiçbir uçtan gelmiyor → ilk görüldüğü an damgalanır.
  const [pausedStore] = useState(createPausedSinceStore);
  useEffect(() => { pausedStore.update(data?.printers ?? []); }, [data, pausedStore]);
  const pausedSince = useSyncExternalStore(pausedStore.subscribe, pausedStore.getSnapshot, () => EMPTY_PAUSED_SINCE);

  const action = useMutation<ActionResult, Error, ActionVars, { prev?: PrintersResponse }>({
    mutationFn: (v) =>
      fetchJson<ActionResult>(`/api/printers/${v.id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // ⚠️ `layer` AÇIKÇA null gönderilmeli (alan hiç yoksa sunucu 400 verir) → JSON.stringify
        // undefined alanları düşürür, null'ı korur. Bu yüzden payload olduğu gibi geçirilir.
        body: JSON.stringify(actionBody(v)),
      }),
    // OPTIMISTIC: kart durumu ANINDA yansır (eskiden 5sn poll'a kadar "Yazdırıyor" kalıyordu);
    // hata olursa eski durum geri gelir + zaten sonraki poll gerçeği getirir.
    onMutate: async (v) => {
      setPendingMap((m) => addPending(m, v.id, v.action));
      await qc.cancelQueries({ queryKey: ["printers"] });
      const prev = qc.getQueryData<PrintersResponse>(["printers"]);
      const patch = optimisticPatch(v);
      if (patch) {
        qc.setQueryData<PrintersResponse>(["printers"], (old) =>
          old ? { ...old, printers: old.printers.map((p) => (p.id === v.id ? { ...p, ...patch(p) } : p)) } : old,
        );
      }
      return { prev };
    },
    onSuccess: (res, v) => {
      toast.success(SUCCESS_LABEL[v.action]);
      // MADDE 6: sunucu komut sonrası kendi önbelleğini attı → paneli HEMEN tazele. Yazıcı durumu
      // birkaç saniye sonra oturabildiği için kısa bir doğrulama yoklaması daha yapılır.
      qc.invalidateQueries({ queryKey: ["printers"] });
      if (!res?.verified) setTimeout(() => qc.invalidateQueries({ queryKey: ["printers"] }), 1500);
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["printers"], ctx.prev);
      toast.error(e.message);
    },
    // Kilit YALNIZ komutu gönderilen yazıcıda ve YALNIZ o komut bitince açılır.
    onSettled: (_d, _e, v) => { setPendingMap((m) => removePending(m, v.id, v.action)); },
  });

  const cancelTarget = cancelId ? printers.find((p) => p.id === cancelId) ?? null : null;
  const nextFinish = nextFinishing(printers, clockNow);
  const troubles = troubleList(printers);
  const focusCard = (id: string) => {
    if (typeof document === "undefined") return;
    const card = document.getElementById(`printer-card-${id}`);
    if (!card) return;
    card.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
    // Kaydırmak yetmez: klavye/ekran okuyucu kullanan kişi nereye gittiğini duymalı.
    card.focus({ preventScroll: true });
  };

  // Bağlantı KOPARSA son bilinen işi göster (eskiden kart tüm iş bilgisini kaybediyordu —
  // baskı yazıcıda çoğunlukla devam eder, kısa ağ kesintisi işi "yok" göstermemeli).
  const [lastJobsStore] = useState(createLastJobsStore);
  useEffect(() => {
    lastJobsStore.update(data?.printers ?? []);
  }, [data, lastJobsStore]);
  const lastJobs = useSyncExternalStore(
    lastJobsStore.subscribe,
    lastJobsStore.getSnapshot,
    () => EMPTY_LAST_JOBS,
  );

  return (
    <div className="p-4 sm:p-6 space-y-5 mx-auto w-full max-w-[1600px]">
      {/* Dar pencerede düğmeler EKRAN DIŞINA taşmasın: hem satır hem düğme grubu sarar,
          böylece yazıcı eklemenin tek yolu olan “Yönet” her genişlikte görünür kalır. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
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
              : "Yazıcılarınızın canlı baskı durumu."}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 min-w-0">
          {/* Yalnız ELLE yenilemede döner/kilitler — eski isFetching her 5sn'lik arka-plan
              poll'unda butonu yanıp söndürüyordu. */}
          <Button variant="outline" size="sm" disabled={manualRefresh} onClick={retryNow} className="gap-2">
            <RefreshCw className={cn("h-4 w-4", manualRefresh && "animate-spin")} />
            Yenile
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCustomOpen(true)} className="gap-2" disabled={simulated || printers.length === 0}>
            <Upload className="h-4 w-4" /> Özel Baskı
          </Button>
          <Button variant="outline" size="sm" onClick={() => setLibraryOpen(true)} className="gap-2">
            <FolderOpen className="h-4 w-4" /> Özel Baskılar
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
          <SummaryChip icon={Loader2} label={`${printingCount} yazdırıyor`} spin={printingCount > 0} accent />
          <SummaryChip icon={Power} label={`${idleCount} hazır`} muted />
          {/* MADDE 18: hangi yazıcı önce boşalacak — dört kartı okumadan, geri sayarak. */}
          {nextFinish && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border font-medium bg-card border-border text-foreground/80 motion-safe:animate-in motion-safe:fade-in duration-300">
              <Hourglass className="h-3.5 w-3.5 text-primary" />
              Sıradaki bitiş
              <span className="tabular-nums font-semibold">
                {formatRemaining(nextFinish.remainingSec)}
              </span>
              <span className="text-muted-foreground truncate max-w-[9rem]">· {nextFinish.name}</span>
            </span>
          )}
          {/* Sorun varsa tıklanınca ilgili karta götürür. */}
          {troubles.map((t) => (
            <TroubleChip key={t.id} item={t} onClick={() => focusCard(t.id)} />
          ))}
        </div>
      )}

      {simulated && !isLoading && (
        <div className="rounded-lg border border-primary/25 bg-primary/[0.04] px-4 py-3 text-sm flex items-start gap-3">
          <Link2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Henüz gerçek yazıcı bağlı değil — bu kartlar örnektir.</p>
            <p className="text-muted-foreground text-xs mt-0.5">
              <strong>Yönet</strong> → yazıcını ekle. Eklediğin anda canlı duruma geçer.
            </p>
          </div>
        </div>
      )}

      {isLoading ? (
        // İskelet gerçek kart yüksekliğine yakın olmalı — 130 px kısa iskelet veri gelince
        // sayfayı zıplatıyordu.
        <div className="grid gap-4 grid-cols-1 xl:grid-cols-2 min-[1700px]:grid-cols-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[392px] w-full rounded-xl" />
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
        <div className="grid gap-4 grid-cols-1 xl:grid-cols-2 min-[1700px]:grid-cols-3">
          {printers.map((p, i) => (
            <PrinterCard
              key={p.id}
              printer={p}
              now={clockNow}
              index={i}
              pending={pendingFor(pendingMap, p.id)}
              pausedReminderText={pausedReminder(pausedSince[p.id] ?? null, clockNow)}
              lastKnownJob={!p.online ? lastJobs.get(p.id) : undefined}
              onCommand={(v) => action.mutate(v)}
              onCancel={() => setCancelId(p.id)}
              onStart={() => setStartTarget({ id: p.id, name: p.name, brand: p.brand })}
              onMatch={() => p.currentFilename && setMatchTarget({ id: p.id, filename: p.currentFilename })}
              onManage={() => setManageOpen(true)}
              onRetry={retryNow}
              retrying={manualRefresh}
            />
          ))}
        </div>
      )}

      {manageOpen && <ManageModal onClose={() => setManageOpen(false)} />}
      {matchTarget && <MatchModal target={matchTarget} onClose={() => setMatchTarget(null)} />}
      {startTarget && (
        <StartModal target={startTarget} onClose={() => setStartTarget(null)} />
      )}
      {customOpen && <CustomPrintModal printers={printers} onClose={() => setCustomOpen(false)} />}
      {libraryOpen && <CustomPrintLibrary printers={printers} onClose={() => setLibraryOpen(false)} />}

      {cancelTarget && (
        <CancelDialog
          printer={cancelTarget}
          nowMs={clockNow}
          busy={pendingFor(pendingMap, cancelTarget.id) != null}
          onClose={() => setCancelId(null)}
          onConfirm={() => { action.mutate({ id: cancelTarget.id, action: "cancel" }); setCancelId(null); }}
        />
      )}
    </div>
  );
}

/** MADDE 18 — “nerede sorun var” çipi; tıklayınca o karta götürür. */
function TroubleChip({ item, onClick }: { item: TroubleItem; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border font-medium transition-all hover:brightness-125 active:scale-[0.97] motion-safe:animate-in motion-safe:fade-in duration-300"
      style={{
        color: item.severe ? "var(--panel-red)" : "var(--panel-amber)",
        backgroundColor: item.severe ? "var(--panel-red-soft)" : "var(--panel-amber-soft)",
        borderColor: item.severe ? "var(--panel-red-line)" : "var(--panel-amber-line)",
      }}
      title="Karta git"
    >
      <AlertTriangle className="h-3.5 w-3.5" />
      <span className="truncate max-w-[10rem]">{item.name}</span>
      <span className="opacity-80">· {item.text}</span>
      <ArrowRight className="h-3 w-3 opacity-70" />
    </button>
  );
}

// ── MADDE 15: iptal onayı — neyin kaybedileceğini SÖYLE, yanlış tıklamayı KES ──

const HOLD_MS = 1400;

function CancelDialog({
  printer, nowMs, busy, onClose, onConfirm,
}: {
  printer: PanelPrinter; nowMs: number; busy: boolean; onClose: () => void; onConfirm: () => void;
}) {
  const reduceMotion = usePrefersReducedMotion();
  const job = printer.job;
  const s: CancelSummary = cancelSummary({ job, nowMs, paused: printer.status === "paused" });
  const images = jobImageCandidates(job);
  const [armed, setArmed] = useState(false); // reduced-motion yolu: ikinci onay
  // Pencere açıkken baskı bitebilir: boş bir kutuya dönüp yine de "iptal et" kabul etmesin.
  const gone = !job || !transportControls(printer).canCancel;

  return (
    // Kapatmak yıkıcı değil → HİÇBİR koşulda kilitlenmez (ESC ve dışa tıklama dahil).
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {gone
              ? <><CheckCircle2 className="h-4 w-4" style={{ color: "var(--status-done)" }} /> Baskı bitti</>
              : <><Ban className="h-4 w-4 text-destructive" /> Baskıyı iptal et?</>}
          </DialogTitle>
        </DialogHeader>

        <div className="flex gap-3.5">
          <div className="relative h-[104px] w-[104px] shrink-0 rounded-xl border overflow-hidden bg-muted/30">
            <FallbackImage
              candidates={images}
              alt=""
              className="absolute inset-0 h-full w-full object-contain p-1.5"
              fallback={<div className="absolute inset-0 flex items-center justify-center"><Box className="h-8 w-8 text-muted-foreground/30" /></div>}
            />
            {s.pct != null && (
              <span className="absolute inset-x-0 bottom-0 bg-background/80 px-1 py-0.5 text-center text-[10px] font-bold tabular-nums backdrop-blur-sm">
                %{s.pct}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-sm font-medium leading-snug line-clamp-2">{job?.productName || printer.name}</p>
            <p className="text-[11px] text-muted-foreground truncate">{printer.name}</p>
            {s.pct != null && (
              <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${s.pct}%`, background: "linear-gradient(90deg, var(--status-printing-soft), var(--status-printing))" }}
                />
              </div>
            )}
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
              {s.elapsedText && <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {s.elapsedText} geçti</span>}
              {s.gramsText && <span className="inline-flex items-center gap-1"><Weight className="h-3.5 w-3.5" /> {s.gramsText}</span>}
              {s.remainingText && <span className="inline-flex items-center gap-1"><Hourglass className="h-3.5 w-3.5" /> {s.remainingText} kaldı</span>}
            </div>
          </div>
        </div>

        {s.nearFinish && (
          <div
            className="flex items-start gap-2 rounded-lg border px-2.5 py-2 motion-safe:animate-in motion-safe:fade-in duration-300"
            style={{ borderColor: "var(--panel-amber-line)", backgroundColor: "var(--panel-amber-soft)" }}
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" style={{ color: "var(--panel-amber)" }} />
            <p className="text-[11px] leading-snug text-foreground/85">Baskı bitmek üzere — birkaç dakika beklemek yeterli olabilir.</p>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          {gone ? "Bu baskı artık sürmüyor — iptal edilecek bir şey yok." : "Durdurulan baskı geri alınamaz; harcanan filament çöpe gider."}
        </p>

        <DialogFooter className="gap-2">
          {/* Vazgeç ASLA kilitlenmez — kullanıcı ilgisiz bir komut bitene kadar pencerede tutulmaz. */}
          <Button variant="outline" onClick={onClose}>{gone ? "Kapat" : "Vazgeç"}</Button>
          {gone ? null : reduceMotion ? (
            // Hareket azaltılmışsa basılı tutma yerine ikinci bir onay.
            <Button variant="destructive" disabled={busy} onClick={() => (armed ? onConfirm() : setArmed(true))}>
              {armed ? "Evet, iptal et" : "Baskıyı iptal et"}
            </Button>
          ) : (
            <HoldToConfirm busy={busy} onConfirm={onConfirm} />
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Yanlış tıklamayı keser: düğme BASILI TUTULDUKÇA dolar, dolunca iptal eder. */
function HoldToConfirm({ busy, onConfirm }: { busy: boolean; onConfirm: () => void }) {
  const [holding, setHolding] = useState(false);
  // Kısa basış (özellikle klavyede Enter) sessizce hiçbir şey yapıyordu → kullanıcı bozuk sanıyordu.
  const [hint, setHint] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
      setHint(true);
      if (hintTimer.current) clearTimeout(hintTimer.current);
      hintTimer.current = setTimeout(() => setHint(false), 2500);
    }
    setHolding(false);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (hintTimer.current) clearTimeout(hintTimer.current);
  }, []);
  const start = () => {
    if (busy || timer.current) return;
    setHint(false);
    setHolding(true);
    timer.current = setTimeout(() => { timer.current = null; setHolding(false); onConfirm(); }, HOLD_MS);
  };

  const label = holding ? "Bırakma…" : hint ? "Basılı tutmalısın" : "Basılı tut, iptal olsun";
  return (
    <>
      {/* Ekran okuyucu da ne olduğunu duysun. */}
      <span role="status" aria-live="polite" className="sr-only">{holding ? "Basılı tutuluyor" : hint ? "Basılı tutmalısın" : ""}</span>
      <Button
        variant="destructive"
        disabled={busy}
        aria-describedby="hold-to-confirm-hint"
        className="relative overflow-hidden select-none touch-none"
        onPointerDown={start}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); start(); } }}
        onKeyUp={stop}
        onBlur={stop}
      >
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 bg-white/25"
          style={{ width: holding ? "100%" : "0%", transition: `width ${holding ? HOLD_MS : 180}ms linear` }}
        />
        <span className="relative z-10">{label}</span>
      </Button>
      <span id="hold-to-confirm-hint" className="sr-only">Düğmeyi bir buçuk saniye basılı tut.</span>
    </>
  );
}

/**
 * Görsel zinciri: aday düşerse SIRADAKİNE geçer (plaka görüntüsü yazıcının LAN adresinden,
 * mağaza fotoğrafı buluttan gelir — biri gitti diye kart boş kalmasın).
 */
function FallbackImage({
  candidates, alt, className, fallback,
}: { candidates: readonly string[]; alt: string; className?: string; fallback: React.ReactNode }) {
  const [failed, setFailed] = useState<readonly string[]>([]);
  const src = pickImage(candidates, failed);
  if (!src) return <>{fallback}</>;
  return (
    <img
      key={src}
      src={src}
      alt={alt}
      className={className}
      onError={() => setFailed((f) => (f.includes(src) ? f : [...f, src]))}
    />
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

/** Renk TEK sinyal olmasın — her durumun kendi ikonu var (renk körlüğü + hızlı tarama). */
const TONE_ICON: Record<StatusTone, React.ElementType> = {
  printing: Loader2,
  paused: Pause,
  finished: Sparkles,
  error: AlertTriangle,
  idle: Power,
  offline: WifiOff,
  unconfigured: Settings2,
  unsupported: Ban,
};

function StatusBadge({ visual, reduceMotion, override }: { visual: StatusVisual; reduceMotion: boolean; override?: string | null }) {
  // MADDE 6: komut yolda → rozet ARA durumda kalır, "oldu mu?" sorusu bırakmaz.
  const Icon = override ? Loader2 : TONE_ICON[visual.tone];
  // Komut yoldayken dönme "çalışıyor" bilgisinin tek kaynağı → hareket azaltmada da döner
  // (globals.css `.animate-spin` istisnası). Durum ikonunun dönmesi ise dekorasyon.
  const spin = override ? true : visual.tone === "printing" && !reduceMotion;
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold border shrink-0 whitespace-nowrap transition-colors"
      style={{ backgroundColor: visual.soft, color: visual.color, borderColor: visual.line }}
    >
      <Icon className={cn("h-3 w-3", spin && "animate-spin")} />
      {override ?? visual.label}
    </span>
  );
}

// Konfeti — yalnız "accent" prop'una bağlı; memo ile her saniyelik render'da 18 düğüm YENİDEN kurulmaz.
const Confetti = memo(function Confetti({ accent }: { accent: string }) {
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
});

/**
 * Kart memo'su: 5sn poll'da React Query yapısal paylaşımı değişmeyen yazıcı objesinin REFERANSINI
 * korur → içerik aynıysa kart hiç render olmaz (eskiden her poll TÜM grid'i yeniden çiziyordu).
 * Handler kimlikleri karşılaştırma DIŞI (her render'da taze arrow ama davranışları sabit);
 * `now` yalnız aktif işi olan kartta önemli — boştaki kartlar saniyelik tikten etkilenmez.
 */
const PrinterCard = memo(PrinterCardInner, (a, b) =>
  a.printer === b.printer &&
  a.pending === b.pending &&
  a.index === b.index &&
  a.retrying === b.retrying &&
  a.pausedReminderText === b.pausedReminderText &&
  a.lastKnownJob === b.lastKnownJob &&
  (!a.printer.job || a.now === b.now)
);

function PrinterCardInner({
  printer, now, index, pending, retrying, pausedReminderText, lastKnownJob,
  onCommand, onCancel, onStart, onMatch, onManage, onRetry,
}: {
  printer: PanelPrinter; now: number; index: number; pending: ActionKind | null; retrying: boolean;
  pausedReminderText: string | null; lastKnownJob?: PrinterJob;
  onCommand: (v: ActionVars) => void; onCancel: () => void; onStart: () => void; onMatch: () => void;
  onManage: () => void; onRetry: () => void;
}) {
  const { job, status, accent, online } = printer;
  const isReal = printer.type !== "sim";
  const reduceMotion = usePrefersReducedMotion();

  const isFinished = status === "finished";
  const isPrinting = status === "printing";
  const isPaused = status === "paused";

  // Gerçek snapshot değerleri (zaman-interpolasyonu DEĞİL). remainingSec endsAt'a
  // sabitlenmiş canlı geri sayım; progress/layer doğrudan yazıcıdan gelir.
  let progress = 0, remainingSec = 0, endMs = 0;
  let layerCurrent: number | null = null;
  if (job) {
    endMs = new Date(job.endsAt).getTime();
    progress = clamp(job.progress, 0, 1);
    // DURAKLATILMIŞTA canlı sayım YOK: printDuration donar ama endsAt her poll'da ileri kayar →
    // canlı sayım iner, poll'da geri zıplar (testere-dişi) ve tek başına paused'dayken tik hiç
    // çalışmadığından "0sn kaldı · 1970 saati" görünüyordu. Snapshot remainingSec statik gösterilir.
    // now=0 (ilk kare, tik henüz kurulmadı) durumunda da snapshot'a düş → sahte "Tamamlanıyor…" flaşı yok.
    remainingSec = isPaused || now <= 0 ? Math.max(0, job.remainingSec) : Math.max(0, (endMs - now) / 1000);
    layerCurrent = job.layerCurrent;
    if (isFinished) { progress = 1; remainingSec = 0; }
  }
  const pct = Math.round(progress * 100);
  // Isınma evresi: hedef var ama sıcaklık henüz uzak → "yazdırıyor ama %0 ve soğuk" kafa karışıklığını
  // "ısınıyor" rozetiyle açıkla.
  const heating =
    !isFinished && online &&
    ((printer.temps.nozzleTarget > 0 && printer.temps.nozzle < printer.temps.nozzleTarget - 3) ||
      (printer.temps.bedTarget > 0 && printer.temps.bed < printer.temps.bedTarget - 2));
  const elapsedSec = job && isPrinting ? Math.max(0, (now - new Date(job.startedAt).getTime()) / 1000) : 0;
  const notice = isReal ? connectionNotice(printer.connection, online, printer.note) : null;
  const offline = !!notice;
  const isError = status === "error" && !offline;

  // MADDE 2 — HAZIRLIK yalnız baskının GERÇEK başında. Snapmaker U1 her renk değişiminde kafayı
  // 70→220 ısıtıyor; eski kural yüzünden kart tek baskıda binlerce kez yüzdeyi/katmanı/kalan
  // süreyi gizleyip "Baskıya hazırlanıyor"a düşüyordu. Artık ilerleme/katman göründüyse bilgiler
  // KALIR, ısınma yalnız küçük bir çip olur.
  const stage = resolveStage({ status, heating, progress, layerCurrent });
  const preparing = stage.preparing;
  const remainingView = resolveRemaining({
    remainingSec,
    remainingKnown: job?.remainingKnown ?? false,
    nowMs: now,
    finished: isFinished,
    showClock: !isPaused && !preparing,
  });
  const finishingNow = isPrinting && remainingView.known && remainingSec <= 0.5;

  const sv = resolveStatusVisual(printer);
  const warnings = orderWarnings(printer.warnings);
  const slotChips = buildSlotChips(printer.slots, job?.activeSlots, {
    color: job?.filamentColor ?? "",
    type: job?.filamentType ?? "",
  });
  // Duraklama nedeni "Duraklatıldı"nın yanında; uzun cihaz metni kartı taşırmasın.
  const pauseReason = isPaused && printer.statusMessage ? printer.statusMessage.trim().slice(0, 46) : null;

  // CANLI DOLAN MODEL (çekme modeli): süren baskı hangi modele aitse (dosya adından çözülür,
  // yeniden yükleme GEREKMEZ), inşa kareleri o modelin kalıcı kimliğiyle aranır; yoksa arka planda
  // KİBARCA üretilir (bir sonraki poll'da görünür). Var olan modellerde ve süren baskılarda çalışır.
  const printingNow = (isPrinting || isPaused) && online;
  const live = useLiveBuildModel(printer.id, printer.currentFilename, printingNow);
  const buildFrames = live.frames;

  // MADDE 4: kare KATMAN oranından seçilir — kareler katman oranıyla üretiliyor, bayt ilerlemesi
  // aynı anda 23 puana kadar sapabiliyor (canlı ölçüm: bayt %90 / katman %66,5).
  const framePick = pickBuildFrame({
    frameCount: buildFrames?.length ?? 0,
    layerCurrent,
    layerTotal: job?.layerTotal ?? 0,
    progress,
  });

  // MADDE 7 — CANLI AŞAMA: o an basılan katmanın üstten görünümü + nozulun yeri.
  const bedFrame = bedFrameFor(printer.brand, printer.model);
  const vizPack = live.pack;
  const filePosition = job?.live.filePosition ?? null;
  const byteLayer = vizPack && filePosition != null
    ? vizPack.layerAt(vizPack.pack.layerByteOffset, filePosition)
    : null;
  const packLayerIndex = resolvePackLayerIndex({
    layerCurrent, byteLayer, layerCount: vizPack?.pack.layerZ.length ?? 0,
  });
  const intra = vizPack && packLayerIndex != null && filePosition != null
    ? intraLayerFraction(
        vizPack.pack.layerByteOffset[packLayerIndex] ?? null,
        vizPack.pack.layerByteOffset[packLayerIndex + 1] ?? vizPack.pack.fileSize,
        filePosition,
      )
    : null;
  const dot = nozzleDot(job?.live.nozzleX ?? null, job?.live.nozzleY ?? null, bedFrame);
  const showStage = printingNow && !!bedFrame && (!!dot || packLayerIndex != null);

  // ARKA PLAN BASKI: bu yazıcıya başlatılan yükleme/başlatma akışı (modal kapansa da sürer) →
  // kartta ilerleme/hata göster (kullanıcı ekranda kilitlenmez).
  const activePrint = useActivePrint(printer.id);

  // ── Kontroller (MADDE 6/10/16/17/22) ────────────────────────────────────
  const transport = transportControls(printer);
  const speedView = resolveSpeedView(printer);
  const layerRange = pauseLayerRange(job);
  const busy = pending != null;
  const badgeOverride = pendingBadgeLabel(
    pending === "pause" || pending === "resume" || pending === "cancel" ? pending : null,
  );
  const toolColors = useMemo(() => slotToolColors(printer.slots, printer.toolMap), [printer.slots, printer.toolMap]);

  // MADDE 11: süren baskının 3B görünümü karttan açılır (model dosyası varsa).
  // Açılışta model bilgisi KOPYALANIR: yazıcı bir yoklamada yanıt vermeyince dosya adı null
  // oluyordu → pencere kendiliğinden kapanıp (kamera açısı, katman, oynatma gider) bir sonraki
  // yoklamada kendiliğinden geri açılıyordu.
  const viewer = live.viewer;
  const [viewerSnap, setViewerSnap] = useState<{ fileId: string; cacheKey: string; name: string } | null>(null);
  const [partPicker, setPartPicker] = useState(false);
  const kartQc = useQueryClient();

  return (
    <Card
      id={`printer-card-${printer.id}`}
      // Üstteki sorun çipi buraya götürüyor; kaydırmanın yanında ODAK da taşınabilsin.
      tabIndex={-1}
      aria-label={printer.name}
      className={cn(
        "relative overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-primary/50 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 duration-500",
        offline && "opacity-80"
      )}
      style={{
        animationDelay: `${index * 80}ms`, animationFillMode: "both",
        // MADDE 5: çerçeve DURUM rengini taşır (kimlik rengi değil) — sağlıklı kart artık
        // arızalı karttan ilk bakışta ayrılıyor.
        borderColor: sv.emphasize ? sv.line : undefined,
        boxShadow: sv.emphasize ? `0 10px 32px -14px ${sv.soft}` : undefined,
      }}
    >
      {/* Kimlik rengi yalnız burada ve ikonda: ince üst çizgi (baskıda akar). */}
      <div className="absolute inset-x-0 top-0 h-[2px] overflow-hidden">
        {isPrinting && online && !reduceMotion
          ? <div className="h-full w-1/3" style={{ background: accent, animation: "indeterminate-bar 2.2s ease-in-out infinite", boxShadow: `0 0 8px ${accent}` }} />
          : <div className="h-full w-full" style={{ background: alpha(accent, offline ? 22 : 55) }} />}
      </div>
      {/* Konfeti yalnız YENİ biten baskıda (≤5dk) — eskiden finished kaldıkça saatlerce yağıyordu. */}
      {isFinished && online && !reduceMotion && endMs > 0 && now - endMs < 5 * 60_000 && <Confetti accent={accent} />}

      <CardContent className="p-4 space-y-3.5">
        {/* ARKA PLAN BASKI ilerlemesi/hatası — modal kapansa da kullanıcı süreci burada görür */}
        {activePrint && <ActivePrintBanner ap={activePrint} accent={accent} />}

        {/* Acil: baskı durdu / yazıcı hatası (nedeni hemen altındaki uyarı satırında) */}
        {isError && (
          <div className="flex items-center gap-2.5 rounded-lg border px-3 py-2"
            style={{ borderColor: "var(--status-error-line)", backgroundColor: "var(--status-error-soft)" }}>
            <AlertTriangle className="h-4 w-4 shrink-0 motion-safe:animate-pulse" style={{ color: "var(--status-error)" }} />
            <div className="min-w-0">
              <p className="text-xs font-bold leading-tight" style={{ color: "var(--status-error)" }}>Baskı durdu — yazıcıyı kontrol et</p>
              <p className="text-[11px] truncate text-foreground/70">
                {job?.productName || "Yazıcı ekranındaki uyarıya bak"}
              </p>
            </div>
          </div>
        )}

        {/* MADDE 14: yazıcının uyarıları (neden duraklattı, ne oldu) */}
        {warnings.length > 0 && !offline && (
          <div className="space-y-1">
            {warnings.map((w, i) => (
              <div
                key={`${w.code ?? "w"}-${i}`}
                className="flex items-start gap-2 rounded-lg border px-2.5 py-1.5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 duration-300"
                style={{
                  borderColor: w.severe ? "var(--panel-red-line)" : "var(--panel-amber-line)",
                  backgroundColor: w.severe ? "var(--panel-red-soft)" : "var(--panel-amber-soft)",
                  animationDelay: `${i * 60}ms`, animationFillMode: "both",
                }}
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" style={{ color: w.severe ? "var(--panel-red)" : "var(--panel-amber)" }} />
                <p className="text-[11px] leading-snug text-foreground/85">{w.text}</p>
              </div>
            ))}
          </div>
        )}

        {/* MADDE 18: uzun süredir duraklamış baskı unutulmasın */}
        {pausedReminderText && isPaused && !offline && (
          <div
            className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 motion-safe:animate-in motion-safe:fade-in duration-300"
            style={{ borderColor: "var(--panel-amber-line)", backgroundColor: "var(--panel-amber-soft)" }}
          >
            <Clock className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--panel-amber)" }} />
            <p className="text-[11px] leading-snug text-foreground/85">{pausedReminderText}</p>
          </div>
        )}

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
          <StatusBadge visual={sv} reduceMotion={reduceMotion} override={badgeOverride} />
        </div>

        {/* Gövde */}
        {notice ? (
          <div className="flex items-center gap-3.5 py-3">
            <div className="flex items-center justify-center h-20 w-20 shrink-0 rounded-xl border border-dashed bg-muted/30">
              {notice.action === "manage"
                ? <Settings2 className="h-7 w-7 text-muted-foreground/35" />
                : <WifiOff className="h-7 w-7 text-muted-foreground/35" />}
            </div>
            <div className="flex-1 min-w-0 text-sm">
              <p className="font-medium text-foreground/80">{notice.title}</p>
              {/* NEYİN eksik olduğu yazsın — "Yazıcı bilgileri eksik." dört karttan hangisinde
                  IP mi, access code mu, seri no mu gerektiğini söylemiyordu. */}
              <p className="text-xs text-muted-foreground mt-0.5">{notice.detail}</p>
              {/* Kısa ağ kesintisinde iş bilgisi kaybolmasın — baskı yazıcıda genelde sürüyor. */}
              {lastKnownJob && (
                <p className="text-[11px] mt-1.5 text-muted-foreground/80 truncate">
                  Son bilinen: <span className="font-medium text-foreground/70">{lastKnownJob.productName}</span> · %{Math.round(clamp(lastKnownJob.progress, 0, 1) * 100)}
                </p>
              )}
              {/* Desteklenmeyen yazıcıda tamamlanacak bir kurulum YOK → düğme de çizilmez. */}
              <div className="flex flex-wrap items-center gap-2 mt-2">
                {notice.action !== "none" && (
                  <Button
                    size="sm" variant="outline" className="h-7 gap-1.5 text-xs"
                    disabled={notice.action === "retry" && retrying}
                    onClick={notice.action === "manage" ? onManage : onRetry}
                  >
                    {notice.action === "manage"
                      ? <><Settings2 className="h-3.5 w-3.5" /> Yönet</>
                      : <><RefreshCw className={cn("h-3.5 w-3.5", retrying && "animate-spin")} /> Tekrar dene</>}
                  </Button>
                )}
                {/* "Ulaşılamadı" tek cümlesi üç ayrı durumu birden anlatıyordu; test hangisi
                    olduğunu söyler. Hiçbir şeyi değiştirmez, yalnız okur. */}
                {isReal && <ConnectionTestButton printerId={printer.id} />}
              </div>
            </div>
          </div>
        ) : job ? (
          <div className="flex gap-3.5">
            {/* MADDE 3 + 7: büyük gerçek plaka görseli, üstünde katman rozeti ve canlı aşama */}
            <JobVisual
              frames={buildFrames}
              frameIndex={framePick.index}
              plateSrc={job.plateThumbnail}
              ratio={framePick.ratio}
              images={jobImageCandidates(job, live.thumbnail)}
              productName={job.productName}
              accent={accent}
              badge={preparing ? null : layerBadgeText(layerCurrent, job.layerTotal)}
              reduceMotion={reduceMotion}
              stage={showStage && bedFrame ? { pack: live.pack, layerIndex: packLayerIndex, intra, dot, frame: bedFrame } : null}
              // MADDE 11: model dosyası varsa görsel tıklanabilir → 3B izleyici (yoksa ölü tık yok)
              onOpen3d={viewer ? () => setViewerSnap({ ...viewer, name: job.productName || printer.name }) : null}
            />
            <div className="flex-1 min-w-0 space-y-2">
              <p className="text-sm font-medium leading-snug line-clamp-2">{job.productName}</p>
              {/* MADDE 12: yüklü filamentler — bu baskıda kullanılanlar vurgulu */}
              <SlotStrip chips={slotChips} />
              <CardBadges printer={printer} speedView={speedView} />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
                {!preparing && isPrinting && elapsedSec > 0 && (
                  <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {formatRemaining(elapsedSec)} geçti</span>
                )}
                {/* Dilimleyicinin bildirdiği TOPLAM ağırlık — "şimdiye kadar harcanan" sanılmasın. */}
                {job.filamentGrams != null && job.filamentGrams > 0 && (
                  <span className="inline-flex items-center gap-1"><Weight className="h-3.5 w-3.5" /> toplam {Math.round(job.filamentGrams)} g</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <TempStrip temps={printer.temps} />
                {/* MADDE 2: ısınma artık bilgileri gizlemez — küçük bir çip */}
                {stage.heatingChip && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium motion-safe:animate-in motion-safe:fade-in duration-300" style={{ color: "var(--panel-amber)" }}>
                    <Flame className="h-3 w-3 motion-safe:animate-pulse" /> Isınıyor
                  </span>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3.5 py-2">
            <div className="flex items-center justify-center h-28 w-28 shrink-0 rounded-xl border border-dashed bg-muted/30">
              <Box className="h-9 w-9 text-muted-foreground/30" />
            </div>
            <div className="flex-1 min-w-0 text-sm text-muted-foreground">
              <p className="font-medium text-foreground/70">{isError ? "Hata" : "Hazır"}</p>
              <p className="text-xs mt-0.5">{isError ? "Yazıcıda bir sorun var." : "Baskı bekleniyor…"}</p>
              <SlotStrip chips={slotChips} className="mt-2" />
              <CardBadges printer={printer} speedView={speedView} className="mt-2" />
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                <TempStrip temps={printer.temps} />
              </div>
            </div>
          </div>
        )}

        {/* Progress — HAZIRLIKTA belirsiz bar + "hazırlanıyor" (çöp %/ETA gösterme); gerçek baskıda %/ETA */}
        {job && !offline && (
          <div className="space-y-1.5">
            <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted">
              {preparing ? (
                reduceMotion
                  ? <div className="absolute inset-y-0 left-0 h-full w-1/4 rounded-full" style={{ background: sv.color, opacity: 0.6 }} />
                  : <div className="absolute inset-y-0 h-full w-1/3 rounded-full" style={{ background: sv.color, animation: "indeterminate-bar 1.8s ease-in-out infinite" }} />
              ) : (
                <div
                  className="h-full rounded-full relative overflow-hidden transition-[width] duration-1000 ease-linear"
                  style={{
                    // Dolgu da DURUM rengini taşır — kimlik rengi kartın üst çizgisinde kalır.
                    width: `${pct}%`,
                    background: `linear-gradient(90deg, ${sv.soft}, ${sv.color})`,
                  }}
                >
                  {isPrinting && !reduceMotion && <div className="absolute inset-0" style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent)", animation: "printer-shimmer 1.6s linear infinite" }} />}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 text-xs tabular-nums">
              {preparing ? (
                <>
                  <span className="font-semibold text-sm inline-flex items-center gap-1.5" style={{ color: sv.color }}>
                    {/* MADDE 21(e): hareket azaltılmışsa dönme YOK. */}
                    <Loader2 className={"h-3.5 w-3.5 animate-spin"} /> Baskıya hazırlanıyor…
                  </span>
                  <span className="text-muted-foreground inline-flex items-center gap-1">
                    {heating ? <><Flame className="h-3.5 w-3.5" style={{ color: "var(--panel-amber)" }} /> ısınıyor</> : "yerleşiyor"}
                    {elapsedSec > 2 ? ` · ${formatRemaining(elapsedSec)}` : ""}
                  </span>
                </>
              ) : (
                <>
                  <span className="font-bold text-sm shrink-0" style={{ color: sv.color }}>
                    {isFinished ? "Tamamlandı 🎉" : <>%<AnimatedNumber value={pct} durationMs={800} /></>}
                  </span>
                  {/* MADDE 1: kalan süre bilinmiyorsa "—"; bitiş saati AYNI kalan süreden üretilir. */}
                  <span className="text-muted-foreground inline-flex items-center gap-1 min-w-0">
                    {isFinished ? (<><CheckCircle2 className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--status-done)" }} /> Baskı bitti</>)
                      : isPaused ? (
                        <>
                          <Pause className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--status-paused)" }} />
                          <span className="truncate">
                            Duraklatıldı{pauseReason ? ` · ${pauseReason}` : remainingView.known ? ` · ${remainingView.text} kaldı` : ""}
                          </span>
                        </>
                      )
                        : finishingNow ? (<><Loader2 className={"h-3.5 w-3.5 shrink-0 animate-spin"} /> Tamamlanıyor…</>)
                          : (
                            <>
                              <Clock className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">
                                {remainingView.known ? `${remainingView.text} kaldı` : "kalan süre —"}
                                {remainingView.clock ? ` · ~${remainingView.clock}` : ""}
                              </span>
                            </>
                          )}
                  </span>
                </>
              )}
            </div>
          </div>
        )}

        {/* Kontroller — sadece gerçek + çevrimiçi yazıcılarda */}
        {isReal && online && (
          <div className="pt-2 mt-1 border-t border-border/50 space-y-2">
            {/* Birincil eylemler */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {/* MADDE 6: duraklamışken düğme "Devam et" der; uygun olmayan yön ETKİSİZ. */}
              {(isPrinting || isPaused) && (
                <Button
                  size="sm" variant="outline" className="h-7 gap-1 text-xs min-w-[6.5rem]"
                  disabled={busy || !(transport.canPause || transport.canResume)}
                  onClick={() => onCommand({ id: printer.id, action: transport.canResume ? "resume" : "pause" })}
                  title={transport.canResume ? "Baskıya devam et" : "Baskıyı duraklat"}
                >
                  {pending === "pause" || pending === "resume" ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {PENDING_LABEL[pending]}</>
                  ) : transport.canResume ? (
                    <><Play className="h-3.5 w-3.5" /> Devam et</>
                  ) : (
                    <><Pause className="h-3.5 w-3.5" /> Duraklat</>
                  )}
                </Button>
              )}
              {transport.canStart && (
                <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={busy} onClick={onStart}>
                  <Play className="h-3.5 w-3.5" /> Baskı Başlat
                </Button>
              )}

              {/* MADDE 10 — hız: serbest sayı girişi YOK, yalnız komşu kademeler */}
              {speedView && (
                <SpeedControl
                  view={speedView}
                  busy={busy}
                  pending={pending === "speed"}
                  onPick={(v) =>
                    onCommand(
                      speedView.kind === "level"
                        ? { id: printer.id, action: "speed", speedLevel: v }
                        : { id: printer.id, action: "speed", speedPercent: v },
                    )
                  }
                />
              )}

              {/* MADDE 16 — ışık */}
              {printer.caps.light && (
                <LightControl
                  light={printer.light}
                  busy={busy}
                  pending={pending === "light"}
                  accent={accent}
                  onToggle={(next) => onCommand({ id: printer.id, action: "light", light: next })}
                />
              )}

              {/* KAMERA — yalnız gerçekten kamerası olan yazıcıda çizilir. */}
              <CameraButton printerId={printer.id} printerName={printer.name} />

              {/* MADDE 17 — katmanda duraklat.
                  Kurulu duraklatma yazıcıda BASKIDAN BAĞIMSIZ kalıcı: baskı bitse de, katman
                  toplamı okunamasa da KALDIRILABİLMELİ (yoksa sonraki baskı yarıda duruyordu). */}
              {printer.caps.pauseAtLayer && (isPrinting || isPaused || printer.pauseAtLayer != null) && (
                <PauseAtLayerControl
                  range={layerRange}
                  current={printer.pauseAtLayer}
                  busy={busy}
                  pending={pending === "pauseAtLayer"}
                  onSet={(layer) => onCommand({ id: printer.id, action: "pauseAtLayer", layer })}
                />
              )}

              {/* PARÇA İPTALİ — baskı sürerken HER ZAMAN görünür; kullanılamıyorsa sönük
                  ve nedenini söyler. Eskiden hiç çizilmiyordu ve özellik "sadece bir
                  yazıcıda var" gibi görünüyordu; oysa üç Moonraker yazıcının üçü de
                  destekliyor, eksik olan dilimleyicinin nesne etiketi. */}
              {(isPrinting || isPaused) && bedFrame && (() => {
                const pd = parcaIptalDurumu({
                  tip: printer.type,
                  basiyor: isPrinting || isPaused,
                  parcaVar: !!printer.parts,
                });
                return (
                  <Button
                    size="sm" variant="outline" className="h-7 gap-1 text-xs"
                    disabled={busy || !pd.acik}
                    title={pd.ipucu}
                    onClick={() => pd.acik && setPartPicker(true)}
                  >
                    <Scissors className="h-3.5 w-3.5" /> Parça seç
                  </Button>
                );
              })()}
            </div>

            {/* İkincil satır — yıkıcı eylem AYRI ve sağda, yanlış tıklama uzağında */}
            {((job && !printer.matchedProductId) || transport.canCancel) && (
              <div className="flex items-center gap-2">
                {/* Eşleştirme düğmesi YALNIZ eşleşme yokken. Eşleşen baskıda "Ürünü değiştir"
                    hiç kullanılmıyordu; eşleştirme akışının kendisi (onMatch) yerinde duruyor. */}
                {job && !printer.matchedProductId && (
                  <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={onMatch} title="Bu baskı hangi ürüne ait?">
                    <Link2 className="h-3.5 w-3.5" />
                    Ürünle eşleştir
                  </Button>
                )}
                {transport.canCancel && (
                  <div className="ml-auto pl-3 border-l border-border/50">
                    <Button
                      size="sm" variant="ghost"
                      className="h-7 gap-1 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                      disabled={busy} onClick={onCancel}
                    >
                      {pending === "cancel"
                        ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {PENDING_LABEL.cancel}</>
                        : <><Ban className="h-3.5 w-3.5" /> Baskıyı iptal et</>}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Yazıcı yerel depolaması: doluluk barı + temizleme (tıkla → dosya listesi) */}
        {isReal && online && <PrinterStorageStrip printerId={printer.id} accent={accent} activeFile={printer.currentFilename} />}
      </CardContent>

      {partPicker && printer.parts && bedFrame && (
        <PartCancelDialog
          printerId={printer.id}
          frame={bedFrame}
          currentName={printer.parts.current}
          excluded={printer.parts.excluded}
          onClose={() => setPartPicker(false)}
          fetchParts={async () => {
            const r = await fetch(`/api/printers/${printer.id}/parts`);
            if (!r.ok) throw new Error("Parça listesi alınamadı.");
            return (await r.json()).parts ?? [];
          }}
          onExclude={async (name: string) => {
            const r = await fetch(`/api/printers/${printer.id}/action`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "excludeObject", objectName: name }),
            });
            if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Parça iptal edilemedi.");
            kartQc.invalidateQueries({ queryKey: ["printers"] });
          }}
          onUndo={async (name: string) => {
            const r = await fetch(`/api/printers/${printer.id}/action`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "unexcludeObject", objectName: name }),
            });
            if (!r.ok) throw new Error("Geri alınamadı.");
            kartQc.invalidateQueries({ queryKey: ["printers"] });
          }}
        />
      )}

      {viewerSnap && (
        <GcodeViewerDialog
          fileId={viewerSnap.fileId}
          cacheKey={viewerSnap.cacheKey}
          name={viewerSnap.name}
          liveLayer={layerCurrent}
          toolColors={toolColors}
          onClose={() => setViewerSnap(null)}
        />
      )}
    </Card>
  );
}

// ── Kart rozetleri: hız / katman duraklatması / gözetim ────────────────────

function CardBadges({ printer, speedView, className }: { printer: PanelPrinter; speedView: SpeedView | null; className?: string }) {
  const items: { key: string; icon: React.ElementType; text: string }[] = [];
  // Hız rozeti YALNIZ varsayılan dışındayken: Moonraker hızı boştayken de bildirdiği için
  // "Hız %100" dört kartta da hiç değişmeden durup gerçek rozetleri bastırıyordu.
  // Etiket artık bir sözcük ("Çok hızlı"); başına "Hız" eklemek "Hız Çok hızlı" oluyordu.
  // Ham yüzde durumunda ("%137") sözcük olmadığı için "Hız" öneki korunur.
  if (speedView && !speedView.atDefault) {
    const t = speedView.label;
    items.push({ key: "speed", icon: Gauge, text: t.startsWith("%") ? `Hız ${t}` : t });
  }
  if (printer.pauseAtLayer != null) items.push({ key: "layer", icon: Layers, text: `${printer.pauseAtLayer}. katmanda duracak` });
  // MADDE 22 — yalnız Snapmaker U1
  if (printer.defectWatch?.enabled) items.push({ key: "watch", icon: Eye, text: "Gözetim açık" });
  if (items.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {items.map((it) => (
        <span
          key={it.key}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] font-semibold text-foreground/75 tabular-nums motion-safe:animate-in motion-safe:fade-in duration-300"
        >
          <it.icon className="h-3 w-3 text-muted-foreground" />
          {it.text}
        </span>
      ))}
    </div>
  );
}

// ── Bağlantı testi ─────────────────────────────────────────────────────────
//
// "Yazıcıya ulaşılamadı" tek cümlesi üç ayrı durumu birden anlatıyordu: kutu ağda yok /
// kutu var ama yazılımı yanıt vermiyor / ikisi de çalışıyor ama isteğimiz düşüyor. Üçünün
// çaresi farklı. Test katman katman ilerler ve nerede koptuğunu gösterir.

interface TestAsamasi {
  ad: string;
  durum: "ok" | "hata" | "atlandi";
  sureMs: number;
  aciklama: string;
}
interface TestSonucu {
  asamalar: TestAsamasi[];
  sonuc: "calisiyor" | "yazilim-durmus" | "agda-yok" | "kismi";
  baslik: string;
  oneri: string;
}

function ConnectionTestButton({ printerId }: { printerId: string }) {
  const [acik, setAcik] = useState(false);
  const [sonuc, setSonuc] = useState<TestSonucu | null>(null);
  const [calisiyor, setCalisiyor] = useState(false);

  const testEt = async () => {
    setCalisiyor(true);
    setSonuc(null);
    setAcik(true);
    try {
      const r = await fetch(`/api/printers/${printerId}/diagnose`, { method: "POST" });
      setSonuc(await r.json());
    } catch {
      setSonuc({
        asamalar: [],
        sonuc: "agda-yok",
        baslik: "Test yapılamadı",
        oneri: "Uygulama yanıt vermedi.",
      });
    } finally {
      setCalisiyor(false);
    }
  };

  const renk =
    sonuc?.sonuc === "calisiyor"
      ? "var(--panel-green, oklch(0.72 0.16 155))"
      : sonuc?.sonuc === "yazilim-durmus"
        ? "var(--panel-amber)"
        : "oklch(0.65 0.2 25)";

  return (
    <>
      <Button
        size="sm" variant="outline" className="h-7 gap-1.5 text-xs"
        disabled={calisiyor}
        onClick={testEt}
      >
        {calisiyor
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : <Activity className="h-3.5 w-3.5" />}
        Bağlantıyı test et
      </Button>

      <Dialog open={acik} onOpenChange={(o) => !o && setAcik(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">Bağlantı testi</DialogTitle>
          </DialogHeader>

          {calisiyor && (
            <div className="py-6 text-center">
              <Loader2 className="h-5 w-5 mx-auto animate-spin text-muted-foreground" />
              <p className="text-xs text-muted-foreground mt-2">Yazıcı deneniyor…</p>
            </div>
          )}

          {sonuc && !calisiyor && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                {sonuc.asamalar.map((a, i) => (
                  <div
                    key={a.ad}
                    className="flex items-center gap-2 text-sm motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-left-1"
                    style={{ animationDelay: `${i * 70}ms`, animationFillMode: "backwards" }}
                  >
                    {a.durum === "ok"
                      ? <Check className="h-4 w-4 shrink-0" style={{ color: "var(--panel-green, oklch(0.72 0.16 155))" }} />
                      : <X className="h-4 w-4 shrink-0 text-destructive" />}
                    <span className="flex-1 min-w-0 truncate">{a.ad}</span>
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                      {a.aciklama} · {a.sureMs}ms
                    </span>
                  </div>
                ))}
              </div>

              <div
                className="rounded-lg border p-2.5"
                style={{ borderColor: `color-mix(in oklch, ${renk} 35%, var(--border))` }}
              >
                <p className="text-sm font-medium" style={{ color: renk }}>{sonuc.baslik}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{sonuc.oneri}</p>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setAcik(false)}>Kapat</Button>
            <Button size="sm" disabled={calisiyor} onClick={testEt}>Yeniden test et</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Sıcaklık çipleri — nozul VE tabla aynı dilde ───────────────────────────
//
// Eskiden nozul ikonlu/renkliydi, tabla düz griydi; tablanın hedefe ulaşıp ulaşmadığı
// tek bakışta görünmüyordu. Artık ikisi de aynı çip: ikon + değer + hedef, renk duruma göre.
// Snapmaker U1'de dört kafanın hepsi ayrı çip olarak dizilir (aktif olan vurgulu).

/** Sıcaklığın DURUMU — renk buradan gelir. */
type TempPhase = "cold" | "heating" | "ready" | "cooling";

function tempPhase(temp: number, target: number): TempPhase {
  if (target > 0) return temp < target - 3 ? "heating" : "ready";
  return temp > 45 ? "cooling" : "cold";
}

const PHASE_COLOR: Record<TempPhase, string | undefined> = {
  heating: "var(--panel-amber)",
  ready: "oklch(0.65 0.2 35)",
  cooling: "oklch(0.62 0.09 40)",
  cold: undefined,
};

function TempChip({
  icon: Icon, label, temp, target, dim, active, title,
}: {
  icon: React.ElementType;
  label?: string;
  temp: number;
  target: number;
  dim?: boolean;
  /** Şu an basan kafa — halkayla işaretlenir (U1'de iki kafa aynı anda sıcak olabiliyor). */
  active?: boolean;
  title?: string;
}) {
  const phase = tempPhase(temp, target);
  const color = PHASE_COLOR[phase];
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-1.5 py-0.5",
        "text-[11px] font-medium tabular-nums transition-all duration-500",
        "motion-safe:animate-in motion-safe:fade-in",
        dim && "opacity-55",
        active && "ring-1 ring-current/45 font-semibold",
      )}
      style={color ? { color, borderColor: `color-mix(in oklch, ${color} 35%, var(--border))` } : undefined}
    >
      <Icon className={cn("h-3.5 w-3.5 shrink-0", phase === "heating" && "motion-safe:animate-pulse")} />
      {label && <span className="text-muted-foreground/80">{label}</span>}
      <AnimatedNumber value={temp} durationMs={500} />°
      {target > 0 && <span className="opacity-55">/ {target}</span>}
    </span>
  );
}

/** Kartın sıcaklık şeridi: kafa(lar) + tabla. */
function TempStrip({ temps }: { temps: PanelPrinter["temps"] }) {
  const heads = temps.nozzles ?? [];
  return (
    <>
      {heads.length > 1 ? (
        heads.map((n) => (
          <TempChip
            key={n.index}
            icon={Flame}
            label={`K${n.index + 1}`}
            temp={n.temp}
            target={n.target}
            dim={!n.active && n.target === 0 && n.temp <= 45}
            active={n.active}
            title={n.active ? `Kafa ${n.index + 1} — şu an basıyor` : `Kafa ${n.index + 1}`}
          />
        ))
      ) : (
        <TempChip icon={Flame} temp={temps.nozzle} target={temps.nozzleTarget} title="Nozul" />
      )}
      <TempChip icon={RectangleHorizontal} label="Tabla" temp={temps.bed} target={temps.bedTarget} title="Tabla" />
    </>
  );
}

// ── MADDE 10 — hız kademesi ────────────────────────────────────────────────

function SpeedControl({
  view, busy, pending, onPick,
}: { view: SpeedView; busy: boolean; pending: boolean; onPick: (value: number) => void }) {
  return (
    <div
      className="inline-flex items-center h-7 rounded-md border border-input overflow-hidden"
      title={view.hint ? `Baskı hızı · ${view.hint}` : "Baskı hızı"}
    >
      <button
        className="h-full px-1.5 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-35 disabled:hover:bg-transparent transition-colors"
        disabled={busy || view.down == null}
        onClick={() => view.down != null && onPick(view.down)}
        aria-label="Hızı düşür"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      {/* Beklerken de DEĞER görünür kalır: eskiden etiket tamamen dönen ikonla değişiyordu ve
          hareket azaltma açıkken ortada hareketsiz bir daireden başka bir şey kalmıyordu.
          Genişlik "Çok yavaş"a göre sabit — kademe değişince +/− düğmeleri yerinden oynamasın. */}
      <span className="px-1.5 text-xs font-semibold tabular-nums inline-flex items-center gap-1 min-w-[6rem] justify-center whitespace-nowrap">
        {pending
          ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          : <Gauge className="h-3.5 w-3.5 text-muted-foreground" />}
        {view.label}
      </span>
      <button
        className="h-full px-1.5 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-35 disabled:hover:bg-transparent transition-colors"
        disabled={busy || view.up == null}
        onClick={() => view.up != null && onPick(view.up)}
        aria-label="Hızı artır"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ── MADDE 16 — ışık ────────────────────────────────────────────────────────

function LightControl({
  light, busy, pending, accent, onToggle,
}: {
  light: PanelPrinter["light"]; busy: boolean; pending: boolean; accent: string;
  onToggle: (next: boolean | "toggle") => void;
}) {
  // Durumu okunamayan modelde (Neptune 4 Plus) açık/kapalı GÖSTERGESİ ÇİZİLMEZ — tek "değiştir".
  const on = light.readable ? light.on === true : null;
  return (
    <Button
      size="sm" variant="outline" className="h-7 gap-1 text-xs"
      disabled={busy}
      onClick={() => onToggle(light.readable ? !on : "toggle")}
      title={light.readable ? (on ? "Işığı kapat" : "Işığı aç") : "Işığı değiştir"}
    >
      {pending
        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
        : <Lightbulb className="h-3.5 w-3.5 transition-colors" style={on ? { color: accent } : undefined} />}
      {light.readable ? (on ? "Işık açık" : "Işık kapalı") : "Işığı değiştir"}
    </Button>
  );
}

// ── KAMERA ─────────────────────────────────────────────────────────────────

/**
 * Kamera düğmesi + canlı pencere.
 *
 * Düğme YALNIZ kamerası olan yazıcıda çizilir: Bambu'da erişim kodu varsa, Moonraker'da ise
 * yazıcıya sorulup öğrenilir (U1'de kamera servisi baskı yokken kapalı olabiliyor — o zaman
 * düğme hiç görünmez, tıklayıp boş pencere açmaktansa hiç göstermemek dürüst olanı).
 *
 * Ağır pencere dinamik yükleniyor: kamera açılmadıkça hiçbir maliyeti yok.
 */
const CameraDialog = dynamic(
  () => import("@/components/printers/CameraDialog").then((m) => m.CameraDialog),
  { ssr: false },
);

function CameraButton({ printerId, printerName }: { printerId: string; printerName: string }) {
  const [acik, setAcik] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["camera-var", printerId],
    queryFn: () => fetchJson<{ var: boolean; neden?: string | null }>(`/api/printers/${printerId}/camera?bilgi=1`),
    // Kamera var/yok bilgisi sık değişmez; yazıcıyı boşuna yormayalım.
    staleTime: 5 * 60_000,
    retry: false,
  });

  /**
   * Düğme HER ZAMAN çizilir; kamera yoksa sönük durur ve üzerine gelince nedenini söyler.
   * (Kullanıcının isteği: "kamera butonu hep olmalı, baskı yokken inaktif olabilir.")
   * Yeri sabit kaldığı için kartlar arası geçişte düğmeler de zıplamıyor.
   */
  const kullanilabilir = data?.var === true;
  return (
    <>
      <Button
        size="sm" variant="outline" className="h-7 gap-1 text-xs"
        disabled={!kullanilabilir}
        onClick={() => setAcik(true)}
        title={kullanilabilir ? "Canlı kamera" : (data?.neden || "Kamera kontrol ediliyor…")}
      >
        {isLoading
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : <Camera className="h-3.5 w-3.5" />}
        Kamera
      </Button>
      {acik && (
        <CameraDialog printerId={printerId} printerName={printerName} onClose={() => setAcik(false)} />
      )}
    </>
  );
}

// ── MADDE 17 — katmanda duraklat ───────────────────────────────────────────

function PauseAtLayerControl({
  range, current, busy, pending, onSet,
}: {
  range: LayerRange | null;
  current: number | null; busy: boolean; pending: boolean; onSet: (layer: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(range?.suggested ?? 1);
  const openPicker = () => { setValue(range?.suggested ?? 1); setOpen(true); };
  // Seçici açıkken baskı ilerliyor (`range.min` büyüyor). Değer render sırasında kırpılır ki
  // ekrandaki sayı ile kaydırıcının topuzu ayrılmasın ve sunucunun reddedeceği değer gönderilmesin.
  const safe = range ? clampLayerValue(value, range) : value;
  // Kurulu duraklatmayı KALDIRMAK katman aralığı gerektirmez.
  const canOpen = !!range || current != null;

  return (
    <>
      <Button
        size="sm" variant="outline" className="h-7 gap-1 text-xs"
        disabled={busy || !canOpen} onClick={openPicker}
        title={range ? "Seçilen katmanda duraklat" : current != null ? "Kurulu duraklatmayı kaldır" : "Katman bilgisi yok"}
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Layers className="h-3.5 w-3.5" />}
        {current != null ? `${current}. katmanda dur` : "Katmanda duraklat"}
      </Button>

      {open && canOpen && (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                <Layers className="h-4 w-4 text-primary" /> Katmanda duraklat
              </DialogTitle>
            </DialogHeader>
            {range ? (
              <>
                <p className="text-xs text-muted-foreground">Baskı seçtiğin katmana gelince duracak.</p>
                <div className="flex items-baseline justify-center gap-1 py-1">
                  <span className="text-3xl font-bold tabular-nums">
                    <AnimatedNumber value={safe} durationMs={220} />
                  </span>
                  <span className="text-sm text-muted-foreground tabular-nums">/ {range.max}</span>
                </div>
                <input
                  type="range"
                  min={range.min}
                  max={range.max}
                  value={safe}
                  onChange={(e) => setValue(Number(e.target.value))}
                  className="w-full accent-[var(--panel-primary)]"
                />
                <div className="flex flex-wrap gap-1.5">
                  {/* GERÇEKTEN ekler (eskiden aralığın başına atıp değeri düşürüyordu). */}
                  {[5, 25, 100].map((step) => {
                    const target = layerStepTarget(safe, step, range);
                    return (
                      <Button
                        key={step} size="sm" variant="outline" className="h-7 text-xs"
                        disabled={target === safe}
                        onClick={() => setValue(target)}
                      >
                        +{step}
                      </Button>
                    );
                  })}
                  <Button
                    size="sm" variant="outline" className="h-7 text-xs"
                    disabled={safe === range.max}
                    onClick={() => setValue(range.max)}
                  >
                    Son katman
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Bu baskıda katman sayısı okunamıyor — kurulu duraklatmayı kaldırabilirsin.
              </p>
            )}
            <DialogFooter className="gap-2">
              {current != null && (
                // ⚠️ Kaldırmak için AÇIKÇA null gönderilir — alan hiç gönderilmezse sunucu reddeder.
                <Button variant="ghost" size="sm" className="mr-auto" disabled={busy} onClick={() => { onSet(null); setOpen(false); }}>
                  Duraklatmayı kaldır
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setOpen(false)}>Vazgeç</Button>
              {range && (
                <Button size="sm" disabled={busy} onClick={() => { onSet(safe); setOpen(false); }}>Kur</Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

// ── Arka plan baskı: kartta yükleme/başlatma ilerlemesi + hata ──────────────
/** ["active-print", printerId] cache slot'unu REAKTİF oku (fetch YOK; startBackgroundPrint besler). */
function useActivePrint(printerId: string): ActivePrint | null {
  const { data } = useQuery<ActivePrint | null>({
    queryKey: activePrintKey(printerId),
    queryFn: () => null, // asla çağrılmaz (enabled:false); yalnız setQueryData ile güncellenir
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? null;
}

const AP_STAGE_LABEL: Record<string, string> = {
  download: "Buluttan indiriliyor",
  status: "Hazırlanıyor",
  upload: "Yazıcıya yükleniyor",
  start: "Başlatılıyor",
  confirm: "Yazıcı onaylıyor",
};

function ActivePrintBanner({ ap, accent }: { ap: ActivePrint; accent: string }) {
  const isErr = ap.stage === "error";
  const pct = typeof ap.pct === "number" ? Math.max(0, Math.min(100, Math.round(ap.pct))) : null;
  // MADDE 21(e): bu bantta dönen ikon ve belirsiz bar hareket ayarını hiç dinlemiyordu.
  const reduceMotion = usePrefersReducedMotion();
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 space-y-1.5 motion-safe:animate-in motion-safe:fade-in",
        isErr ? "border-destructive/45 bg-destructive/10" : "border-primary/30 bg-primary/[0.06]"
      )}
    >
      <div className="flex items-center gap-2 text-xs">
        {isErr ? <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />
          : <Loader2 className={"h-3.5 w-3.5 shrink-0 animate-spin"} style={{ color: accent }} />}
        <span className={cn("font-semibold truncate", isErr && "text-destructive")}>{ap.label}</span>
        <span className="ml-auto tabular-nums shrink-0" style={{ color: isErr ? undefined : accent }}>
          {isErr ? "başlatılamadı" : pct != null ? `${pct}%` : (AP_STAGE_LABEL[ap.stage] ?? "…")}
        </span>
      </div>
      {isErr ? (
        <>
          <p className="text-[11px] text-destructive/80 leading-snug">Baskı başlatılamadı — tekrar dene.</p>
          {ap.message && (
            <details className="group">
              <summary className="cursor-pointer select-none text-[10px] text-destructive/60 hover:text-destructive transition-colors">
                Ayrıntı
              </summary>
              <p className="mt-0.5 text-[10px] text-destructive/70 break-words">{ap.message}</p>
            </details>
          )}
        </>
      ) : (
        <>
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
            {pct != null ? (
              <div className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300" style={{ width: `${pct}%`, background: accent }} />
            ) : reduceMotion ? (
              <div className="absolute inset-y-0 left-0 h-full w-1/4 rounded-full" style={{ background: accent, opacity: 0.6 }} />
            ) : (
              <div className="absolute inset-y-0 h-full w-1/3 rounded-full" style={{ background: accent, animation: "indeterminate-bar 1.6s ease-in-out infinite" }} />
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">{AP_STAGE_LABEL[ap.stage] ?? "İşleniyor"}… · bu arada başka işine bakabilirsin</p>
        </>
      )}
    </div>
  );
}

// ── Canlı dolan model: baskı kartında modelin katman katman inşası ──────────
interface PrintModelInfo {
  id: string;
  contentMd5: string | null;
  sizeBytes: number | null;
  /** Görselin KENDİSİ değil, var olup olmadığı — 285 KB'lık data-URL her yoklamada taşınıyordu. */
  thumbnailVar?: boolean;
}

/** Canlı aşama çizimi için gereken paket + yardımcıları (görselleştirme modülü DİNAMİK yüklenir). */
interface LivePack {
  pack: VizPack;
  layerAt: (offsets: ArrayLike<number>, filePosition: number) => number;
  isBody: (feature: number) => boolean;
}

/**
 * Süren baskının modelini çöz → inşa karelerini kalıcı kimlikle bul; yoksa arka planda üret.
 * Yeniden yükleme gerekmez; var olan modellerde ve halihazırda süren baskılarda da çalışır.
 * Kareler oluşana dek null döner (kart mevcut ürün görseline düşer).
 */
function useLiveBuildModel(
  printerId: string, filename: string | null, printing: boolean,
): {
  frames: string[] | null;
  thumbnail: string | null;
  pack: LivePack | null;
  /** 3B izleyicinin ihtiyacı — model çözülmediyse null (kart tıklanamaz kalır). */
  viewer: { fileId: string; cacheKey: string } | null;
} {
  // 1) Baskı → model kaydı (dosya adından, hash-eki/uzantı toleranslı). Uzun cache: aynı iş boyu sabit.
  const modelQ = useQuery<{ model: PrintModelInfo | null }>({
    queryKey: ["print-model", printerId, filename],
    queryFn: () => fetch(`/api/printers/${printerId}/print-model?filename=${encodeURIComponent(filename || "")}`).then((r) => r.json()),
    enabled: printing && !!filename,
    staleTime: 10 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const model = modelQ.data?.model ?? null;
  const vizKey = model ? vizKeyForModel(model) : null;
  const frameSourceKey = model && vizKey ? `${model.id}|${vizKey}` : null;

  const [loadedFrames, setLoadedFrames] = useState<{ key: string; urls: string[] } | null>(null);
  const urls = loadedFrames?.key === frameSourceKey ? loadedFrames.urls : null;
  useEffect(() => {
    let alive = true;
    let created: string[] = [];
    if (!frameSourceKey || !vizKey || !model) return;

    const show = (set: { frames: Blob[] }) => {
      if (!alive) return;
      created = set.frames.map((b) => URL.createObjectURL(b));
      setLoadedFrames({ key: frameSourceKey, urls: created });
    };
    const load = async () => {
      const set = await getSprites(kareAnahtari(vizKey)).catch(() => null);
      if (set && set.frames.length) { show(set); return; }
      // Kareler yok → arka planda KİBARCA üret (seri + boşta + yüklemede bekler), sonra yokla.
      void vizPipe().then((m) => m.ensureVizAssets({ fileId: model.id, cacheKey: vizKey, thumbnailMissing: !model.thumbnailVar })).catch(() => {});
      /**
       * Üretim bitene dek periyodik bak. Eskiden 5 saniyede bir, 24 kez: kare üretimi kalıcı
       * olarak başarısızsa (dosya çözülemiyor, WebGL bağlamı yok) aynı ağır iş iki dakika
       * boyunca 24 kez tekrarlanıyordu. Şimdi 15 saniyede bir, 6 kez.
       *
       * ⚠️ Kalıcı "başarısız" işareti KOYULMUYOR: başarısızlık geçici olabiliyor (bağlam
       * kaybı, `toBlob` null) ve kalıcı işaretlenirse kart o oturumda bir daha dolmaz.
       */
      let tries = 0;
      const iv = setInterval(async () => {
        if (!alive || tries++ > 6) { clearInterval(iv); return; }
        const s = await getSprites(kareAnahtari(vizKey)).catch(() => null);
        if (s && s.frames.length) { clearInterval(iv); show(s); return; }
        void vizPipe().then((m) => m.ensureVizAssets({ fileId: model.id, cacheKey: vizKey, thumbnailMissing: !model.thumbnailVar })).catch(() => {}); // takıldıysa yeniden dene (iç dedupe)
      }, 15000);
      // temizlikte durdur
      cleanup.push(() => clearInterval(iv));
    };
    const cleanup: (() => void)[] = [];
    void load();
    return () => {
      alive = false;
      cleanup.forEach((fn) => fn());
      created.forEach((u) => URL.revokeObjectURL(u));
    };
    // Object URL'leri yalnız model kimliği/içerik anahtarı değişince yenile. Aynı modelin query
    // nesnesi veya thumbnail alanı tazelendiğinde URL'leri revoke edip görseli kırma.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameSourceKey]);

  // CANLI AŞAMA paketi: kareleri üreten iş zaten kompakt paketi IDB'ye yazıyor. Paket varsa o an
  // basılan katmanın üstten görünümünü çizebiliyoruz; yoksa kart yalnız nozul noktasını gösterir.
  const [livePack, setLivePack] = useState<{ key: string; value: LivePack } | null>(null);
  const pack = livePack?.key === frameSourceKey ? livePack.value : null;
  const framesReady = !!urls;
  useEffect(() => {
    if (!frameSourceKey || !vizKey) return;
    let alive = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = async () => {
      if (!alive) return;
      const buf = await getPack(vizKey).catch(() => null);
      if (!alive) return;
      if (buf) {
        try {
          const m = await import("@/lib/gcode-viz/viz-pack");
          if (!alive) return;
          setLivePack({
            key: frameSourceKey,
            value: { pack: m.decodeVizPack(buf), layerAt: m.layerAtBytePosition, isBody: m.isBodyFeature },
          });
          return;
        } catch { /* bozuk paket → aşama çizimi yok, kart çalışmaya devam eder */ }
      }
      // Paket henüz üretilmedi (kareler üretilirken yazılıyor) → seyrek yokla.
      if (tries++ < 20) timer = setTimeout(() => void attempt(), 8000);
    };
    void attempt();
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameSourceKey, framesReady]);

  return {
    frames: urls,
    // Görselin URL'i — gövdeye gömülü data-URL yerine bir yıllık önbellekli uç.
    thumbnail: model?.thumbnailVar ? `/api/models/${model.id}/preview` : null,
    pack,
    viewer: model && vizKey ? { fileId: model.id, cacheKey: vizKey } : null,
  };
}

// ── Kart görseli: gerçek plaka + katman rozeti + canlı aşama ────────────────

interface StageProps {
  pack: LivePack | null;
  layerIndex: number | null;
  intra: number | null;
  dot: NozzleDot | null;
  frame: StageFrame;
}

/**
 * BASILAN KISIM AÇILIR — model alttan yukarı doğru renklenir.
 *
 * Görselin tamamı soluk duruyor; tamamlanan yüksekliğe kadar olan kısım tam renkli açılıyor
 * ve sınırda ince bir baskı düzlemi çizgisi duruyor. FDM alttan yukarı bastığı için açılım
 * yönü gerçeğe uyuyor. Oran değiştiğinde clip-path tween'liyor — kesme sıçramıyor.
 */
function BuildReveal({
  src, alt, ratio, accent, reduceMotion, onError,
}: {
  src: string;
  alt: string;
  ratio: number;
  accent: string;
  reduceMotion: boolean;
  /** Görsel yüklenemezse kart eski yola döner (kırık resim gösterme). */
  onError: () => void;
}) {
  const yuzde = Math.max(0, Math.min(100, ratio * 100));
  const basladi = yuzde > 0.5;
  const bitti = yuzde > 99.5;
  return (
    <>
      {/* Henüz basılmamış kısım — şeklin nereye gittiği görünsün diye soluk duruyor */}
      <img
        src={src}
        alt={alt}
        onError={onError}
        className="absolute inset-0 h-full w-full object-contain p-2 opacity-[0.22] saturate-0"
      />
      {/* Basılan kısım */}
      <div
        className={cn(
          "absolute inset-0",
          !reduceMotion && "transition-[clip-path] duration-700 ease-out",
        )}
        style={{ clipPath: `inset(${100 - yuzde}% 0 0 0)` }}
      >
        <img src={src} alt="" aria-hidden className="absolute inset-0 h-full w-full object-contain p-2" />
      </div>
      {/* Baskı düzlemi — nozulun bulunduğu yükseklik */}
      {basladi && !bitti && (
        <div
          className={cn(
            "absolute left-1 right-1 h-px",
            !reduceMotion && "transition-[bottom] duration-700 ease-out",
          )}
          style={{
            bottom: `${yuzde}%`,
            background: `linear-gradient(90deg, transparent, ${alpha(accent, 90)}, transparent)`,
            boxShadow: `0 0 8px ${alpha(accent, 60)}`,
          }}
        />
      )}
    </>
  );
}

function JobVisual({
  frames, frameIndex, plateSrc, ratio, images, productName, accent, badge, stage, reduceMotion, onOpen3d,
}: {
  frames: string[] | null;
  frameIndex: number;
  /** Slicer'ın kendi render'ı — varsa kart görseli budur (kareler baskı yollarını çiziyor). */
  plateSrc: string | null;
  /** 0..1 — görsel bu orana kadar alttan yukarı açılır. */
  ratio: number;
  /** Öncelik sırası — biri yüklenemezse sıradakine düşülür. */
  images: string[];
  productName: string;
  accent: string;
  badge: string | null;
  stage: StageProps | null;
  reduceMotion: boolean;
  /** MADDE 11: model dosyası varsa görsel 3B izleyiciyi açar; yoksa null (ölü tık yok). */
  onOpen3d?: (() => void) | null;
}) {
  const list = frames ?? [];
  // Slicer'ın render'ı varsa O gösterilir. Kendi ürettiğimiz kareler baskı YOLLARINI üst üste
  // bindirdiği için model beyaz bir siluete dönüşüyor; render gölgeli ve net.
  // Önizleme üretilemeyen dosyalarda uç nokta boş döner; o kaynağı işaretleyip eski yola düş.
  const [plateFailed, setPlateFailed] = useState<string | null>(null);
  const plateAday = plateSrc?.trim() || null;
  const plate = plateAday && plateAday !== plateFailed ? plateAday : null;
  const hasFrames = !plate && list.length > 0;
  // ÇAPRAZ GEÇİŞ: yeni kare üsttte belirirken ÖNCEKİ kare altta duruyor. Eskiden yalnız yeni kare
  // vardı ve her kare değişiminde bir an boşluğa göz kırpıyordu.
  const [prevIndex, setPrevIndex] = useState(frameIndex);
  useEffect(() => {
    if (prevIndex === frameIndex) return;
    // Geçiş bitince alttaki kareyi eşitle — üstteki zaten tam görünür olduğu için göz fark etmez.
    const t = setTimeout(() => setPrevIndex(frameIndex), 520);
    return () => clearTimeout(t);
  }, [frameIndex, prevIndex]);

  const clickable = !!onOpen3d;
  return (
    <div
      className={cn(
        "group relative h-[168px] w-[168px] shrink-0 rounded-xl border overflow-hidden",
        clickable && "cursor-pointer transition-shadow hover:shadow-lg focus-within:ring-2 focus-within:ring-primary/50",
      )}
      style={{
        // Siyah filamentli şeffaf PNG koyu zeminde kaybolmasın: hafif açık zemin + ince kontur.
        background: "radial-gradient(ellipse at 50% 38%, oklch(0.95 0.02 265 / 15%), oklch(0.90 0.02 265 / 5%) 72%)",
        borderColor: alpha(accent, 26),
      }}
    >
      {plate ? (
        <BuildReveal
          src={plate}
          alt={productName}
          ratio={ratio}
          accent={accent}
          reduceMotion={reduceMotion}
          onError={() => setPlateFailed(plate)}
        />
      ) : hasFrames ? (
        <>
          {prevIndex !== frameIndex && list[prevIndex] && (
            <img key={`prev-${prevIndex}`} src={list[prevIndex]} alt="" className="absolute inset-0 h-full w-full object-contain" />
          )}
          <img
            key={frameIndex}
            src={list[frameIndex]}
            alt={productName}
            className="absolute inset-0 h-full w-full object-contain motion-safe:animate-in motion-safe:fade-in duration-500"
          />
        </>
      ) : (
        <FallbackImage
          candidates={images}
          alt={productName}
          className="absolute inset-0 h-full w-full object-contain p-2 motion-safe:animate-in motion-safe:fade-in duration-500"
          fallback={<VisualPlaceholder reduceMotion={reduceMotion} />}
        />
      )}

      {badge && (
        <span className="absolute left-1.5 top-1.5 rounded-md border bg-background/80 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in duration-300">
          {badge}
        </span>
      )}
      {stage && <LiveStageTile {...stage} accent={accent} reduceMotion={reduceMotion} />}

      {/* MADDE 11: tıklanabilirlik GÖRÜNSÜN — sağ üstte 3B rozeti, üstünde hafif örtü. */}
      {clickable && (
        <button
          type="button"
          onClick={onOpen3d ?? undefined}
          className="absolute inset-0 z-20 flex items-start justify-end p-1.5 outline-none"
          title="3B görünümü aç"
        >
          <span className="inline-flex items-center gap-1 rounded-md border bg-background/80 px-1.5 py-0.5 text-[10px] font-semibold backdrop-blur-sm opacity-70 transition-all group-hover:opacity-100 group-hover:bg-background/95 group-hover:scale-105">
            <Rotate3d className="h-3 w-3" /> 3B
          </span>
        </button>
      )}
    </div>
  );
}

/** Görsel yokken boş kutu değil, nefes alan bir yer tutucu. */
function VisualPlaceholder({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-hidden">
      <Box className="h-12 w-12 text-muted-foreground/25" />
      {!reduceMotion && (
        <div
          className="absolute inset-0"
          style={{ background: "linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.07) 50%, transparent 80%)", animation: "printer-shimmer 2.6s linear infinite" }}
        />
      )}
    </div>
  );
}

/**
 * CANLI AŞAMA — o an basılan katmanın üstten görünümü ve nozulun tabladaki yeri.
 * Katman `job.layerCurrent`tan gelir; bayt konumu yalnız katman İÇİ ince oran için kullanılır
 * (hareket kuyruğu yüzünden gerçekte basılanın birkaç KB önündedir).
 */
function LiveStageTile({
  pack, layerIndex, intra, dot, frame, accent, reduceMotion,
}: StageProps & { accent: string; reduceMotion: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Çerçeve her render'da yeni bir nesne olarak geliyor → bağımlılık olarak SAYILARINI kullan,
  // yoksa saniyelik tikte tuval boşuna yeniden çizilir.
  const { minX, maxX, minY, maxY } = frame;
  const aspect = maxY - minY > 0 ? (maxX - minX) / (maxY - minY) : 1;
  // Katman içi oran her yoklamada azıcık oynuyor; yeniden çizimi 20 kademeye indir.
  const intraStep = intra == null ? -1 : Math.round(intra * 20);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(box.width));
    const h = Math.max(1, Math.round(box.height));
    const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!pack || layerIndex == null) return;
    drawLayerTopView(ctx, w, h, {
      pack: pack.pack, isBody: pack.isBody, layerIndex,
      intra: intraStep < 0 ? null : intraStep / 20,
      frame: { minX, maxX, minY, maxY }, accent,
    });
  }, [pack, layerIndex, intraStep, minX, maxX, minY, maxY, accent]);

  return (
    <div className="absolute bottom-1.5 right-1.5 h-[72px] w-[72px] rounded-md border bg-background/72 p-[3px] backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in duration-300">
      <div className="relative h-full w-full flex items-center justify-center">
        <div
          className="relative rounded-[2px] border border-white/12"
          style={aspect >= 1 ? { width: "100%", aspectRatio: `${aspect}` } : { height: "100%", aspectRatio: `${aspect}` }}
        >
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
          {dot && (
            <span
              className="absolute h-[5px] w-[5px] -ml-[2.5px] -mt-[2.5px] rounded-full"
              style={{
                left: `${dot.left * 100}%`,
                top: `${dot.top * 100}%`,
                background: dot.clamped ? "oklch(0.75 0 0 / 45%)" : accent,
                boxShadow: dot.clamped ? undefined : `0 0 6px 1.5px ${accent}`,
                transition: reduceMotion ? undefined : "left 900ms ease-out, top 900ms ease-out",
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Katmanın XY yollarını mini tuvale çizer: basılan kısım parlak, kalanı soluk. */
function drawLayerTopView(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  o: { pack: VizPack; isBody: (f: number) => boolean; layerIndex: number; intra: number | null; frame: StageFrame; accent: string },
) {
  const { pack, frame } = o;
  const spanX = frame.maxX - frame.minX;
  const spanY = frame.maxY - frame.minY;
  if (!(spanX > 0) || !(spanY > 0)) return;
  const start = pack.layerPathStart[o.layerIndex];
  const end = pack.layerPathEnd[o.layerIndex];
  if (end == null || start == null || end <= start) return;
  const cut = o.intra == null ? end : start + Math.round((end - start) * clamp(o.intra, 0, 1));
  const px = (q: number) => ((pack.originX + q * pack.scaleXY) - frame.minX) / spanX * w;
  const py = (q: number) => (frame.maxY - (pack.originY + q * pack.scaleXY)) / spanY * h;

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // GERÇEK EKSTRÜZYON GENİŞLİĞİ. Eskiden sabit 0,8-1,1px kıl çizgi çiziliyordu; 58px'lik
  // karoda bu, parçanın kendisi değil makinenin yol karalamasıydı ("hareket çizgilerini
  // görüyoruz"). Vuruş gerçek şerit kalınlığına ölçeklenince komşu yollar birleşir ve
  // DOLU bir siluet çıkar. Küçük parçada (U1 gövdesi 13,8 mm) karoyu tamamen doldurmasın
  // diye üst sınır karo genişliğinin %9'u.
  const SERIT_MM = 0.42;
  const kalinlik = Math.min(w * 0.09, Math.max(1.6, (w / spanX) * SERIT_MM));
  // 0: henüz basılmayan yollar (hayalet) — 1: basılanlar (yazıcının kimlik renginde)
  for (const printedPass of [0, 1]) {
    ctx.beginPath();
    ctx.strokeStyle = printedPass ? o.accent : "oklch(0.85 0 0 / 14%)";
    ctx.lineWidth = printedPass ? kalinlik : Math.max(1, kalinlik * 0.55);
    for (let i = start; i < end; i++) {
      if (!o.isBody(pack.pathFeature[i])) continue;
      if ((i < cut ? 1 : 0) !== printedPass) continue;
      const first = pack.pathStart[i];
      const len = pack.pathLen[i];
      if (len < 2) continue;
      ctx.moveTo(px(pack.points[first * 2]), py(pack.points[first * 2 + 1]));
      for (let k = 1; k < len; k++) {
        ctx.lineTo(px(pack.points[(first + k) * 2]), py(pack.points[(first + k) * 2 + 1]));
      }
    }
    ctx.stroke();
  }
}

/** MADDE 12 — yüklü filamentler. Renk tek sinyal değil: slot numarası da yazar. */
function SlotStrip({ chips, className }: { chips: SlotChip[]; className?: string }) {
  if (chips.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {chips.map((c) => (
        <span
          key={c.slot}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border py-0.5 pl-1 pr-1.5 text-[10px] font-semibold tabular-nums transition-opacity duration-300",
            c.active ? "opacity-100" : "opacity-45",
            c.empty ? "border-dashed text-muted-foreground" : "text-foreground/80"
          )}
        >
          <span
            className={cn("h-2.5 w-2.5 rounded-full border", c.empty && "border-dashed")}
            style={{ background: c.empty ? "transparent" : (c.color || "oklch(0.7 0 0)"), borderColor: "oklch(1 0 0 / 25%)" }}
          />
          {/* Yazıcının kendi ekranı ve AMS etiketleri 1'den başlıyor → GÖSTERİM 1 tabanlı.
              İç veri (renk dizisi, activeSlots, kafa indeksi) 0 tabanlı kalır. */}
          {slotLabel(c.slot)}
          <span className="font-normal text-muted-foreground">{c.empty ? "boş" : c.type}</span>
        </span>
      ))}
    </div>
  );
}

// ── Yazıcı yerel depolama: ince bar + temizleme dialogu ─────────────────────
interface PrinterStorageResp {
  kind: "moonraker" | "bambu";
  total: number | null;
  free: number | null;
  used: number | null;
  files: { name: string; size: number; modified: number | null }[];
}
function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1).replace(".", ",")} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function PrinterStorageStrip({ printerId, accent, activeFile }: { printerId: string; accent: string; activeFile?: string | null }) {
  const [open, setOpen] = useState(false);
  const q = useQuery<PrinterStorageResp>({
    queryKey: ["printer-storage", printerId],
    queryFn: () => fetch(`/api/printers/${printerId}/storage`).then((r) => {
      if (!r.ok) throw new Error("Depolama okunamadı");
      return r.json();
    }),
    staleTime: 5 * 60_000, // depolama sık değişmez — sayfa başına bir okuma yeter
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const st = q.data;
  const filesBytes = useMemo(() => (st?.files ?? []).reduce((s, f) => s + f.size, 0), [st]);
  const pctUsed = st?.total && st.used != null ? Math.min(100, Math.round((st.used / st.total) * 100)) : null;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-2 pt-2 mt-1 border-t border-border/50 text-[11px] text-muted-foreground hover:text-foreground transition-colors group"
        title="Yazıcı depolamasını görüntüle / temizle"
      >
        <HardDrive className="h-3.5 w-3.5 shrink-0" />
        {q.isLoading ? (
          <Skeleton className="h-1.5 flex-1 rounded-full" />
        ) : q.isError || !st ? (
          <span className="flex-1 text-left">Depolama okunamadı</span>
        ) : pctUsed != null ? (
          <>
            <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out"
                style={{
                  width: `${pctUsed}%`,
                  background: pctUsed >= 90 ? "oklch(0.63 0.2 25)" : pctUsed >= 75 ? "oklch(0.75 0.15 75)" : alpha(accent, 80),
                }}
              />
            </span>
            {/* Barla TUTARLI metin = boş yer (eski "kullanılan / toplam" kullanıcının o kadar dosyası
                varmış gibi görünüyordu; oysa doluluğun çoğu yazıcının kendi sistemi). */}
            <span className="tabular-nums shrink-0">{st.files.length} dosya · {fmtBytes(st.free!)} boş</span>
          </>
        ) : (
          <span className="flex-1 text-left tabular-nums">{st.files.length} dosya · {fmtBytes(filesBytes)}</span>
        )}
        <ChevronRight className="h-3 w-3 shrink-0 opacity-50 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
      </button>
      {/* Timelapse şeridi — videosu olmayan yazıcıda kendini gizler (kartı kalabalıklaştırmaz). */}
      <TimelapseStrip printerId={printerId} accent={accent} />
      {open && <PrinterStorageDialog printerId={printerId} activeFile={activeFile} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Basılmakta olan dosya adını depolama listesindeki adlarla kıyaslamak için normalize
 *  (yol/uzantı at, küçült) — birebir eşleşme, isim tahmini değil. */
function normFileName(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "").toLowerCase().trim();
}

function PrinterStorageDialog({ printerId, activeFile, onClose }: { printerId: string; activeFile?: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery<PrinterStorageResp>({
    queryKey: ["printer-storage", printerId],
    queryFn: () => fetch(`/api/printers/${printerId}/storage`).then((r) => {
      if (!r.ok) throw new Error("Depolama okunamadı");
      return r.json();
    }),
    refetchOnMount: "always",
  });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const files = q.data?.files ?? [];
  const activeNorm = normFileName(activeFile);
  const isActive = (name: string) => activeNorm !== "" && normFileName(name) === activeNorm;
  const deletable = files.filter((f) => !isActive(f.name)); // basılan dosya silinemez
  const selBytes = files.filter((f) => sel.has(f.name)).reduce((s, f) => s + f.size, 0);
  const toggle = (n: string) => {
    if (isActive(n)) return; // basılmakta olan dosya seçilemez
    setSel((p) => { const x = new Set(p); if (x.has(n)) x.delete(n); else x.add(n); return x; });
  };

  const removeSel = async () => {
    if (!sel.size || busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/printers/${printerId}/storage`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: [...sel] }),
      });
      const j = await r.json().catch(() => ({} as { deleted?: number; error?: string; blockedActive?: boolean }));
      if (!r.ok) throw new Error(j?.error || "Silinemedi");
      if (j.blockedActive) toast.warning(`${j.deleted ?? 0} dosya silindi · basılmakta olan dosya korundu`);
      else toast.success(`${j.deleted ?? sel.size} dosya silindi`);
      setSel(new Set());
      qc.invalidateQueries({ queryKey: ["printer-storage", printerId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Silinemedi");
    } finally {
      setBusy(false);
    }
  };

  const st = q.data;
  const filesBytes = files.reduce((s, f) => s + f.size, 0);
  const pctUsed = st?.total && st.used != null ? Math.min(100, Math.round((st.used / st.total) * 100)) : null;
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-md max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><HardDrive className="h-4 w-4 text-primary" /> Yazıcı Depolaması</DialogTitle>
          {/* ÖNCE senin baskı dosyaların (silinebilen) — asıl bilgi bu. Disk doluluğu ikincil. */}
          <p className="text-xs text-foreground/80 mt-1">
            Baskı dosyaların: <span className="font-semibold tabular-nums">{files.length} dosya · {fmtBytes(filesBytes)}</span>
          </p>
          {pctUsed != null && st ? (
            <div className="mt-2 space-y-1">
              <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full transition-[width] duration-700 ease-out"
                  style={{ width: `${pctUsed}%`, background: pctUsed >= 90 ? "oklch(0.63 0.2 25)" : "oklch(0.62 0.14 250)" }}
                />
              </div>
              <p className="text-[11px] text-muted-foreground tabular-nums">
                Diskte {st.free != null ? `${fmtBytes(st.free)} boş` : `${fmtBytes(st.used!)} dolu`} · toplam {fmtBytes(st.total!)}
              </p>
              <p className="text-[11px] text-muted-foreground/70">Doluluğun çoğu yazıcının kendi sistemi — silinemez.</p>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground mt-1">Silinen dosya gerekirse sonraki baskıda otomatik yeniden yüklenir.</p>
          )}
        </DialogHeader>
        {q.isLoading ? (
          <div className="py-8 text-center"><Loader2 className="h-4 w-4 mx-auto animate-spin text-muted-foreground" /></div>
        ) : q.isError ? (
          <p className="text-xs text-destructive py-4">Depolama okunamadı — yazıcı çevrimiçi mi?</p>
        ) : files.length === 0 ? (
          <p className="text-xs text-muted-foreground py-6 text-center">Yazıcıda dosya yok — depolama temiz ✨</p>
        ) : (
          <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-1">
            <div className="flex items-center justify-between px-1 pb-1">
              <button
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setSel(sel.size === deletable.length && deletable.length > 0 ? new Set() : new Set(deletable.map((f) => f.name)))}
              >
                {sel.size === deletable.length && deletable.length > 0 ? "Seçimi kaldır" : "Tümünü seç"}
              </button>
              <span className="text-[11px] text-muted-foreground tabular-nums">{files.length} dosya</span>
            </div>
            {files.map((f) => {
              const active = isActive(f.name);
              return (
                <label
                  key={f.name}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors",
                    active ? "opacity-60 cursor-not-allowed border-primary/30 bg-primary/5"
                      : sel.has(f.name) ? "border-destructive/40 bg-destructive/5 cursor-pointer" : "hover:bg-muted/60 cursor-pointer"
                  )}
                  title={active ? "Şu an basılıyor — silinemez" : f.name}
                >
                  <input type="checkbox" className="accent-red-500" checked={sel.has(f.name)} disabled={active} onChange={() => toggle(f.name)} />
                  <span className="flex-1 truncate font-mono text-[11px]">{f.name}</span>
                  {active && <span className="text-[9px] font-semibold text-primary shrink-0 inline-flex items-center gap-0.5"><Play className="h-2.5 w-2.5" />basılıyor</span>}
                  <span className="tabular-nums text-muted-foreground shrink-0">{fmtBytes(f.size)}</span>
                </label>
              );
            })}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Kapat</Button>
          <Button variant="destructive" disabled={!sel.size || busy} onClick={removeSel}>
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Trash2 className="h-4 w-4 mr-1.5" />}
            Sil ({sel.size}{sel.size ? ` · ${fmtBytes(selBytes)}` : ""})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const [confirmDel, setConfirmDel] = useState<PrinterConfig | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["printer-configs"] });
    qc.invalidateQueries({ queryKey: ["printers"] });
  };

  const del = useMutation({
    mutationFn: (id: string) => fetchJson(`/api/printers/config/${id}`, { method: "DELETE" }),
    onSuccess: () => { refresh(); setConfirmDel(null); toast.success("Yazıcı silindi"); },
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
                      <p className="text-[11px] text-muted-foreground truncate">
                        {c.model || BRANDS.find((b) => b.value === c.brand)?.label || c.brand} · <span className="font-mono">{c.host}</span>
                      </p>
                    </div>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(c)} title="Düzenle">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    {/* Tek tık kalıcı silme yerine onay — eşleştirme geçmişi de birlikte gidiyor. */}
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive/70 hover:text-destructive" disabled={del.isPending} onClick={() => setConfirmDel(c)} title="Sil">
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

      {/* Yazıcı silme onayı */}
      <Dialog open={!!confirmDel} onOpenChange={(o) => !o && !del.isPending && setConfirmDel(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Trash2 className="h-4 w-4 text-destructive" /> Yazıcıyı sil
            </DialogTitle>
            <p className="text-xs text-muted-foreground mt-1">
              <span className="font-medium text-foreground">{confirmDel?.name}</span> ve ürün eşleştirme geçmişi silinecek. Bu işlem geri alınamaz.
            </p>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={del.isPending} onClick={() => setConfirmDel(null)}>Vazgeç</Button>
            <Button variant="destructive" size="sm" disabled={del.isPending} onClick={() => confirmDel && del.mutate(confirmDel.id)}>
              {del.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Sil
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
    if (!host.trim()) { toast.error("Önce yazıcının IP adresini gir"); return; }
    setTest({ state: "loading" });
    try {
      const r = await fetchJson<{ ok: boolean; hostname?: string; port?: number; error?: string }>(
        `/api/printers/test?host=${encodeURIComponent(host.trim())}&port=${Number(port) || 7125}`
      );
      if (r.ok) {
        if (r.port && r.port !== Number(port)) setPort(String(r.port)); // Elegoo → 80'e otomatik düzelt
        // Port/durum bilgisi kullanıcıya gösterilmez; yalnız yazıcının adı anlamlı.
        setTest({ state: "ok", msg: r.hostname });
      } else {
        setTest({ state: "fail", msg: r.error });
      }
    } catch (e) {
      setTest({ state: "fail", msg: e instanceof Error ? e.message : undefined });
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
          <Label className="text-xs">IP Adresi</Label>
          <Input value={host} onChange={(e) => { setHost(e.target.value); setTest({ state: "idle" }); }} placeholder="192.168.1.18" className="font-mono" />
        </div>
        <div>
          <Label className="text-xs">Port</Label>
          <Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </div>
      </div>

      {isBambu ? (
        <>
          <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-400">
            Yazıcı ekranından <strong>LAN Modu</strong> ve <strong>Geliştirici Modu</strong>&apos;nu aç; erişim kodu ile seri no orada yazar.
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Erişim Kodu</Label>
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
          {test.state === "ok" && <span className="text-xs text-green-400 inline-flex items-center gap-1"><Check className="h-3.5 w-3.5" /> Bağlandı{test.msg ? ` (${test.msg})` : ""}</span>}
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
  const { data, isLoading: productsLoading } = useQuery<PickProduct[]>({
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
          {productsLoading ? (
            <div className="py-8 text-center"><Loader2 className="h-4 w-4 mx-auto animate-spin text-muted-foreground" /></div>
          ) : list.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">Ürün bulunamadı.</p>
          ) : (
            list.map((p) => (
              <button key={p.id} onClick={() => match.mutate(p.id)} disabled={match.isPending} className="w-full flex items-center gap-2.5 p-1.5 rounded-lg hover:bg-muted text-left disabled:opacity-50">
                <div className="h-9 w-9 shrink-0 rounded-md border bg-muted flex items-center justify-center overflow-hidden">
                  {p.imageUrl ? <img src={thumbUrl(p.imageUrl) ?? undefined} alt="" loading="lazy" className="max-w-full max-h-full object-contain" /> : <Package className="h-4 w-4 text-muted-foreground/40" />}
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

// ── Baskı seçici hiyerarşisi: ürün/grup → varyant → dosya ──────────────────────────
interface PickFileMember { productId: string; label: string; image: string | null; files: PrintableModel[] }
type PickNode =
  | { kind: "solo"; key: string; name: string; image: string | null; searchText: string; files: PrintableModel[] }
  | { kind: "group"; key: string; name: string; image: string | null; searchText: string; members: PickFileMember[]; sharedFiles: PrintableModel[]; allShared: boolean; variantCount: number };

/** Düz dosya listesini ürün/grup düğümlerine çevirir; varyantların ORTAK dosyalarını (shareKey)
 *  tekilleştirir → "aynı dosyaysa tek dosya göster". Boy gibi farklı dosyalı varyantlar ayrı kalır. */
function buildPickNodes(models: PrintableModel[]): PickNode[] {
  const lower = (s: string) => s.toLocaleLowerCase("tr-TR");
  const tops = new Map<string, PrintableModel[]>();
  for (const m of models) {
    const key = m.variantGroupId ? `g:${m.variantGroupId}` : `s:${m.productId}`;
    const arr = tops.get(key);
    if (arr) arr.push(m); else tops.set(key, [m]);
  }
  const nodes: PickNode[] = [];
  for (const [key, list] of tops) {
    if (key.startsWith("s:")) {
      const f = list[0];
      nodes.push({
        kind: "solo", key, name: f.productName, image: f.imageUrl,
        searchText: lower([f.productName, f.alias ?? "", f.originalName].join(" ")),
        files: list,
      });
      continue;
    }
    const byProduct = new Map<string, PrintableModel[]>();
    for (const m of list) { const a = byProduct.get(m.productId); if (a) a.push(m); else byProduct.set(m.productId, [m]); }
    const members: PickFileMember[] = [...byProduct.entries()].map(([pid, files]) => ({
      productId: pid, label: files[0].variantLabel || files[0].productName, image: files[0].imageUrl, files,
    }));
    const byShare = new Map<string, PrintableModel[]>();
    for (const m of list) { const k = m.shareKey || m.fileId; const a = byShare.get(k); if (a) a.push(m); else byShare.set(k, [m]); }
    const buckets = [...byShare.values()];
    const sharedBuckets = buckets.filter((b) => new Set(b.map((x) => x.productId)).size >= 2);
    const soloBuckets = buckets.filter((b) => new Set(b.map((x) => x.productId)).size < 2);
    const allShared = soloBuckets.length === 0 && sharedBuckets.length > 0;
    const name = list[0].variantGroupName || list[0].productName;
    nodes.push({
      kind: "group", key, name, image: members[0]?.image ?? null,
      searchText: lower([name, ...members.map((mm) => mm.label), ...list.map((x) => x.alias ?? "")].join(" ")),
      members, sharedFiles: sharedBuckets.map((b) => b[0]), allShared, variantCount: members.length,
    });
  }
  nodes.sort((a, b) => a.name.localeCompare(b.name, "tr-TR"));
  return nodes;
}

function NodeRow({ node, disabled, onClick }: { node: PickNode; disabled: boolean; onClick: () => void }) {
  const isGroup = node.kind === "group";
  const drillable = isGroup || (node.kind === "solo" && node.files.length > 1);
  return (
    <button onClick={onClick} disabled={disabled} className="w-full flex items-center gap-2.5 p-2 rounded-lg hover:bg-muted text-left disabled:opacity-50">
      <div className="h-9 w-9 shrink-0 rounded-md border bg-muted flex items-center justify-center overflow-hidden">
        {node.image ? <img src={thumbUrl(node.image) ?? undefined} alt="" loading="lazy" className="max-w-full max-h-full object-contain" /> : <Package className="h-4 w-4 text-muted-foreground/40" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm truncate">{node.name}</p>
        <p className="text-[10px] text-muted-foreground flex items-center gap-1.5 truncate">
          {isGroup ? (
            <><Layers className="h-3 w-3 shrink-0" /> {node.variantCount} varyant{node.allShared ? " · ortak dosya" : ""}</>
          ) : node.files.length > 1 ? (
            <>{node.files.length} parça</>
          ) : (
            <span className="font-mono truncate">{node.files[0]?.originalName}</span>
          )}
        </p>
      </div>
      {drillable ? <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" /> : <Play className="h-4 w-4 text-primary shrink-0" />}
    </button>
  );
}

function FileRow({ m, idx, disabled, onClick }: { m: PrintableModel; idx: number; disabled: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={disabled} className="w-full flex items-center gap-2.5 p-2 rounded-lg hover:bg-muted text-left disabled:opacity-50">
      <span className="flex items-center justify-center h-7 w-7 rounded bg-primary/10 text-primary text-[11px] font-bold tabular-nums shrink-0">{idx + 1}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm truncate">{m.label || m.originalName}</p>
        <p className="text-[10px] text-muted-foreground font-mono truncate">{m.originalName}{m.gramaj ? ` · ${m.gramaj} gr` : ""}</p>
      </div>
      <Play className="h-4 w-4 text-primary shrink-0" />
    </button>
  );
}

function StartModal({ target, onClose }: { target: { id: string; name: string; brand: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const multiColor = target.brand === "bambu" || target.brand === "snapmaker";
  const isBambu = target.brand === "bambu";
  const { data, isLoading, isError, error } = useQuery<{ models: PrintableModel[] }>({
    queryKey: ["printable-models", target.id],
    queryFn: () => fetchJson<{ models: PrintableModel[] }>(`/api/printers/${target.id}/printable-models`),
    // Model ekle/sil/düzenle yolları bu anahtarı invalidate ediyor (ModelFilesCard) → 10dk taze:
    // değişiklik yoksa modal yeniden açılışta ANINDA (ağ yok); değişince invalidate onu bayat
    // yapar → refetchOnMount:true ile mount'ta bir kez tazelenir (yeni/düzenlenen model görünür).
    // (Eski staleTime:0 + refetchOnMount:'always' HER açılışta ağ+parse gecikmesi ekliyordu.)
    // NOT: global refetchOnMount:false; burada AÇIKÇA true — yoksa invalidate sonrası tazelenmezdi.
    staleTime: 10 * 60_000,
    refetchOnMount: true,
  });
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<PrintableModel | null>(null);
  const printing = false; // baskı artık ARKA PLANDA (modal kilitlenmez) → modal-içi "printing" durumu yok
  // Gezinme: liste → (grup) → (varyant) → dosya
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [openVariant, setOpenVariant] = useState<string | null>(null);

  // Baskıyı ARKA PLANDA başlat + modalı KAPAT → ilerleme kartta görünür, hata pop-up (toast).
  // Kullanıcı bu ekranda kilitlenmez, hızlıca başka işine döner.
  const runPrint = (fileId: string, label: string, opts: { amsMapping?: number[]; useAms?: boolean; prefs?: PrintPrefs } = {}) => {
    startBackgroundPrint(qc, { printerId: target.id, fileId, label, printOpts: opts });
    onClose();
  };

  const nodes = useMemo(() => buildPickNodes(data?.models ?? []), [data]);
  const filtered = useMemo(() => {
    const query = q.trim().toLocaleLowerCase("tr-TR");
    return (query ? nodes.filter((n) => n.searchText.includes(query)) : nodes).slice(0, 200);
  }, [nodes, q]);

  const openNode = nodes.find((n) => n.key === openKey) ?? null;
  const openMember = openNode?.kind === "group" ? openNode.members.find((m) => m.productId === openVariant) ?? null : null;
  // Tek renkli (Elegoo): dosyaya tıklamak DOĞRUDAN basıyordu — yanlış tık = istenmeyen baskı.
  // 1 satırlık onay adımı eklendi (çok renklilerde SlotStep zaten doğal onay).
  const [confirmFile, setConfirmFile] = useState<PrintableModel | null>(null);
  const pickFile = (m: PrintableModel) => (multiColor ? setPicked(m) : setConfirmFile(m));

  if (picked) {
    return (
      <SlotStep printerId={target.id} model={picked} isBambu={isBambu} isSnapmaker={target.brand === "snapmaker"} printing={false} progress={null}
        onBack={() => setPicked(null)} onClose={onClose} onConfirm={(opts) => runPrint(picked.fileId, picked.productName, opts)} />
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !printing && onClose()}>
      <DialogContent className="max-w-md max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Baskı Başlat — {target.name}</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1 truncate">
            {openNode
              ? (openMember ? `${openNode.name} · ${openMember.label}` : openNode.name)
              : multiColor ? "Ürün seç → varyant/dosya → renk." : "Ürün seç → dosya; yazıcıya yüklenip baskı başlar."}
          </p>
        </DialogHeader>

        {openNode ? (
          <button
            onClick={() => (openVariant ? setOpenVariant(null) : setOpenKey(null))}
            className="flex items-center gap-1 text-xs text-primary hover:underline w-fit"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Geri
          </button>
        ) : (
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ürün veya takma ad ara…" className="pl-8 h-9" autoFocus />
          </div>
        )}

        <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-0.5 min-h-[140px]">
          {isLoading ? (
            <div className="py-8 text-center text-muted-foreground"><Loader2 className="h-4 w-4 mx-auto animate-spin" /></div>
          ) : isError ? (
            <p className="text-xs text-destructive text-center py-6">{(error as Error)?.message || "Modeller alınamadı"}</p>
          ) : !openNode ? (
            filtered.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-xs text-muted-foreground">{q ? "Eşleşen ürün yok." : "Bu yazıcı için yüklenmiş model yok."}</p>
                <p className="text-[11px] text-muted-foreground/70 mt-1">Bir ürünün sayfasından bu yazıcı için baskı dosyası yükle.</p>
              </div>
            ) : (
              filtered.map((n) => (
                <NodeRow key={n.key} node={n} disabled={printing}
                  onClick={() => {
                    if (n.kind === "solo" && n.files.length === 1) pickFile(n.files[0]);
                    else { setOpenKey(n.key); setOpenVariant(null); }
                  }}
                />
              ))
            )
          ) : openNode.kind === "solo" ? (
            openNode.files.map((m, i) => <FileRow key={m.fileId} m={m} idx={i} disabled={printing} onClick={() => pickFile(m)} />)
          ) : openMember ? (
            openMember.files.map((m, i) => <FileRow key={m.fileId} m={m} idx={i} disabled={printing} onClick={() => pickFile(m)} />)
          ) : openNode.allShared ? (
            <>
              <p className="text-[11px] text-muted-foreground px-1 py-1">Tüm varyantlarda ortak — bir kez seç, hepsi için aynı dosya.</p>
              {openNode.sharedFiles.map((m, i) => <FileRow key={m.fileId} m={m} idx={i} disabled={printing} onClick={() => pickFile(m)} />)}
            </>
          ) : (
            openNode.members.map((mem) => (
              <button key={mem.productId} disabled={printing} onClick={() => setOpenVariant(mem.productId)}
                className="w-full flex items-center gap-2.5 p-2 rounded-lg hover:bg-muted text-left disabled:opacity-50">
                <div className="h-9 w-9 shrink-0 rounded-md border bg-muted flex items-center justify-center overflow-hidden">
                  {mem.image ? <img src={thumbUrl(mem.image) ?? undefined} alt="" loading="lazy" className="max-w-full max-h-full object-contain" /> : <Package className="h-4 w-4 text-muted-foreground/40" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm truncate">{mem.label}</p>
                  <p className="text-[10px] text-muted-foreground">{mem.files.length} parça</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </button>
            ))
          )}
        </div>
      </DialogContent>

      {/* Tek renkli baskı onayı (Elegoo) */}
      <Dialog open={!!confirmFile} onOpenChange={(o) => !o && setConfirmFile(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Play className="h-4 w-4 text-primary" /> Baskıyı başlat?
            </DialogTitle>
            <p className="text-xs text-muted-foreground mt-1 break-all">
              <span className="font-medium text-foreground">{confirmFile?.label || confirmFile?.originalName}</span>
              {" — "}{target.name} üzerinde basılacak. Arka planda yüklenir; ilerlemeyi kartta görürsün.
            </p>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmFile(null)}>Vazgeç</Button>
            <Button size="sm" onClick={() => { if (confirmFile) runPrint(confirmFile.fileId, confirmFile.productName); }}>
              <Play className="h-3.5 w-3.5" /> Bas
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

// ───────────────────────── Özel Baskı (ürüne bağlı olmayan ad-hoc baskı) ─────────────────────────
function fmtDur(min: number | null): string {
  if (!min || min <= 0) return "—";
  const h = Math.floor(min / 60), m = min % 60;
  return h > 0 ? `${h}sa ${m}dk` : `${m}dk`;
}
interface CustomUpload {
  fileId: string; originalName: string; fileKind: "gcode" | "3mf" | "other";
  sizeBytes: number; grams: number | null; estPrintMin: number | null; thumbnail: string | null; colorCount: number;
}
function CustomPrintModal({ printers, onClose }: { printers: PanelPrinter[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<{ id: string; name: string; brand: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProg, setUploadProg] = useState<UploadProgress | null>(null);
  const [file, setFile] = useState<CustomUpload | null>(null);
  const [slotMode, setSlotMode] = useState(false);
  const printing = false; // baskı ARKA PLANDA → modal-içi printing durumu yok (ilerleme kartta)
  const fileRef = useRef<HTMLInputElement>(null);

  const printable = useMemo(() => printers.filter((p) => p.type !== "sim"), [printers]);
  const isBambu = picked?.brand === "bambu";
  const multiColor = picked?.brand === "bambu" || picked?.brand === "snapmaker";

  const upload = async (f: File) => {
    if (!picked) return;
    setUploading(true);
    setUploadProg({ loaded: 0, total: f.size, bytesPerSec: 0 });
    setUploadsActive(1); // arka plan görselleştirme üretimi bu yükleme boyunca beklesin
    try {
      const data = await uploadCustomModel({ printerConfigId: picked.id, file: f, onProgress: setUploadProg });
      setFile(data as unknown as CustomUpload);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploadsActive(-1);
      setUploading(false);
      setUploadProg(null);
    }
  };

  // Baskıyı ARKA PLANDA başlat + modalı kapat → ilerleme kartta, hata pop-up. (Dosya YÜKLEME adımı
  // hâlâ modalda/senkron — kullanıcı dosyayı seçerken bekler; asıl "başlatma" arka plana alınır.)
  const runPrint = (fileId: string, opts: { amsMapping?: number[]; useAms?: boolean; prefs?: PrintPrefs } = {}) => {
    if (!picked) return;
    startBackgroundPrint(qc, { printerId: picked.id, fileId, label: file?.originalName || "Özel baskı", printOpts: opts });
    onClose();
  };

  // Renk eşleme adımı (Bambu/Snapmaker) — mevcut SlotStep'i yeniden kullan.
  if (slotMode && file && picked) {
    const model: PrintableModel = {
      fileId: file.fileId, productId: "__custom__", productName: file.originalName,
      imageUrl: file.thumbnail, label: null, originalName: file.originalName, sizeBytes: file.sizeBytes, gramaj: file.grams,
    };
    return (
      <SlotStep
        printerId={picked.id} model={model} isBambu={isBambu} isSnapmaker={picked.brand === "snapmaker"} printing={false} progress={null}
        onBack={() => setSlotMode(false)} onClose={onClose} onConfirm={(opts) => runPrint(file.fileId, opts)}
      />
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !printing && !uploading && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Upload className="h-4 w-4 text-primary" /> Özel Baskı</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            {!picked ? "Baskı yapacağın yazıcıyı seç." : !file ? "Bu yazıcı için baskı dosyası yükle." : "Önizle ve bas."}
          </p>
        </DialogHeader>

        {!picked ? (
          <div className="space-y-1.5 max-h-[55vh] overflow-y-auto -mx-1 px-1">
            {printable.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-6">Bağlı yazıcı yok.</p>
            ) : (
              printable.map((p) => {
                // Çevrimdışı yazıcı SEÇİLEMEZ — eskiden yükleme başarılı olup baskı sonda patlıyordu.
                const busy = p.status === "printing" || p.status === "paused";
                return (
                  <button
                    key={p.id} disabled={busy || !p.online}
                    onClick={() => setPicked({ id: p.id, name: p.name, brand: p.brand })}
                    className="w-full flex items-center gap-2.5 p-2 rounded-lg border hover:bg-muted text-left disabled:opacity-50"
                  >
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: p.online ? p.accent : "#9ca3af" }} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{p.name}</p>
                      <p className="text-[10px] text-muted-foreground">{p.model || p.brand}{busy ? " · meşgul" : !p.online ? " · çevrimdışı" : ""}</p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </button>
                );
              })
            )}
          </div>
        ) : !file ? (
          <div className="space-y-3">
            <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs flex items-center gap-2">
              <Printer className="h-3.5 w-3.5 text-primary" /> {picked.name}
              {/* Yükleme sürerken yazıcı DEĞİŞTİRİLEMEZ: dosya seçilen yazıcıya bağlı kaydediliyor —
                  ortada değiştirmek "ekranda B, baskı A'ya" tutarsızlığı yaratıyordu. */}
              <button onClick={() => setPicked(null)} disabled={uploading} className="ml-auto text-primary hover:underline disabled:opacity-40 disabled:no-underline">değiştir</button>
            </div>
            <input ref={fileRef} type="file" accept=".gcode,.gco,.g,.3mf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
            <button
              onClick={() => fileRef.current?.click()} disabled={uploading}
              className="w-full rounded-xl border-2 border-dashed py-10 px-6 flex flex-col items-center gap-2 hover:border-primary/40 hover:bg-primary/[0.03] transition-colors disabled:opacity-60"
            >
              {uploading ? <Loader2 className="h-6 w-6 animate-spin text-primary" /> : <FileBox className="h-6 w-6 text-muted-foreground/50" />}
              {uploadProg ? (
                <div className="w-full max-w-xs space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
                    <span>{(uploadProg.loaded / 1048576).toFixed(1)} / {(uploadProg.total / 1048576).toFixed(1)} MB</span>
                    <span className="font-semibold text-foreground">{uploadProg.total > 0 ? Math.min(100, Math.round((uploadProg.loaded / uploadProg.total) * 100)) : 0}%</span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${Math.max(3, uploadProg.total > 0 ? Math.round((uploadProg.loaded / uploadProg.total) * 100) : 0)}%` }} />
                  </div>
                  <div className="text-[10px] text-muted-foreground/80 tabular-nums">
                    {uploadProg.total > 0 && uploadProg.loaded >= uploadProg.total
                      ? "dosya işleniyor…" // PUT bitti, sunucu gramaj/renk/önizleme çıkarıyor — bayat hız yerine dürüst durum
                      : uploadProg.bytesPerSec > 0 ? `${(uploadProg.bytesPerSec / 1048576).toFixed(1)} MB/sn` : "başlıyor…"}
                  </div>
                </div>
              ) : (
                <>
                  <span className="text-sm font-medium">Baskı dosyası seç</span>
                  <span className="text-[11px] text-muted-foreground">{isBambu ? "çok renkli baskı için 3MF dosyası seç" : "dosyayı seçmek için tıkla"}</span>
                </>
              )}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-3">
              <div className="h-24 w-24 shrink-0 rounded-xl border bg-muted flex items-center justify-center overflow-hidden">
                {file.thumbnail ? <img src={file.thumbnail} alt="" className="max-w-full max-h-full object-contain" /> : <Box className="h-8 w-8 text-muted-foreground/30" />}
              </div>
              <div className="min-w-0 flex-1 space-y-1.5">
                <p className="text-sm font-medium truncate" title={file.originalName}>{file.originalName}</p>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
                  <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {fmtDur(file.estPrintMin)}</span>
                  <span className="inline-flex items-center gap-1"><Weight className="h-3 w-3" /> {file.grams != null ? `${Math.round(file.grams)} g` : "—"}</span>
                  {file.colorCount > 0 && <span className="inline-flex items-center gap-1"><Layers className="h-3 w-3" /> {file.colorCount} renk</span>}
                </div>
                <p className="text-[10px] text-muted-foreground/70 inline-flex items-center gap-1"><Printer className="h-3 w-3" /> {picked.name}</p>
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="ghost" onClick={() => setFile(null)}>Geri</Button>
              {multiColor ? (
                <Button onClick={() => setSlotMode(true)} className="gap-1.5"><Layers className="h-4 w-4" /> Renk ayarına geç</Button>
              ) : (
                <Button onClick={() => runPrint(file.fileId)} className="gap-1.5">
                  <Play className="h-4 w-4" /> Bas
                </Button>
              )}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
