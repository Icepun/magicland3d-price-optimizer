"use client";
/* eslint-disable @next/next/no-img-element */

import { useKaliciSecim } from "@/lib/kalici-secim";
import { fetchJson } from "@/lib/fetch-json";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { listeZamani, urunListesiGetir } from "@/lib/products-cache";
import { pencereGizliMi } from "@/lib/pencere-gorunur";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
  Factory,
  Package,
  Disc3,
  AlertTriangle,
  CheckCircle2,
  Printer,
  RefreshCw,
  Timer,
  Zap,
  Snowflake,
  Info,
  List,
  Layers,
  Clock,
  FileBox,
} from "lucide-react";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { formatCurrency, formatNumber } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button, buttonVariants } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ProductPrintModal } from "@/components/products/ProductPrintModal";
import { cn } from "@/lib/utils";
import { thumbUrl } from "@/lib/image";
import { useFreshStocks } from "@/lib/use-fresh-stocks";
import {
  KAPSAM_SECENEKLERI, basilacakAdet, gunlukSatis, hedefStok,
  parseHedefModu, parseKapsamGun, parseTavan,
  type HedefAyari, type HedefModu,
} from "@/core/planner-target";

interface ProductRow {
  id: string;
  name: string;
  imageUrl: string | null;
  stock: number;
  madeToOrder?: boolean;
  /** Net kâr ÷ baskı süresi — üretim önceliğini bu belirler (süre girilmemişse null). */
  profitPerHour: number | null;
  cost?: { filamentWeight: number | null; printTimeHours?: number | null } | null;
}

/** Satış hızı ucunun ürün satırı (/api/planner/insights). */
interface SalesInsight {
  productId: string;
  soldRecent: number;
  soldInWindow: number;
  daysSinceLastSale: number | null;
  daysPerSale: number | null;
  deadStock: boolean;
}

interface SalesInsights {
  windowDays: number;
  recentDays: number;
  /** "Bu kadar gündür satmadı" derken kullanılan GERÇEK süre (geçmiş kısaysa küçülür). */
  deadStockDays: number;
  historyDays: number;
  /** Günlük satış hızının böleni — talep hedefi buna dayanır. */
  measuredDays: number;
  ready: boolean;
  readyInDays: number;
  deadStockReady: boolean;
  deadStockInDays: number;
  items: SalesInsight[];
}

/** Baskı kuyruğu ucunun (/api/planner/queue) satırları. */
interface QueueJob {
  productId: string;
  name: string;
  imageUrl: string | null;
  stock: number;
  quantity: number;
  hoursPerUnit: number | null;
  gramsPerUnit: number | null;
  totalHours: number | null;
  totalGrams: number | null;
  printerIds: string[];
}

interface QueuePrinter {
  id: string;
  name: string;
  brand: string;
  accent: string | null;
  status: string;
  online: boolean;
  busy: boolean;
  currentEtaSec: number | null;
  currentProductName: string | null;
  jobs: QueueJob[];
  queueHours: number;
  queueGrams: number;
  unknownTimeJobs: number;
  finishAt: string | null;
  finishIsPartial: boolean;
}

interface QueuePayload {
  targetStock: number;
  generatedAt: string;
  printers: QueuePrinter[];
  unassigned: QueueJob[];
  totals: {
    products: number;
    prints: number;
    hours: number;
    grams: number;
    unknownTimeJobs: number;
    unknownGramJobs: number;
  };
  filament: {
    neededGrams: number;
    remainingGrams: number;
    enough: boolean;
    spoolCount: number;
    unknownGramJobs: number;
  };
}

const KART = "rounded-2xl bg-card ring-1 ring-white/[0.07] shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_18px_40px_-28px_rgba(0,0,0,0.8)]";
/** Bölümlü seçici (Liste/Kuyruk, Sabit/Satışa göre, öncelik). */
const SECICI = "flex w-fit items-center gap-0.5 rounded-xl bg-white/[0.03] p-0.5 ring-1 ring-white/[0.08]";
const secenek = (aktif: boolean) =>
  cn(
    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all duration-200 active:scale-[0.97]",
    aktif
      ? "bg-[#7A7EFF]/20 text-[#E4E7FF] ring-1 ring-[#7A7EFF]/45 shadow-[0_6px_18px_-10px_rgba(122,126,255,0.9)]"
      : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
  );
const ROZET = "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] tabular-nums";
const BAS_DUGMESI = "shrink-0 gap-1.5 rounded-xl border-white/[0.1] bg-white/[0.03] transition hover:border-[#7A7EFF]/45 hover:bg-[#7A7EFF]/10 active:scale-[0.97]";

function OzetKutusu({ sira, ikon, baslik, children }: { sira: number; ikon: React.ReactNode; baslik: string; children: React.ReactNode }) {
  return (
    <div
      className="group relative flex min-w-0 flex-col justify-between overflow-hidden rounded-2xl bg-card p-4 ring-1 ring-white/[0.07] transition-[transform,box-shadow] duration-300 hover:-translate-y-0.5 hover:ring-white/[0.12] hover:shadow-[0_20px_40px_-30px_rgba(122,126,255,0.55)] animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-500 motion-reduce:animate-none motion-reduce:hover:translate-y-0"
      style={{ animationDelay: `${sira * 60}ms` }}
    >
      <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span className="grid size-7 place-items-center rounded-lg bg-white/[0.05] text-[#C9D2F2] ring-1 ring-white/[0.08] transition-colors group-hover:bg-[#7A7EFF]/15">
          {ikon}
        </span>
        {baslik}
      </span>
      <div className="mt-3 min-w-0">{children}</div>
    </div>
  );
}

/** Öncelik: makine saati başına kazanç, satış hızı ya da en büyük stok açığı. */
type PriorityMode = "profit" | "velocity" | "shortage";
const ONCELIKLER: readonly PriorityMode[] = ["profit", "velocity", "shortage"];
/** Görünüm: düz liste ya da yazıcıya göre kuyruk. */
type ViewMode = "list" | "queue";

/** Sıralamanın baktığı alanlar — hem düz liste hem kuyruk satırları bu şekle uyar. */
interface Sortable {
  stock: number;
  printQty: number;
  profitPerHour: number | null;
  sales: SalesInsight | null;
}

/** Seçilen önceliğe göre iki satırı karşılaştırır (liste ve kuyruk AYNI kuralı kullanır). */
function comparePriority(mode: PriorityMode, a: Sortable, b: Sortable): number {
  if (mode === "shortage") {
    // En büyük açık başta; eşitse stoğu az olan, sonra saat başına çok kazandıran.
    if (a.printQty !== b.printQty) return b.printQty - a.printQty;
    if (a.stock !== b.stock) return a.stock - b.stock;
    return (b.profitPerHour ?? -Infinity) - (a.profitPerHour ?? -Infinity);
  }
  if (mode === "velocity") {
    // Satış hızı: penceredeki adedi en yüksek olan başta. Hiç satmayanlar sona düşer;
    // aralarında stoğu en az olan öne gelir.
    const av = a.sales?.soldInWindow ?? 0;
    const bv = b.sales?.soldInWindow ?? 0;
    if (av !== bv) return bv - av;
    const ad = a.sales?.daysSinceLastSale ?? Number.POSITIVE_INFINITY;
    const bd = b.sales?.daysSinceLastSale ?? Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return a.stock - b.stock;
  }
  // Makine saati başına en çok kazandıran önce. Baskı süresi girilmemiş ürünler (kâr/saat
  // bilinmiyor) sona düşer, kendi aralarında stoğu en az olan başta kalır.
  const av = a.profitPerHour;
  const bv = b.profitPerHour;
  if (av != null && bv != null && av !== bv) return bv - av;
  if (av != null && bv == null) return -1;
  if (av == null && bv != null) return 1;
  return a.stock - b.stock;
}

/** 2,5 → "2 sa 30 dk". Kısa işlerde yalnız dakika. */
function hoursText(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "0 dk";
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} dk`;
  if (m === 0) return `${h} sa`;
  return `${h} sa ${m} dk`;
}

const timeFmt = new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit" });
const dayTimeFmt = new Intl.DateTimeFormat("tr-TR", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** Bitiş anını okunur yaz: bugünse saat, yarınsa "yarın 09:15", sonrası tam tarih. */
function finishText(at: number, now = Date.now()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "—";
  const today = new Date(now);
  const dayDiff = Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() -
      new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      86_400_000
  );
  if (dayDiff === 0) return timeFmt.format(date);
  if (dayDiff === 1) return `yarın ${timeFmt.format(date)}`;
  return dayTimeFmt.format(date);
}

const PRINTER_STATUS: Record<string, { label: string; cls: string }> = {
  printing: { label: "Yazdırıyor", cls: "bg-[#4F8CFF]/12 text-[#A9C4FF] border-[#4F8CFF]/30" },
  paused: { label: "Duraklatıldı", cls: "bg-[#7A7EFF]/15 text-[#C9D2F2] border-[#7A7EFF]/30" },
  finished: { label: "Baskı bitti", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  idle: { label: "Hazır", cls: "bg-emerald-500/10 text-emerald-300 border-emerald-500/25" },
  error: { label: "Hata", cls: "bg-rose-500/15 text-rose-300 border-rose-400/30" },
  offline: { label: "Bağlı değil", cls: "bg-muted text-muted-foreground border-border" },
};

function printerStatusLabel(printer: QueuePrinter): { label: string; cls: string } {
  if (!printer.online) return { label: "Bağlı değil", cls: "bg-muted text-muted-foreground border-border" };
  return PRINTER_STATUS[printer.status] ?? { label: "Durum bilinmiyor", cls: "bg-muted text-muted-foreground border-border" };
}

export default function PlannerPage() {
  const qc = useQueryClient();
  const LISTE_ANAHTARI = ["products", "active"] as const;
  const {
    data,
    isLoading,
    isError: urunHatasi,
    isFetching: urunCekiliyor,
    refetch: urunleriYenidenCek,
    dataUpdatedAt,
  } = useQuery<ProductRow[]>({
    // Ürünler sayfasıyla AYNI anahtar ve AYNI okuma: gövdenin hesaplandığı an kaydedilir, sunucu
    // diskten bayat gövde verdiyse liste kendiliğinden bir kez daha çekilir (denetim, 23 Kas 2026).
    queryKey: LISTE_ANAHTARI,
    queryFn: ({ signal }) => urunListesiGetir<ProductRow[]>(qc, LISTE_ANAHTARI, "/api/products?filter=active", signal),
    staleTime: Infinity,
    // Başka ekranda gizlenen / maliyeti değişen ürün dönüşte görünsün (yalnız bayatsa çekilir).
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    networkMode: "always",
  });
  // Basılacak adet stoğa bağlı: telefonda değişen stok da hesaba girsin (tek küçük sorgu).
  // Başlangıç gövdenin HESAPLANDIĞI an — istemcinin yanıtı aldığı an değil.
  const govdeAni = listeZamani(LISTE_ANAHTARI);
  useFreshStocks(govdeAni ? Math.min(govdeAni, dataUpdatedAt || govdeAni) : dataUpdatedAt || undefined, govdeAni);
  const products = useMemo(() => (Array.isArray(data) ? data : []), [data]);

  // Satış geçmişi ayrı ve hafif bir uçtan gelir → ürün listesini bekletmez.
  const {
    data: insights,
    isError: hizHatasi,
    isFetching: hizCekiliyor,
    refetch: hiziYenidenCek,
  } = useQuery<SalesInsights>({
    queryKey: ["planner-insights"],
    queryFn: () => fetchJson("/api/planner/insights"),
    staleTime: 5 * 60_000,
    refetchOnMount: true,
  });
  const insightById = useMemo(() => {
    const map = new Map<string, SalesInsight>();
    for (const item of insights?.items ?? []) map.set(item.productId, item);
    return map;
  }, [insights]);

  const velocityReady = insights?.ready ?? false;
  const deadStockReady = insights?.deadStockReady ?? false;

  // Hedef stok DB'de (AppSetting) saklanır → masaüstü/telefon senkron
  const {
    data: settings,
    isError: ayarHatasi,
    refetch: ayarlariYenidenCek,
  } = useQuery<Record<string, string>>({
    queryKey: ["app-settings"],
    queryFn: () => fetchJson("/api/settings"),
    staleTime: 60_000,
    refetchOnMount: true,
  });
  const savedTarget = parseTavan(settings?.plannerTargetStock);
  const [override, setOverride] = useState<number | null>(null);
  const target = override ?? savedTarget;

  /**
   * Hedef modu — sabit mi, satış hızına göre mi.
   *
   * Sabit hedef ölçülebilir biçimde uygulanamaz bir plan üretiyordu: 129 ürün, 69 kg filament
   * (elde 34 kg) ve 4 yazıcıda 25 gün kesintisiz baskı. Talep modunda aynı veriyle plan
   * 51 ürün / 24 kg'a iniyor ve ölçülen dönemde hiç satmayan 67 ürün plana hiç girmiyor.
   */
  const savedMod = parseHedefModu(settings?.plannerTargetMode);
  const savedKapsam = parseKapsamGun(settings?.plannerCoverDays);
  const [modOverride, setModOverride] = useState<HedefModu | null>(null);
  const [kapsamOverride, setKapsamOverride] = useState<number | null>(null);
  const mod = modOverride ?? savedMod;
  const kapsamGun = kapsamOverride ?? savedKapsam;
  /**
   * HESAPTA KULLANILAN mod. "Satışa göre" seçiliyken:
   *  - satış verisi henüz gelmediyse plan BEKLER (eskiden her hedef 0 çıkıyor, ekran "Üretim
   *    gerekmiyor 🎉" diyordu),
   *  - geçmiş yetersizse (ready=false) sabit hedef kullanılır — kuyruk ucu da aynısını yapar.
   */
  const talepBekliyor = mod === "talep" && !insights && !hizHatasi;
  const etkinMod: HedefModu = mod === "talep" && insights?.ready ? "talep" : "sabit";
  const hedefAyari: HedefAyari = useMemo(
    () => ({ mod: etkinMod, tavan: target, kapsamGun }),
    [etkinMod, target, kapsamGun]
  );

  // Sıra ve süzgeç kullanıcının seçimi — varsayılan MEVCUT davranıştır (kâr/saat, hepsi görünür).
  // Bu cihazda hatırlanır: eskiden her açılışta sıfırlanıyordu (hedef ve mod DB'de saklanırken).
  const [priority, setPriority] = useKaliciSecim<PriorityMode>("mlhub-uretim-sira", "profit", ONCELIKLER);
  const [gizleSecimi, setGizleSecimi] = useKaliciSecim("mlhub-uretim-satmayan-gizle", "0", ["0", "1"] as const);
  const hideDeadStock = gizleSecimi === "1";
  const [view, setView] = useState<ViewMode>("list");

  // Yazıcı kuyruğu yalnız o görünüm açılınca çekilir — her sorgu süreç genelinde sıraya
  // girdiği için listeye bakan kullanıcıya ek yük bindirmeyelim.
  const {
    data: queue,
    isLoading: queueLoading,
    isError: kuyrukHatasi,
    isFetching: kuyrukCekiliyor,
    refetch: kuyruguYenidenCek,
  } = useQuery<QueuePayload>({
    // Anahtar hedef kuralının TAMAMINI taşır: mod ya da kapsam değişince kuyruk yeniden
    // çekilmeli, yoksa ekranda eski kuralla hesaplanmış iş listesi kalır.
    queryKey: ["planner-queue", target, mod, kapsamGun],
    queryFn: () =>
      fetchJson(`/api/planner/queue?target=${target}&mod=${mod}&kapsam=${kapsamGun}`),
    staleTime: 60_000,
    refetchOnMount: true,
    // Yazıcı durumu ve "boşta bekleyen" önerisi taze kalsın: pencere görünürken dakikada bir.
    refetchInterval: () => (pencereGizliMi() ? false : 60_000),
    // Kayıtlı hedef/mod gelmeden ÇEKME: önce varsayılan ayarla (5 · sabit) bir kez boşuna
    // hesaplanıp (~1,1 sn) sonra asıl ayarla yeniden hesaplanıyordu (9 Eki 2026 ölçümü).
    enabled: settings !== undefined,
    // Görünümden BAĞIMSIZ çekiliyor: "boştaki yazıcıya ne basayım" önerisi sayfanın en
    // üstünde, liste görünümünde de duruyor. Sunucuda 20 sn'lik önbelleği var, ayrı sorgu
    // olduğu için ürün listesini bekletmez.
  });

  // Yenile: stok/maliyet başka bir cihazda veya senkronla değişmiş olabilir → listeyi tazele.
  // İlerleme GERÇEK: tamamlanan tazeleme sayısı ekrana yansır, sahte animasyon yok.
  const [refreshProgress, setRefreshProgress] = useState<{ done: number; total: number } | null>(null);
  const refreshing = refreshProgress != null;
  const refresh = async () => {
    if (refreshing) return;
    const tasks = [
      qc.invalidateQueries({ queryKey: ["products"] }),
      qc.invalidateQueries({ queryKey: ["app-settings"] }),
      qc.invalidateQueries({ queryKey: ["planner-insights"] }),
      qc.invalidateQueries({ queryKey: ["planner-queue"] }),
    ];
    setRefreshProgress({ done: 0, total: tasks.length });
    try {
      await Promise.all(
        tasks.map((task) =>
          task.then(() =>
            setRefreshProgress((p) => (p ? { ...p, done: p.done + 1 } : p))
          )
        )
      );
    } finally {
      setRefreshProgress(null);
    }
  };
  // Baskı modalı — Ürünler sayfasındakiyle AYNI akış (yazıcı seçimi + Snapmaker/Bambu renk + başlat).
  const [printTarget, setPrintTarget] = useState<{ id: string; name: string } | null>(null);
  const saveTarget = useMutation({
    mutationFn: (body: Record<string, string>) =>
      fetchJson("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app-settings"] }),
    // Kayıt düşerse ekran yeni değeri göstermeye devam etmesin: kayıtlı değere dön, söyle.
    onError: () => {
      setOverride(null);
      setModOverride(null);
      setKapsamOverride(null);
      toast.error("Ayar kaydedilemedi");
    },
  });
  /** Hedef kutusunun yazılan metni — her tuşta değil, odaktan çıkınca / Enter'da kaydedilir. */
  const [hedefMetni, setHedefMetni] = useState<string | null>(null);
  // Kayıtlı hedef değişince (başka cihaz / kayıt sonrası) yazılan taslak bırakılır.
  const [izlenenHedef, setIzlenenHedef] = useState(savedTarget);
  if (izlenenHedef !== savedTarget) {
    setIzlenenHedef(savedTarget);
    setHedefMetni(null);
  }
  const hedefiKaydet = () => {
    if (hedefMetni == null) return;
    const v = parseTavan(hedefMetni, target);
    setHedefMetni(null);
    if (v === target) return;
    setOverride(v);
    saveTarget.mutate({ plannerTargetStock: String(v) });
  };

  /** Süzgeçten ÖNCEKİ plan satırları — rozet sayıları buradan çıkar. */
  const planRows = useMemo(() => {
    const olculenGun = insights?.measuredDays ?? 0;
    return products
      // "Sipariş üzerine üretilir" ürünler stok tutmaz → üretim planına girmez.
      .filter((p) => !p.madeToOrder)
      .map((p) => {
        const sales = insightById.get(p.id) ?? null;
        // Hedef ürün başına: talep modunda satış hızından çıkar, satmayan üründe 0 olur.
        // Kuyruk ucu AYNI kuralı sunucuda uyguluyor (`@/core/planner-target`) — iki ekran
        // farklı hedef hesaplarsa aynı ürün için iki ayrı "kaç adet basmalı" görünürdü.
        const hedef = hedefStok(hedefAyari, gunlukSatis(sales?.soldInWindow ?? 0, olculenGun));
        const printQty = basilacakAdet(hedef, p.stock);
        const gramPer = p.cost?.filamentWeight ?? 0;
        // Satış listesinde hiç görünmeyen ürün, pencerede hiç satmamış demektir. Bunu ancak
        // elimizde o kadar geçmiş varsa "ölü stok" saymaya hakkımız var.
        const deadStock = deadStockReady && (sales == null || sales.deadStock);
        return { ...p, hedef, printQty, filament: printQty * gramPer, gramPer, sales, deadStock };
      })
      // Hedefine ulaşmış (ya da talep modunda hedefi 0 olan) ürün plana girmez.
      .filter((p) => p.printQty > 0);
  }, [products, insights, insightById, hedefAyari, deadStockReady]);

  const plan = useMemo(() => {
    const visible = hideDeadStock ? planRows.filter((p) => !p.deadStock) : planRows;
    const mode = priority === "velocity" && !velocityReady ? "profit" : priority;
    return [...visible].sort((a, b) => comparePriority(mode, a, b));
  }, [planRows, hideDeadStock, priority, velocityReady]);

  const totalFilament = plan.reduce((s, p) => s + p.filament, 0);
  const totalPrints = plan.reduce((s, p) => s + p.printQty, 0);
  /**
   * Süzgeç açılınca listeden düşecek ürün sayısı.
   * SÜZÜLMEMİŞ satırlardan sayılır — süzgeç açıkken `plan` bunları zaten elediği için
   * oradan sayılsa rozet hep 0 gösterirdi.
   */
  const deadStockCount = useMemo(
    () => (deadStockReady ? planRows.filter((p) => p.deadStock).length : 0),
    [planRows, deadStockReady]
  );

  // Kuyruk satırları kâr/saat ve satış hızını ürün listesinden ödünç alır → aynı sıralama
  // düğmeleri kuyruk içinde de çalışır.
  const productById = useMemo(() => {
    const map = new Map<string, ProductRow>();
    for (const p of products) map.set(p.id, p);
    return map;
  }, [products]);

  const sortJobs = useMemo(() => {
    const mode = priority === "velocity" && !velocityReady ? "profit" : priority;
    const key = (job: QueueJob): Sortable => ({
      stock: job.stock,
      printQty: job.quantity,
      profitPerHour: productById.get(job.productId)?.profitPerHour ?? null,
      sales: insightById.get(job.productId) ?? null,
    });
    return (jobs: QueueJob[]) => [...jobs].sort((a, b) => comparePriority(mode, key(a), key(b)));
  }, [priority, velocityReady, productById, insightById]);

  // Kuyruk, listenin gösterdiği işlerle AYNI olmalı: "satmayanları gizle" açıkken gizlenen
  // ürünler kuyruktan da düşer ve süre/filament toplamları kalanlara göre yeniden çıkar
  // (yoksa ekranda gizlenmiş ürünün süresi görünmeye devam ederdi).
  const visibleQueue = useMemo(() => {
    if (!queue) return null;
    const allowed = hideDeadStock ? new Set(plan.map((p) => p.id)) : null;
    const keep = (job: QueueJob) => allowed == null || allowed.has(job.productId);
    const printers = queue.printers.map((printer) => ({
      ...printer,
      jobs: sortJobs(printer.jobs.filter(keep)),
    }));
    const unassigned = sortJobs(queue.unassigned.filter(keep));
    let hours = 0;
    let grams = 0;
    for (const job of [...printers.flatMap((p) => p.jobs), ...unassigned]) {
      hours += job.totalHours ?? 0;
      grams += job.totalGrams ?? 0;
    }
    return {
      printers,
      unassigned,
      hours,
      neededGrams: grams,
      remainingGrams: queue.filament.remainingGrams,
      enough: queue.filament.remainingGrams >= grams,
      generatedAtMs: Date.parse(queue.generatedAt),
    };
  }, [queue, hideDeadStock, plan, sortJobs]);

  /**
   * BOŞTA BEKLEYEN YAZICILAR — sayfanın asıl günlük sorusu.
   *
   * Ekran "129 ürünün eksik" diyordu; oysa masa başındaki soru "yazıcı boşaldı, ne basayım".
   * Burada her boş yazıcı için, O YAZICIDA basılabilen (dosyası olan) en öncelikli iş tek
   * satırda öneriliyor. Sıra kullanıcının seçtiği önceliğe göre — kuyruk zaten öyle sıralı.
   *
   * "Boş" = bağlı VE baskı yapmıyor. Bağlı olmayan yazıcı için öneri vermek anlamsız:
   * kullanıcı gidip elle başlatamaz.
   */
  /**
   * Plan kaç GÜN makine zamanı ister — tüm yazıcılar kesintisiz çalışsa.
   *
   * "2400 saat" rakamı tek başına büyüklüğü anlatmıyordu. Dört yazıcıya bölününce 25 gün
   * çıkıyor ve planın uygulanabilir olup olmadığı bir bakışta görülüyor.
   * Süresi girilmemiş işler toplama girmediği için bu bir ALT SINIR.
   */
  /** Süresi bilinmeyen kuyruk işi — süre toplamı bir ALT SINIR olur. */
  const bilinmeyenSureli = useMemo(
    () => (visibleQueue ? [...visibleQueue.printers.flatMap((p) => p.jobs), ...visibleQueue.unassigned].filter((j) => j.totalHours == null).length : 0),
    [visibleQueue]
  );
  const makineGunu = useMemo(() => {
    const yaziciSayisi = visibleQueue?.printers.length ?? 0;
    if (!visibleQueue || yaziciSayisi === 0 || visibleQueue.hours <= 0) return null;
    return visibleQueue.hours / (yaziciSayisi * 24);
  }, [visibleQueue]);

  /** Baskı dosyası olmayan ürünler — liste görünümünde de rozetle görünsünler. */
  const dosyasizIds = useMemo(
    () => new Set((queue?.unassigned ?? []).map((job) => job.productId)),
    [queue]
  );

  const bostaOneriler = useMemo(() => {
    if (!visibleQueue) return [];
    return visibleQueue.printers
      .filter((p) => p.online && p.status === "idle" && p.jobs.length > 0)
      .map((p) => ({ printer: p, job: p.jobs[0] }));
  }, [visibleQueue]);

  /**
   * Tek satırlık ipucu.
   *
   * Geçmiş yetersizken rakam uydurmak yerine bunu gösteririz. Talep modunda ise kuralın
   * neye dayandığını söyler: plan bir anda küçüldüğünde "ürünlerim nereye gitti" sorusunun
   * cevabı ekranda olsun.
   */
  const hint = hizHatasi
    ? "Satış hızı şu an okunamadı — sabit hedef kullanılıyor."
    : !insights
      ? null
      : !insights.ready
        ? `Satış hızı için yeterli satış geçmişi yok — yaklaşık ${insights.readyInDays} gün sonra kullanılabilir${mod === "talep" ? "; şimdilik sabit hedef kullanılıyor" : ""}.`
        : mod === "talep"
          ? `Son ${insights.measuredDays} günün satışına göre ${kapsamGun} günlük stok hedefleniyor; bu sürede hiç satmayan ürün plana girmiyor.`
          : null;

  /** Gramı / süresi bilinmeyen plan satırları — toplamlar bu kadar EKSİK (BİLİNMEYEN ≠ SIFIR). */
  const gramsizUrun = plan.filter((p) => !(p.gramPer > 0)).length;

  return (
    <div className="p-6 space-y-5 mx-auto w-full max-w-[1400px]">
      <header className="flex flex-wrap items-end justify-between gap-4 animate-in fade-in slide-in-from-top-2 duration-500 motion-reduce:animate-none">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-[#9B5CFF] to-[#4F8CFF] text-white shadow-[0_12px_30px_-12px_rgba(122,126,255,0.9)]">
            <Factory className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Üretim Planı</h1>
            <p className="text-xs text-muted-foreground">
              Stoğu hedefin altındaki ürünler — <span className="font-medium text-foreground">Bas</span> ile istediğini hemen yazıcıya gönder.
            </p>
          </div>
        </div>
        <div className="shrink-0 flex items-end gap-2">
          {/* Etiket "Hedef stok" ↔ "En fazla" arasında değişiyor; genişlik sabitlenmezse
              mod değiştirildiğinde yanındaki Yenile düğmesi de kayıyor. */}
          <div className="w-[84px]">
            <Label className="text-[11px] text-muted-foreground whitespace-nowrap">
              {mod === "talep" ? "En fazla" : "Hedef stok"}
            </Label>
            <Input
              inputMode="numeric"
              value={hedefMetni ?? String(target)}
              onChange={(e) => setHedefMetni(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
              onBlur={hedefiKaydet}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setHedefMetni(null);
              }}
              className="h-9 w-20 rounded-xl border-white/[0.08] bg-white/[0.03] tabular-nums dark:bg-white/[0.03] focus-visible:border-[#7A7EFF]/50 focus-visible:ring-[#7A7EFF]/25"
              title={
                mod === "talep"
                  ? "Hızlı satan üründe bile stok bu sayıyı geçmez"
                  : "Her ürün için hedeflenen stok"
              }
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-9 rounded-xl border-white/[0.1] bg-white/[0.03] transition active:scale-[0.97]"
            onClick={() => void refresh()}
            disabled={refreshing}
            title="Stok ve maliyetleri yeniden çek"
          >
            <RefreshCw className={cn("h-4 w-4 mr-1.5", refreshing && "animate-spin")} />
            {refreshing ? "Yenileniyor…" : "Yenile"}
          </Button>
        </div>
      </header>

      {/* Yenileme ilerlemesi — kaç adım bittiği gerçekten sayılır. */}
      {refreshProgress && (
        <div className="space-y-1 animate-in fade-in duration-200">
          <Progress value={(refreshProgress.done / refreshProgress.total) * 100} className="h-1.5" />
          <p className="text-[11px] text-muted-foreground tabular-nums">
            Yenileniyor · {refreshProgress.done}/{refreshProgress.total}
          </p>
        </div>
      )}

      {/* Görünüm: düz liste ↔ yazıcı kuyruğu */}
      <div className="flex flex-wrap items-center gap-2">
        <div className={SECICI}>
          {([
            { id: "list" as const, icon: List, label: "Liste" },
            { id: "queue" as const, icon: Layers, label: "Yazıcı kuyruğu" },
          ]).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setView(tab.id)}
              className={secenek(view === tab.id)}
            >
              <tab.icon className="h-3.5 w-3.5" /> {tab.label}
            </button>
          ))}
        </div>

        {/* Hedef kuralı: herkese aynı sayı mı, satış hızına göre mi. */}
        <div className={SECICI}>
          {([
            { id: "sabit" as const, label: "Sabit hedef", hint: "Her ürün için aynı sayı" },
            {
              id: "talep" as const,
              label: "Satışa göre",
              hint: velocityReady
                ? "Hızlı satana çok, yavaş satana az; satmayana hiç"
                : "Yeterli satış geçmişi birikince açılır",
            },
          ]).map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={option.id === "talep" && !velocityReady}
              onClick={() => {
                setModOverride(option.id);
                saveTarget.mutate({ plannerTargetMode: option.id });
              }}
              title={option.hint}
              className={cn(secenek(mod === option.id), option.id === "talep" && !velocityReady && "cursor-not-allowed opacity-40")}
            >
              {option.label}
            </button>
          ))}
        </div>

        {/* Talep modunda tek ayar: kaç günlük satışı stokta tutalım. */}
        {mod === "talep" && (
          <div className="flex items-center gap-1.5 animate-in fade-in slide-in-from-left-1 duration-200">
            <span className="text-[11px] text-muted-foreground">Kaç günlük satış:</span>
            <div className={SECICI}>
              {KAPSAM_SECENEKLERI.map((gun) => (
                <button
                  key={gun}
                  type="button"
                  onClick={() => {
                    setKapsamOverride(gun);
                    saveTarget.mutate({ plannerCoverDays: String(gun) });
                  }}
                  className={cn(secenek(kapsamGun === gun), "px-2.5 py-1 text-xs tabular-nums")}
                >
                  {gun} gün
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Sıra + satmayan ürün süzgeci — ikisi de kullanıcının seçimi, varsayılan hiçbir şeyi değiştirmez. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className={SECICI}>
          <button
            type="button"
            onClick={() => setPriority("profit")}
            className={secenek(priority === "profit")}
            title="Baskı saati başına en çok kazandıran önce"
          >
            <Timer className="h-3.5 w-3.5" /> Kâr/saat
          </button>
          <button
            type="button"
            onClick={() => setPriority("shortage")}
            className={secenek(priority === "shortage")}
            title="Stoğu hedeften en çok geride kalan önce"
          >
            <Package className="h-3.5 w-3.5" /> Stok açığı
          </button>
          <button
            type="button"
            onClick={() => velocityReady && setPriority("velocity")}
            disabled={!velocityReady}
            className={cn(secenek(priority === "velocity"), !velocityReady && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground")}
            title={
              velocityReady
                ? "En çok satan ürün önce"
                : hizHatasi
                  ? "Satış hızı şu an okunamadı"
                  : "Yeterli satış geçmişi birikince açılır"
            }
          >
            <Zap className="h-3.5 w-3.5" /> Satış hızı
          </button>
        </div>

        <Button
          variant="outline"
          size="sm"
          disabled={!deadStockReady}
          onClick={() => setGizleSecimi(hideDeadStock ? "0" : "1")}
          className={cn(
            "h-9 gap-1.5 rounded-xl transition-all active:scale-[0.97]",
            hideDeadStock
              ? "border-0 bg-[#7A7EFF]/20 text-[#E4E7FF] ring-1 ring-[#7A7EFF]/45 hover:bg-[#7A7EFF]/25"
              : "border-white/[0.1] bg-white/[0.03]"
          )}
          title={
            deadStockReady
              ? `${insights?.deadStockDays ?? 90} gündür satmayan ürünleri listeden çıkar`
              : "Yeterli satış geçmişi birikince açılır"
          }
        >
          <Snowflake className="h-3.5 w-3.5" />
          {/* Süre ancak satış geçmişi okununca bilinir. Önce "90" yazıp sonra "21"e dönmek
              düğmenin genişliğini değiştirip komşularını oynatıyordu. */}
          {insights ? `${insights.deadStockDays} gündür satmayanları gizle` : "Satmayanları gizle"}
          {deadStockReady && deadStockCount > 0 && (
            <span className="ml-0.5 rounded-full bg-foreground/10 px-1.5 text-[11px] font-semibold tabular-nums">
              {deadStockCount}
            </span>
          )}
        </Button>
      </div>

      {/* İpucu KENDİ satırında ve yeri hep ayrılmış duruyor.
          Öncelik düğmeleriyle aynı satırdayken, mod değiştirince beliren metin satırı
          taşırıp altındaki bütün listeyi aşağı kaydırıyordu. */}
      <div className="min-h-[24px] -mt-2">
        {hint && (
          <span className="inline-flex items-start gap-1.5 text-[11px] text-muted-foreground animate-in fade-in duration-300">
            <Info className="h-3.5 w-3.5 shrink-0 mt-px" />
            {hint}
            {hizHatasi && (
              <button
                type="button"
                className="ml-1 font-medium text-[#A9AEFF] hover:underline disabled:opacity-50"
                disabled={hizCekiliyor}
                onClick={() => void hiziYenidenCek()}
              >
                Tekrar dene
              </button>
            )}
          </span>
        )}
      </div>

      {isLoading || talepBekliyor ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[60px] w-full rounded-xl" />
          ))}
        </div>
      ) : urunHatasi && !data ? (
        <HataKarti
          baslik="Ürünler yüklenemedi"
          yukleniyor={urunCekiliyor}
          onRetry={() => void urunleriYenidenCek()}
        />
      ) : plan.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="Üretim gerekmiyor 🎉"
          description={
            hideDeadStock
              ? "Satmaya devam eden ürünlerin stoğu yeterli. Gizlenenleri görmek için süzgeci kapat."
              : etkinMod === "talep"
                ? "Satış hızına göre stoklar yeterli. Acil basılacak bir şey yok."
                : `Tüm aktif ürünlerin stoğu hedefin (${target}) üzerinde. Acil basılacak bir şey yok.`
          }
        />
      ) : (
        <>
          {/* Filament yetmezliği — LİSTE görünümünde de görünür.
              Eskiden yalnız kuyruk sekmesindeydi; varsayılan sekme liste olduğu için
              "69 kg filament" yazısı, elde 34 kg varken uyarısız duruyordu. */}
          {visibleQueue && !visibleQueue.enough && (
            <Card className="rounded-2xl border-0 bg-[#7A7EFF]/[0.07] ring-1 ring-[#7A7EFF]/30 animate-in fade-in slide-in-from-bottom-1 duration-300">
              <CardContent className="py-2.5 flex items-center gap-2 text-sm text-[#E4E7FF]">
                <Disc3 className="h-4 w-4 text-[#A9AEFF] shrink-0" />
                <span>
                  Bu plan {gramsizUrun > 0 ? "en az" : "~"}{formatNumber(visibleQueue.neededGrams / 1000, 1)} kg filament ister,
                  makaralarda ~{formatNumber(visibleQueue.remainingGrams / 1000, 1)} kg kaldı.
                </span>
                <Link
                  href="/spools"
                  className="ml-auto shrink-0 text-xs font-medium text-[#A9AEFF] hover:underline"
                >
                  Makaralar
                </Link>
              </CardContent>
            </Card>
          )}

          {/* Özet — SABİT DÖRT SÜTUN.
              Eskiden `flex-wrap` idi: sayılar 0'dan hedefe akarken metin genişliği her karede
              değişiyor, öğeler satır atlayıp yerinden oynuyordu (kullanıcı "yazıların yerleri
              değişiyor" diye bildirdi). Izgarada her rakam kendi hücresinde büyür; komşusunu
              itmez. Dördüncü hücre kuyruk verisi gelmeden de DURUR, yalnız içi sonra dolar —
              yoksa kart yükseklik değiştirip altındaki listeyi aşağı kaydırıyordu. */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <OzetKutusu sira={0} ikon={<Factory className="size-3.5" />} baslik="Basılacak ürün">
              <p className="text-2xl font-semibold tracking-tight tabular-nums">
                <AnimatedNumber value={plan.length} />
              </p>
            </OzetKutusu>
            <OzetKutusu sira={1} ikon={<Package className="size-3.5" />} baslik="Toplam baskı">
              <p className="text-2xl font-semibold tracking-tight tabular-nums">
                <AnimatedNumber value={totalPrints} />
              </p>
            </OzetKutusu>
            <OzetKutusu sira={2} ikon={<Disc3 className="size-3.5" />} baslik="Filament">
              <p className="text-2xl font-semibold tracking-tight tabular-nums">
                {gramsizUrun > 0 ? "≥" : "~"}<AnimatedNumber value={totalFilament / 1000} format={(n) => formatNumber(n, 1)} />
                <span className="text-base font-medium text-muted-foreground"> kg</span>
              </p>
              {gramsizUrun > 0 && (
                <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">{gramsizUrun} üründe gramaj girilmemiş</p>
              )}
            </OzetKutusu>
            <OzetKutusu sira={3} ikon={<Clock className="size-3.5" />} baslik="Baskı süresi">
              <p className="text-2xl font-semibold tracking-tight tabular-nums">
                {visibleQueue && visibleQueue.hours > 0 ? (
                  <>{bilinmeyenSureli > 0 ? "≥" : "~"}<AnimatedNumber value={visibleQueue.hours} format={hoursText} /></>
                ) : kuyrukHatasi && !queue ? (
                  <span className="text-base font-medium text-muted-foreground">okunamadı</span>
                ) : (
                  <span className="text-muted-foreground/50">—</span>
                )}
              </p>
              {/* Saat tek başına büyüklüğü anlatmıyor: makine sayısına bölününce plan gerçek boyutunu gösteriyor. */}
              {makineGunu != null && (
                <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                  tüm yazıcılarla {bilinmeyenSureli > 0 ? "en az " : "≈"}{formatNumber(makineGunu, makineGunu < 10 ? 1 : 0)} gün
                </p>
              )}
            </OzetKutusu>
          </div>

          {/* Boştaki yazıcılar — listenin de kuyruğun da üstünde, tek tıkla başlat. */}
          {bostaOneriler.length > 0 && (
            <Card className="rounded-2xl border-0 bg-emerald-500/[0.05] ring-1 ring-emerald-400/25 animate-in fade-in slide-in-from-bottom-1 duration-300">
              <CardContent className="py-3 space-y-2">
                <p className="text-sm font-semibold flex items-center gap-1.5">
                  <Printer className="h-4 w-4 text-emerald-300" />
                  Boşta bekleyen yazıcı
                  <span className="rounded-full bg-foreground/10 px-1.5 text-[11px] font-semibold tabular-nums">
                    {bostaOneriler.length}
                  </span>
                </p>
                {bostaOneriler.map(({ printer, job }, i) => (
                  <div
                    key={printer.id}
                    className="flex items-center gap-2.5 rounded-xl bg-white/[0.03] p-2 ring-1 ring-white/[0.06] transition-colors hover:bg-white/[0.05] animate-in fade-in slide-in-from-left-1 fill-mode-both duration-300"
                    style={{ animationDelay: `${i * 60}ms` }}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: printer.accent ?? "var(--primary)" }}
                      aria-hidden
                    />
                    <span className="text-xs font-medium shrink-0">{printer.name}</span>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/products/${job.productId}`}
                        className="text-sm font-medium hover:underline line-clamp-1"
                      >
                        {job.name}
                      </Link>
                      <p className="text-[11px] text-muted-foreground tabular-nums">
                        {job.quantity} baskı
                        {job.hoursPerUnit != null && ` · ${hoursText(job.hoursPerUnit)}/adet`}
                        {job.stock === 0 && " · stok bitti"}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      className="h-8 shrink-0 gap-1.5 rounded-xl border-0 bg-gradient-to-br from-[#8B6CFF] to-[#5B8CFF] text-white shadow-[0_10px_24px_-12px_rgba(122,126,255,0.95)] transition hover:brightness-110 active:scale-[0.97]"
                      onClick={() => setPrintTarget({ id: job.productId, name: job.name })}
                    >
                      <Printer className="h-3.5 w-3.5" /> Bas
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {view === "queue" ? (
            <QueueView
              queue={visibleQueue}
              loading={queueLoading}
              hata={(kuyrukHatasi || ayarHatasi) && !queue}
              yenileniyor={kuyrukCekiliyor}
              onRetry={() => {
                if (ayarHatasi) void ayarlariYenidenCek();
                void kuyruguYenidenCek();
              }}
              productById={productById}
              onPrint={(id, name) => setPrintTarget({ id, name })}
            />
          ) : (
            <div className="space-y-2">
              {plan.map((p, i) => (
                <Card
                  key={p.id}
                  className={cn(
                    "overflow-hidden rounded-2xl border-0 ring-1 ring-white/[0.07] transition-[box-shadow,transform] duration-200 hover:-translate-y-px hover:ring-white/[0.12] hover:shadow-[0_16px_36px_-26px_rgba(122,126,255,0.6)] motion-reduce:hover:translate-y-0 animate-in fade-in slide-in-from-bottom-2 duration-300",
                    p.deadStock && "opacity-75"
                  )}
                  // Sıralı beliriş; uzun listede beklemeyi uzatmamak için gecikme ilk satırlarla sınırlı.
                  style={{ animationDelay: `${Math.min(i, 12) * 35}ms`, animationFillMode: "both" }}
                >
                  <CardContent className="p-3 flex items-center gap-3">
                    <div className="h-12 w-12 shrink-0 rounded-xl bg-white/[0.04] ring-1 ring-white/[0.07] flex items-center justify-center overflow-hidden">
                      {p.imageUrl ? (
                        <img src={thumbUrl(p.imageUrl) ?? undefined} alt="" className="max-w-full max-h-full object-contain" loading="lazy" />
                      ) : (
                        <Package className="h-5 w-5 text-muted-foreground/40" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <Link href={`/products/${p.id}`} className="text-sm font-medium hover:underline line-clamp-1">
                        {p.name}
                      </Link>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <span
                          className={cn(
                            ROZET,
                            p.stock === 0
                              ? "bg-rose-500/15 text-rose-300 border-rose-400/30"
                              : "bg-[#7A7EFF]/15 text-[#C9D2F2] border-[#7A7EFF]/30"
                          )}
                        >
                          {p.stock === 0 && <AlertTriangle className="h-3 w-3" />}
                          Stok {p.stock}
                        </span>
                        {p.gramPer > 0 && (
                          <span className="text-[11px] text-muted-foreground tabular-nums">{Math.round(p.gramPer)} g/adet</span>
                        )}
                        {p.profitPerHour != null && (
                          <span
                            className={cn(
                              ROZET,
                              "font-medium",
                              p.profitPerHour > 0
                                ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                                : "bg-rose-500/10 text-rose-300 border-rose-400/30"
                            )}
                            title="Baskı saati başına kazanç"
                          >
                            <Timer className="h-3 w-3" />
                            {formatCurrency(p.profitPerHour, { decimals: 0 })}/saat
                          </span>
                        )}
                        {/* Eksik veri rozetleri — bu ürün planda ama BASILAMAZ ya da
                            süresi bilinmediği için sıralamada ve toplamlarda eksik kalıyor.
                            Eskiden bu yalnız kuyruk sekmesinde belliydi. */}
                        {dosyasizIds.has(p.id) && (
                          <Link
                            href="/models"
                            className={cn(ROZET, "font-medium bg-white/[0.04] text-muted-foreground border-white/[0.08] transition-colors hover:text-foreground")}
                            title="Bu ürün için baskı dosyası yüklenmemiş — hiçbir yazıcıya atanamıyor"
                          >
                            <FileBox className="h-3 w-3" /> dosya yok
                          </Link>
                        )}
                        {p.profitPerHour == null && (
                          <Link
                            href={`/products/${p.id}`}
                            className={cn(ROZET, "font-medium bg-white/[0.04] text-muted-foreground border-white/[0.08] transition-colors hover:text-foreground")}
                            title={
                              (p.cost?.printTimeHours ?? 0) > 0
                                ? "Maliyet ya da komisyon eksik — saat başına kazanç hesaplanamıyor"
                                : "Baskı süresi girilmemiş — süre toplamına girmiyor"
                            }
                          >
                            <Timer className="h-3 w-3" /> {(p.cost?.printTimeHours ?? 0) > 0 ? "kâr bilinmiyor" : "süre girilmemiş"}
                          </Link>
                        )}
                        {/* Satış hızı rozetleri — yalnız geçmiş yeterliyken. */}
                        {p.deadStock ? (
                          <span
                            className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full border bg-sky-500/10 text-sky-400 border-sky-500/30"
                            title="Bu ürün uzun süredir satmadı — yeniden basmadan önce düşün"
                          >
                            <Snowflake className="h-3 w-3" />
                            {insights?.deadStockDays ?? 90} gündür satmadı
                          </span>
                        ) : velocityReady && p.sales ? (
                          <span
                            className="inline-flex items-center gap-1 text-[11px] font-medium tabular-nums px-1.5 py-0.5 rounded-full border bg-primary/10 text-primary border-primary/30"
                            title={[
                              `Son ${insights?.recentDays ?? 30} günde ${p.sales.soldRecent} adet`,
                              p.sales.daysPerSale != null
                                ? `ortalama ${formatNumber(p.sales.daysPerSale, 1)} günde bir satıyor`
                                : null,
                            ].filter(Boolean).join(" · ")}
                          >
                            <Zap className="h-3 w-3" />
                            {/* Plan bu pencereye bakıyor — çip de aynısını yazmalı. Eskiden "30 günde
                                0 adet" yazan ürün 77 günlük satışıyla planda duruyordu. */}
                            {insights?.measuredDays ?? 90} günde {p.sales.soldInWindow} adet
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-lg font-bold tabular-nums leading-none bg-gradient-to-br from-[#B79CFF] to-[#7FA8FF] bg-clip-text text-transparent">{p.printQty}</div>
                      <div className="text-[10px] text-muted-foreground">baskı</div>
                      {p.filament > 0 && (
                        <div className="text-[11px] text-muted-foreground tabular-nums mt-0.5">~{Math.round(p.filament)} g</div>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className={BAS_DUGMESI}
                      onClick={() => setPrintTarget({ id: p.id, name: p.name })}
                      title="Bu ürünü bir yazıcıya gönder (yazıcı + renk seç, başlat)"
                    >
                      <Printer className="h-3.5 w-3.5" />
                      Bas
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {printTarget && (
        <ProductPrintModal
          productId={printTarget.id}
          productName={printTarget.name}
          onClose={() => setPrintTarget(null)}
        />
      )}
    </div>
  );
}

/** Kısa hata kartı — veri gelmediyse "üretim yok" değil, bu görünür. */
function HataKarti({ baslik, yukleniyor, onRetry }: { baslik: string; yukleniyor: boolean; onRetry: () => void }) {
  return (
    <div className={cn(KART, "flex flex-col items-center gap-3 bg-rose-500/[0.05] px-4 py-12 text-center ring-rose-400/25 animate-in fade-in duration-300")}>
      <AlertTriangle className="h-8 w-8 text-rose-300/80" />
      <p className="font-medium">{baslik}</p>
      <p className="text-sm text-muted-foreground">Bağlantını kontrol edip tekrar dene.</p>
      <Button variant="outline" size="sm" className="gap-1.5 rounded-xl" disabled={yukleniyor} onClick={onRetry}>
        <RefreshCw className={cn("h-3.5 w-3.5", yukleniyor && "animate-spin")} /> Tekrar dene
      </Button>
    </div>
  );
}

/** Ekranda gösterilen kuyruk — süzgeç uygulandıktan sonraki hâli. */
interface VisibleQueue {
  printers: QueuePrinter[];
  unassigned: QueueJob[];
  hours: number;
  neededGrams: number;
  remainingGrams: number;
  enough: boolean;
  generatedAtMs: number;
}

/** Yazıcıya göre kuyruk: her yazıcının işleri, toplam süresi ve tahmini bitişi. */
function QueueView({
  queue,
  loading,
  hata,
  yenileniyor,
  onRetry,
  productById,
  onPrint,
}: {
  queue: VisibleQueue | null;
  loading: boolean;
  hata: boolean;
  yenileniyor: boolean;
  onRetry: () => void;
  productById: Map<string, ProductRow>;
  onPrint: (id: string, name: string) => void;
}) {
  if (hata) {
    return <HataKarti baslik="Yazıcı kuyruğu yüklenemedi" yukleniyor={yenileniyor} onRetry={onRetry} />;
  }
  if (loading || !queue) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[150px] w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (queue.printers.length === 0) {
    return (
      <EmptyState
        icon={Printer}
        title="Henüz yazıcı yok"
        description="Yazıcılarını ekleyince plan otomatik olarak yazıcılara dağılır."
        action={
          <Link href="/printers" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Yazıcılara git
          </Link>
        }
      />
    );
  }

  const queued = queue.printers.filter((p) => p.jobs.length > 0);
  const empty = queue.printers.filter((p) => p.jobs.length === 0);

  return (
    <div className="space-y-3">
      {/* Filament uyarısı sayfanın üstünde, her iki görünümde birden duruyor — burada
          tekrarlanmıyor ki aynı uyarı kuyruk sekmesinde iki kez görünmesin. */}
      {queued.map((printer, i) => (
        <PrinterQueueCard
          key={printer.id}
          printer={printer}
          index={i}
          generatedAtMs={queue.generatedAtMs}
          productById={productById}
          onPrint={onPrint}
        />
      ))}

      {empty.length > 0 && (
        <p className="text-[11px] text-muted-foreground animate-in fade-in duration-300">
          Kuyruğu boş: {empty.map((p) => p.name).join(", ")}
        </p>
      )}

      {queue.unassigned.length > 0 && (
        <Card
          className="rounded-2xl border-dashed border-white/[0.12] bg-transparent animate-in fade-in slide-in-from-bottom-2 duration-300"
          style={{ animationDelay: `${Math.min(queued.length, 12) * 60}ms`, animationFillMode: "both" }}
        >
          <CardContent className="p-4 space-y-2.5">
            <div className="flex items-center gap-2">
              <FileBox className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm font-semibold">Baskı dosyası yok</p>
              <span className="rounded-full bg-foreground/10 px-1.5 text-[11px] font-semibold tabular-nums">
                {queue.unassigned.length}
              </span>
              <Link href="/models" className="ml-auto text-xs font-medium text-[#A9AEFF] hover:underline">
                Model Kütüphanesi
              </Link>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Bu ürünler için dosya yüklenmedi — hiçbir yazıcıya atanamadı.
            </p>
            <div className="space-y-1.5">
              {queue.unassigned.map((job) => (
                <div key={job.productId} className="flex items-center gap-2.5 rounded-xl bg-white/[0.02] p-2 ring-1 ring-white/[0.06]">
                  <div className="min-w-0 flex-1">
                    <Link href={`/products/${job.productId}`} className="text-sm font-medium hover:underline line-clamp-1">
                      {job.name}
                    </Link>
                    <p className="text-[11px] text-muted-foreground tabular-nums">
                      Stok {job.stock} · {job.quantity} baskı gerekiyor
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function PrinterQueueCard({
  printer,
  index,
  generatedAtMs,
  productById,
  onPrint,
}: {
  printer: QueuePrinter;
  index: number;
  generatedAtMs: number;
  productById: Map<string, ProductRow>;
  onPrint: (id: string, name: string) => void;
}) {
  const status = printerStatusLabel(printer);
  const jobs = printer.jobs;
  // Toplamlar EKRANDAKİ işlerden çıkar — süzgeç bir ürünü gizlediyse süresi de düşer.
  let prints = 0;
  let queueHours = 0;
  let queueGrams = 0;
  let unknownTimeJobs = 0;
  for (const job of jobs) {
    prints += job.quantity;
    if (job.totalHours == null) unknownTimeJobs += 1;
    else queueHours += job.totalHours;
    queueGrams += job.totalGrams ?? 0;
  }
  const finishAtMs =
    queueHours > 0
      ? generatedAtMs + (printer.currentEtaSec ?? 0) * 1000 + queueHours * 3_600_000
      : null;
  return (
    <Card
      className="overflow-hidden rounded-2xl border-0 ring-1 ring-white/[0.07] transition-shadow hover:shadow-[0_18px_40px_-28px_rgba(122,126,255,0.6)] animate-in fade-in slide-in-from-bottom-2 duration-300"
      style={{ animationDelay: `${Math.min(index, 12) * 60}ms`, animationFillMode: "both" }}
    >
      <div className="h-1 w-full" style={{ background: printer.accent || "linear-gradient(90deg,#9B5CFF,#4F8CFF)" }} />
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Printer className="h-4 w-4 text-[#A9AEFF] shrink-0" />
              <p className="font-semibold text-sm truncate">{printer.name}</p>
              <span className={cn("text-[11px] px-1.5 py-0.5 rounded-full border", status.cls)}>
                {status.label}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1 tabular-nums">
              {jobs.length} ürün · {prints} baskı
              {queueGrams > 0 && ` · ~${Math.round(queueGrams)} g`}
            </p>
          </div>
          <div className="text-right shrink-0">
            <div className="text-lg font-bold tabular-nums leading-none bg-gradient-to-br from-[#B79CFF] to-[#7FA8FF] bg-clip-text text-transparent">
              <AnimatedNumber value={queueHours} format={hoursText} />
            </div>
            <div className="text-[10px] text-muted-foreground">kuyruk süresi</div>
          </div>
        </div>

        {/* Tek satır durum özeti: ne zaman biter, neyi bilmiyoruz. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {printer.currentEtaSec != null && (
            <span className="inline-flex items-center gap-1">
              <Timer className="h-3 w-3" />
              Süren baskı{printer.currentProductName ? ` (${printer.currentProductName})` : ""}:{" "}
              {hoursText(printer.currentEtaSec / 3600)} kaldı
            </span>
          )}
          {finishAtMs != null && (
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <Clock className="h-3 w-3" />
              {unknownTimeJobs > 0 ? "En erken bitiş" : "Tahmini bitiş"} {finishText(finishAtMs)}
            </span>
          )}
          {unknownTimeJobs > 0 && (
            <span className="inline-flex items-center gap-1 text-[#C9D2F2]">
              <AlertTriangle className="h-3 w-3" />
              {unknownTimeJobs} üründe baskı süresi girilmemiş
            </span>
          )}
        </div>

        <div className="space-y-1.5">
          {jobs.map((job, i) => {
            const profitPerHour = productById.get(job.productId)?.profitPerHour ?? null;
            return (
              <div
                key={job.productId}
                className="flex items-center gap-2.5 rounded-xl bg-white/[0.02] p-2 ring-1 ring-white/[0.06] transition-colors hover:bg-white/[0.04] animate-in fade-in duration-300"
                style={{ animationDelay: `${Math.min(i, 10) * 25}ms`, animationFillMode: "both" }}
              >
                <span className="flex items-center justify-center h-7 w-7 shrink-0 rounded-lg bg-[#7A7EFF]/15 text-[#C9D2F2] text-xs font-bold tabular-nums">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <Link href={`/products/${job.productId}`} className="text-sm font-medium hover:underline line-clamp-1">
                    {job.name}
                  </Link>
                  <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground tabular-nums">
                    <span className="font-medium text-foreground">{job.quantity} baskı</span>
                    <span>
                      {job.totalHours != null ? hoursText(job.totalHours) : "süre girilmemiş"}
                    </span>
                    {job.totalGrams != null && <span>~{Math.round(job.totalGrams)} g</span>}
                    {profitPerHour != null && (
                      <span className="inline-flex items-center gap-1">
                        <Timer className="h-3 w-3" />
                        {formatCurrency(profitPerHour, { decimals: 0 })}/saat
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className={BAS_DUGMESI}
                  onClick={() => onPrint(job.productId, job.name)}
                  title="Bu ürünü yazıcıya gönder (yazıcı + renk seç, başlat)"
                >
                  <Printer className="h-3.5 w-3.5" />
                  Bas
                </Button>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
