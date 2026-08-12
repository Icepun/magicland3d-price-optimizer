"use client";

import {
  type ReactNode,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatedNumber } from "@/components/ui/animated-number";
import Link from "next/link";
import { thumbUrl } from "@/lib/image";
import { fetchJson } from "@/lib/fetch-json";
import { formatRelativeTime } from "@/lib/format";
import {
  ClipboardList,
  RefreshCw,
  Search,
  ChevronDown,
  ArrowUpRight,
  Truck,
  AlertTriangle,
  PackageX,
  Package,
  KeyRound,
  TrendingUp,
  Pencil,
  Plus,
  Trash2,
  Check,
  PackageCheck,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { PlatformLogo } from "@/components/PlatformLogo";
import {
  ManualOrderDialog,
  type ManualOrderEditTarget,
} from "@/components/orders/ManualOrderDialog";
import {
  ORDERS_REQUEST_EVENT,
  takeOrdersRequest,
  type OrdersRequest,
} from "@/components/ui/command-palette";
import {
  buildPrepItems,
  loadPrepDone,
  savePrepDone,
  type PrepItem,
} from "./hazirlik";
import {
  countsInSummary,
  filterOrdersBeforeStatus,
  statusChipCounts,
} from "./siparis-filtre";
import { cn } from "@/lib/utils";

type OrderStatusKind = "pending" | "processing" | "shipped" | "delivered" | "cancelled" | "other";
type OrderPlatform = "shopify" | "trendyol" | "hepsiburada" | "manual";

interface UnifiedOrderItem {
  name: string;
  quantity: number;
  image: string | null;
  productId?: string | null;
  madeToOrder?: boolean;
  /** Bu satır kâra girmedi (ürün eşleşmedi ya da maliyeti girilmemiş). */
  costMissing?: boolean;
}
interface UnifiedOrder {
  platform: OrderPlatform;
  id: string;
  orderNumber: string;
  date: string | null;
  statusKind: OrderStatusKind;
  statusLabel: string;
  total: number;
  currency: string;
  customer: string | null;
  itemCount: number;
  items: UnifiedOrderItem[];
  image: string | null;
  profit: number | null;
  profitPartial: boolean;
  unmatchedCount?: number;
  missingDesiCount?: number;
  desiEstimated?: boolean;
  orderRevenueAdjustment?: number;
  trackingNumber: string | null;
  cargoProvider: string | null;
  /** Kalem/tutar bilgisi platformdan alınamadı → üstteki toplamlara girmez. */
  dataIncomplete?: boolean;
  /** Durumu tanınmadı → satış mı iade mi bilinmiyor, toplamlara girmez. */
  statusUnknown?: boolean;
  /** Bu siparişte iade edilmiş kalem sayısı. */
  returnedLineCount?: number;
  isManual?: boolean;
  manualOrderId?: string | null;
  editHref?: string | null;
}
interface PlatformStatus {
  ok: boolean;
  count: number;
  needsAdminToken?: boolean;
  notConfigured?: boolean;
  error?: string;
  /** Bilgisi eksik geldiği için listeye/toplamlara alınamayan sipariş sayısı. */
  incompleteCount?: number;
}
interface SummaryBucket {
  revenue: number;
  profit: number;
  orderCount: number;
  incompleteOrders?: number;
}
interface SummaryQuality {
  unsupportedCurrencyOrders: number;
  unsupportedCurrencies: Array<{ currency: string; orderCount: number }>;
  /** Durumu tanınmadığı için toplamların dışında tutulan siparişler. */
  unknownStatusOrders?: number;
  unknownStatuses?: Array<{ status: string; orderCount: number }>;
  /** İçinde iade edilmiş kalem bulunan sipariş sayısı. */
  partialReturnOrders?: number;
  /** Verisi alınamayan kaynaklar — doluysa toplamlar eksik. */
  missingSources?: string[];
}
/** Manuel siparişin kayıtlı kalemleri — burada yalnız "maliyeti biliniyor mu" için okunur. */
interface ManualOrderCostDetail {
  items?: Array<{ costKnown?: boolean } | null>;
}
interface OrdersResponse {
  orders: UnifiedOrder[];
  /** Bu listenin hesaplandığı an — "3 dakika önce güncellendi" satırı bundan yazılır. */
  computedAt?: string | number | null;
  /**
   * Bütün kaynaklardan veri geldi mi. Sunucu damgalar ve kaydedilen kopyaya da yazılır:
   * eksik bir toplam, sonraki açılışta "tam" sanılmasın.
   */
  dataComplete?: boolean;
  summary: {
    days: number;
    shopify: SummaryBucket;
    trendyol: SummaryBucket;
    hepsiburada: SummaryBucket;
    manual?: SummaryBucket;
    total: SummaryBucket;
    quality?: SummaryQuality;
  };
  shopify: PlatformStatus;
  trendyol: PlatformStatus;
  hepsiburada: PlatformStatus;
  /** Manuel siparişlerin okunma durumu — bozuk kayıt listeyi düşürmesin diye ayrı taşınır. */
  manual?: PlatformStatus;
  financeHistory?: {
    ok: boolean;
    syncedOrders: number;
    syncDays: number;
    /** Kayıt şu an sürüyor — sonuç bir sonraki yenilemede kesinleşir. */
    pending?: boolean;
    error?: string;
  };
}

const PLATFORM_INFO = {
  shopify: { label: "Shopify", color: "oklch(0.60 0.16 152)" },
  trendyol: { label: "Trendyol", color: "oklch(0.72 0.17 60)" },
  hepsiburada: { label: "Hepsiburada", color: "oklch(0.66 0.19 38)" },
  manual: { label: "Manuel", color: "oklch(0.64 0.19 285)" },
} as const;

const STATUS_STYLE: Record<OrderStatusKind, { label: string; cls: string; dot: string }> = {
  pending: { label: "Bekleyen", cls: "bg-amber-500/15 text-amber-400 border-amber-500/30", dot: "bg-amber-500" },
  processing: { label: "Hazırlanıyor", cls: "bg-blue-500/15 text-blue-400 border-blue-500/30", dot: "bg-blue-500" },
  shipped: { label: "Kargoda", cls: "bg-indigo-500/15 text-indigo-400 border-indigo-500/30", dot: "bg-indigo-500" },
  delivered: { label: "Teslim", cls: "bg-green-500/15 text-green-400 border-green-500/30", dot: "bg-green-500" },
  cancelled: { label: "İptal/İade", cls: "bg-destructive/15 text-destructive border-destructive/30", dot: "bg-destructive" },
  other: { label: "Diğer", cls: "bg-muted text-muted-foreground border-border", dot: "bg-muted-foreground" },
};
/** Yenileme sırasında beklenen kaynaklar — kurulu olmayan pazaryeri gösterilmez. */
const SOURCE_CHIPS = [
  { key: "shopify", label: "Shopify" },
  { key: "trendyol", label: "Trendyol" },
  { key: "hepsiburada", label: "Hepsiburada" },
] as const;

// Formatter'ları MODÜL seviyesinde bir kez kur (her hücrede yeni Intl nesnesi pahalı → satır başına ×N).
const _fmtTRY0 = new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", minimumFractionDigits: 0, maximumFractionDigits: 0 });
const _fmtTRY2 = new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _fmtDT = new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
function fmtMoney(amount: number, currency = "TRY") {
  try {
    if (currency === "TRY") return _fmtTRY0.format(amount);
    return new Intl.NumberFormat("tr-TR", { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${Math.round(amount)} ${currency}`;
  }
}
function fmtMoney2(amount: number, currency = "TRY") {
  try {
    if (currency === "TRY") return _fmtTRY2.format(amount);
    return new Intl.NumberFormat("tr-TR", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
function fmtDate(iso: string | null) {
  if (!iso) return "—";
  try {
    return _fmtDT.format(new Date(iso));
  } catch {
    return "—";
  }
}


export default function OrdersPage() {
  const queryClient = useQueryClient();
  const forceFresh = useRef(false); // "Yenile" → sunucu önbelleğini atla (?fresh=1), canlı çek.
  const { data, isLoading, isFetching, refetch, error } = useQuery<OrdersResponse>({
    queryKey: ["orders"],
    queryFn: ({ signal }) => {
      const url = forceFresh.current ? "/api/orders?fresh=1" : "/api/orders";
      forceFresh.current = false;
      return fetch(url, { signal }).then((r) => r.json());
    },
    // 5dk taze: sekmeye dönüşte 3 pazaryeri API'sini tekrar çağırma (anında cache). Tazelemek için "Yenile".
    staleTime: 5 * 60_000,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });

  /** "Yenile" — hem butondan hem tazelik satırından aynı işi yapar. */
  const refreshOrders = () => {
    if (isFetching) return;
    forceFresh.current = true;
    refetch();
  };

  const [platform, setPlatform] = useState<"all" | OrderPlatform>("all");
  const [status, setStatus] = useState<"all" | OrderStatusKind>("all");
  const [search, setSearch] = useState("");
  /** "liste" = sipariş sipariş; "hazirlik" = ürün bazında toplanmış paketleme listesi. */
  const [view, setView] = useState<"liste" | "hazirlik">("liste");
  /** Özet karttaki "N siparişte maliyet eksik" uyarısına tıklayınca yalnız o siparişler listelenir. */
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const [manualCreateOpen, setManualCreateOpen] = useState(false);
  const [editingManual, setEditingManual] =
    useState<ManualOrderEditTarget | null>(null);
  // Arama debounce: kutu anında yazılır (search), filtre 200ms sonra (debouncedSearch).
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(t);
  }, [search]);

  // Hızlı aramadan (Ctrl+K) gelen istek: bir sipariş numarası ya da hazırlık listesi.
  useEffect(() => {
    const uygula = (request: OrdersRequest | null) => {
      if (!request) return;
      if (request.search != null) {
        setSearch(request.search);
        setDebouncedSearch(request.search);
        setPlatform("all");
        setStatus("all");
        setOnlyIncomplete(false);
      }
      if (request.view) setView(request.view);
    };
    uygula(takeOrdersRequest());
    const onRequest = (event: Event) => {
      takeOrdersRequest(); // sayfa zaten açıkken not birikmesin
      uygula((event as CustomEvent<OrdersRequest>).detail ?? null);
    };
    window.addEventListener(ORDERS_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(ORDERS_REQUEST_EVENT, onRequest);
  }, []);

  // Hazırlıkta işaretlenenler — oturum boyunca saklanır, açılışta geri yüklenir.
  const [prepDone, setPrepDone] = useState<string[]>([]);
  useEffect(() => {
    setPrepDone(loadPrepDone());
  }, []);
  const prepDoneSet = useMemo(() => new Set(prepDone), [prepDone]);
  const togglePrepDone = (key: string) => {
    setPrepDone((current) => {
      const next = current.includes(key)
        ? current.filter((k) => k !== key)
        : [...current, key];
      savePrepDone(next);
      return next;
    });
  };
  const resetPrepDone = () => {
    setPrepDone([]);
    savePrepDone([]);
  };

  const orders = useMemo(() => data?.orders ?? [], [data]);
  const summary = data?.summary;
  const manualSummary = useMemo<SummaryBucket>(() => {
    if (summary?.manual) return summary.manual;
    return orders.reduce<SummaryBucket>(
      (bucket, order) => {
        // Toplama girme koşulu sunucudakiyle aynı yerden okunur (iptal/eksik/döviz dışı hariç).
        if (order.platform !== "manual" || !countsInSummary(order)) {
          return bucket;
        }
        bucket.revenue += order.total;
        bucket.profit += order.profit ?? 0;
        bucket.orderCount += 1;
        if (order.profit == null || order.profitPartial) {
          bucket.incompleteOrders = (bucket.incompleteOrders ?? 0) + 1;
        }
        return bucket;
      },
      { revenue: 0, profit: 0, orderCount: 0, incompleteOrders: 0 }
    );
  }, [orders, summary?.manual]);

  const deleteManualMutation = useMutation({
    mutationFn: (order: UnifiedOrder) => {
      const id = order.manualOrderId || order.id;
      return fetchJson(order.editHref || `/api/manual-orders/${id}`, {
        method: "DELETE",
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["orders"] }),
        queryClient.invalidateQueries({ queryKey: ["finance-monthly"] }),
      ]);
      toast.success("Manuel sipariş silindi");
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Manuel sipariş silinemedi"
      ),
  });

  /**
   * Durum DIŞINDAKİ tüm filtreler uygulanmış ara liste. Kurallar siparis-filtre.ts'te:
   * çipler, "maliyet eksik" bağlantısı ve liste artık AYNI kümeden üretiliyor.
   */
  const beforeStatus = useMemo(
    () =>
      filterOrdersBeforeStatus(orders, {
        platform,
        search: debouncedSearch,
        onlyMissingCost: onlyIncomplete,
      }),
    [orders, platform, debouncedSearch, onlyIncomplete]
  );

  const statusChips = useMemo(() => statusChipCounts(beforeStatus), [beforeStatus]);

  /** Listede görünen ama üstteki toplamlara girmeyen sipariş sayısı (iptal/iade, bilgisi eksik). */
  const excludedFromSummary = Math.max(
    0,
    orders.length - (summary?.total.orderCount ?? orders.length)
  );
  /**
   * Verisi alınamayan kaynaklar. Boşsa toplamlar tam. Doluysa ekrandaki her rakam eksik bir
   * veriyle hesaplanmıştır ve bunu SÖYLEMEK zorundayız — "₺0" da bir cevap gibi görünüyor.
   */
  const missingSources = summary?.quality?.missingSources ?? [];
  const unknownStatusOrders = summary?.quality?.unknownStatusOrders ?? 0;

  const filtered = useMemo(
    () => (status === "all" ? beforeStatus : beforeStatus.filter((o) => o.statusKind === status)),
    [beforeStatus, status]
  );

  // Hazırlık listesi üstteki platform/arama filtrelerine uyar, durum çipine uymaz:
  // kapsamı zaten "gönderilmeyi bekleyenler".
  const prepItems = useMemo(() => buildPrepItems(beforeStatus), [beforeStatus]);
  const prepUnitTotal = useMemo(
    () => prepItems.reduce((sum, item) => sum + item.quantity, 0),
    [prepItems]
  );
  const prepOrderCount = useMemo(() => {
    const numbers = new Set<string>();
    for (const item of prepItems) for (const no of item.orderNumbers) numbers.add(no);
    return numbers.size;
  }, [prepItems]);
  const prepDoneCount = useMemo(
    () => prepItems.filter((item) => prepDoneSet.has(item.key)).length,
    [prepItems, prepDoneSet]
  );
  const prepProgress = prepItems.length ? prepDoneCount / prepItems.length : 0;

  // ── Sayfalama ──────────────────────────────────────────────────────────────
  // Liste sanallaştırılmış olsa da satırlar açılıp kapandıkça yükseklikleri değişiyor ve
  // TanStack Virtual TÜM satırları yeniden ölçüyor; sipariş sayısı büyüdükçe bu iş artıyor.
  // Sayfalama o işi sabit bir üst sınırda tutar (ve uzun listede gezinmeyi kolaylaştırır).
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  // Filtre/arama değişince başa dön (aksi halde boş sayfada kalınabilir).
  useEffect(() => { setPage(0); }, [platform, status, debouncedSearch, onlyIncomplete, pageSize]);
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = useMemo(
    () => filtered.slice(safePage * pageSize, safePage * pageSize + pageSize),
    [filtered, safePage, pageSize]
  );

  // ── Virtualization (Ürünler'le aynı kanıtlanmış desen) — uzun sipariş listesinde DOM birikmesin. ──
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setScrollEl(document.querySelector<HTMLElement>("main"));
  }, []);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useEffect(() => {
    if (!scrollEl) return;
    const measure = () => {
      const el = listRef.current;
      if (!el || !scrollEl) return;
      setScrollMargin(
        el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // safePage/pageSize + onlyIncomplete de bağımlı: sayfa değişince liste içeriği, filtre bandı
    // açılıp kapanınca da listenin ÜSTTEN ofseti değişiyor → scrollMargin yeniden ölçülmeli.
    // view: hazırlık görünümünde durum çipleri gizleniyor, listeye dönünce ofset değişiyor.
  }, [scrollEl, isLoading, platform, status, filtered.length, safePage, pageSize, onlyIncomplete, view]);

  // TanStack Virtual callback tabanlı API döndürür; React Compiler bu bileşeni bilinçli olarak atlar.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: pageItems.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => 84,
    overscan: 8,
    scrollMargin,
    getItemKey: (i) => {
      const o = pageItems[i];
      return o ? `${o.platform}-${o.id}` : i;
    },
  });
  const vItems = rowVirtualizer.getVirtualItems();
  const padTop = vItems.length > 0 ? Math.max(0, vItems[0].start - scrollMargin) : 0;
  const padBottom =
    vItems.length > 0 ? Math.max(0, rowVirtualizer.getTotalSize() - vItems[vItems.length - 1].end) : 0;

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      {/* Başlık */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ClipboardList className="h-6 w-6 text-primary" /> Siparişler
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Son {summary?.days ?? 30} gündeki platform ve manuel siparişlerin — tek yerde.
          </p>
          <FreshnessLine
            computedAt={data?.computedAt}
            fetching={isFetching}
            onRefresh={refreshOrders}
          />
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Button
            size="sm"
            className="gap-2"
            onClick={() => setManualCreateOpen(true)}
          >
            <Plus className="h-4 w-4" />
            Manuel Sipariş
          </Button>
          <Button variant="outline" size="sm" disabled={isFetching} onClick={refreshOrders} className="gap-2">
            <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
            Yenile
          </Button>
        </div>
      </div>

      {/* Çekim sırasında ne olduğunu göster — "Yenile" üç pazaryerinden CANLI çekiyor ve
          10-20 saniye sürebiliyor. Eskiden tek geri bildirim dönen ikondu; kullanıcı
          hiçbir şey olmuyor sanıp tekrar basıyordu. Sunucu aşama bildirmediği için sahte
          yüzde UYDURMUYORUZ — hangi kaynakların beklendiğini dürüstçe yazıyoruz. */}
      {isFetching && (
        <div className="animate-in fade-in slide-in-from-top-1 duration-300 overflow-hidden rounded-lg border border-border/60 bg-muted/25">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
            <span className="flex items-center gap-2 text-xs font-medium">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
              </span>
              Siparişler alınıyor
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
              {SOURCE_CHIPS.filter(
                (c) => !data || !data[c.key] || !data[c.key]?.notConfigured
              ).map((c, i) => (
                <span
                  key={c.key}
                  className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-background/60 px-1.5 py-0.5 text-[11px] text-muted-foreground animate-in fade-in duration-300"
                  style={{ animationDelay: `${i * 90}ms`, animationFillMode: "both" }}
                >
                  <PlatformLogo platform={c.key} className="h-2.5 w-2.5" />
                  {c.label}
                </span>
              ))}
            </span>
          </div>
          {/* İnce akan çizgi — süre bilinmiyor, ama iş sürüyor. */}
          <div className="relative h-0.5 w-full overflow-hidden bg-border/40">
            <div
              className="absolute inset-y-0 w-1/3 bg-primary/70"
              style={{ animation: "indeterminate-bar 1.25s ease-in-out infinite" }}
            />
          </div>
        </div>
      )}

      {/* 30 günlük özet şeridi — bir kaynak alınamadıysa sipariş olmasa da gösterilir
          (yoksa "sipariş yok" ekranı, aslında alınamamış veriyi sıfır gibi gösteriyordu). */}
      {summary && (summary.total.orderCount > 0 || missingSources.length > 0) && (
        <Card className="overflow-hidden">
          <CardContent className="grid grid-cols-2 gap-3 py-3 sm:grid-cols-3 lg:grid-cols-6">
            <SummaryStat
              label={`${summary.total.orderCount} sipariş`}
              value={<AnimatedNumber value={summary.total.revenue} format={fmtMoney} />}
              sub={missingSources.length > 0 ? "Toplam ciro · eksik veri" : "Toplam ciro"}
              subColor={missingSources.length > 0 ? "oklch(0.75 0.15 75)" : undefined}
              strong
            />
            <SummaryStat
              label="Sipariş kârı"
              value={<AnimatedNumber value={summary.total.profit} format={fmtMoney} />}
              sub={summary.total.incompleteOrders ? `${summary.total.incompleteOrders} siparişte maliyet eksik` : "tahmini"}
              subColor={summary.total.incompleteOrders ? "oklch(0.75 0.15 75)" : undefined}
              color={summary.total.profit >= 0 ? "oklch(0.72 0.18 145)" : "oklch(0.63 0.22 25)"}
              // Uyarıya tıkla → yalnız maliyeti eksik siparişler listelenir (tekrar tıkla → kaldır).
              onSubClick={
                summary.total.incompleteOrders
                  ? () => {
                      setOnlyIncomplete((v) => !v);
                      setPlatform("all");
                      setStatus("all");
                    }
                  : undefined
              }
              subActive={onlyIncomplete}
            />
            <PlatformStat label="Shopify" platform="shopify" bucket={summary.shopify} status={data?.shopify} />
            <PlatformStat label="Trendyol" platform="trendyol" bucket={summary.trendyol} status={data?.trendyol} />
            <PlatformStat label="Hepsiburada" platform="hepsiburada" bucket={summary.hepsiburada} status={data?.hepsiburada} />
            <PlatformStat label="Manuel" platform="manual" bucket={manualSummary} status={data?.manual} />
            {/* Rakamların eksik olduğunu SÖYLE — sessiz yarım toplam en tehlikelisi. */}
            {missingSources.length > 0 && (
              <p className="col-span-full flex items-center gap-1.5 text-[10px] font-medium text-amber-400 animate-in fade-in duration-500">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                {missingSources.join(", ")} verisi alınamadı — ciro ve kâr toplamları eksik.
              </p>
            )}
            {/* Listedeki sipariş sayısı ile özetteki sayı neden farklı — tek satırda. */}
            {excludedFromSummary > 0 && (
              <p className="col-span-full text-[10px] text-muted-foreground animate-in fade-in duration-500">
                Listede {excludedFromSummary} sipariş daha var — iptal/iade ya da tutarı
                okunamayanlar toplamlara girmiyor.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {(summary?.quality?.unsupportedCurrencyOrders ?? 0) > 0 && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="py-3 flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <div className="text-sm">
              <p className="font-medium text-amber-400">
                TRY dışındaki siparişler TL toplamına eklenmedi
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {summary?.quality?.unsupportedCurrencyOrders} sipariş döviz kuru dönüşümü
                olmadığı için üstteki ciro ve kâr toplamlarının dışında tutuldu
                {summary?.quality?.unsupportedCurrencies?.length
                  ? `: ${summary.quality.unsupportedCurrencies
                      .map(({ currency, orderCount }) => `${currency} (${orderCount})`)
                      .join(", ")}.`
                  : "."}{" "}
                Sipariş tutarları aşağıda kendi para birimiyle gösteriliyor.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {unknownStatusOrders > 0 && (
        <Card className="border-amber-500/40 bg-amber-500/5 animate-in fade-in slide-in-from-top-1 duration-300">
          <CardContent className="py-3 flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <div className="text-sm">
              <p className="font-medium text-amber-400">
                {unknownStatusOrders} siparişin durumu tanınmadı
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Satış mı iade mi belli olmadığı için toplamlara katılmadı
                {summary?.quality?.unknownStatuses?.length
                  ? `: ${summary.quality.unknownStatuses
                      .map(({ status, orderCount }) => `${status} (${orderCount})`)
                      .join(", ")}.`
                  : "."}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {(summary?.quality?.partialReturnOrders ?? 0) > 0 && (
        <Card className="border-amber-500/40 bg-amber-500/5 animate-in fade-in slide-in-from-top-1 duration-300">
          <CardContent className="py-3 flex items-start gap-3">
            <RotateCcw className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <div className="text-sm">
              <p className="font-medium text-amber-400">
                {summary?.quality?.partialReturnOrders} siparişte iade edilmiş ürün var
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Ciro platformun bildirdiği tutar — iade edilen ürün düşülmedi.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Platform uyarıları */}
      {data?.shopify?.needsAdminToken && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="py-3 flex items-start gap-3">
            <KeyRound className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <div className="text-sm">
              <p className="font-medium text-amber-400">Shopify siparişleri için Client ID + Secret gerekli</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Storefront token siparişleri vermez. Shopify dev dashboard → uygulaman → Ayarlar →
                Kimlik bilgileri&apos;ndeki <strong>İstemci Kimliği + Gizli anahtar</strong>&apos;ı{" "}
                <Link href="/api-settings" className="text-primary underline underline-offset-2">Entegrasyonlar</Link>{" "}
                sayfasına ekle (read_orders izinli). Trendyol siparişleri aşağıda listeleniyor.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
      {data?.shopify && !data.shopify.ok && !data.shopify.needsAdminToken && !data.shopify.notConfigured && (
        <PlatformError platform="Shopify" message={data.shopify.error} />
      )}
      {data?.trendyol && !data.trendyol.ok && !data.trendyol.notConfigured && (
        <PlatformError platform="Trendyol" message={data.trendyol.error} />
      )}
      {data?.hepsiburada && !data.hepsiburada.ok && !data.hepsiburada.notConfigured && (
        <PlatformError platform="Hepsiburada" message={data.hepsiburada.error} />
      )}
      {data?.manual && !data.manual.ok && (
        <PlatformError platform="Manuel" message={data.manual.error} />
      )}
      {(data?.manual?.incompleteCount ?? 0) > 0 && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="py-3 flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <div className="text-sm">
              <p className="font-medium text-amber-400">
                {data?.manual?.incompleteCount} manuel sipariş açılamadı
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Kaydı bozuk göründü; listeye ve toplamlara girmedi.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
      {data?.financeHistory && !data.financeHistory.ok && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="py-3 flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <div className="min-w-0 text-sm">
              <p className="font-medium text-amber-400">
                Raporlara kaydedilemedi
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Siparişler listelendi ama aylık rapora işlenmedi. Yenile&apos;ye bas.
              </p>
              {data.financeHistory.error && (
                <details className="mt-1 text-[11px] text-muted-foreground/80">
                  <summary className="cursor-pointer select-none">Ayrıntı</summary>
                  <p className="mt-0.5 break-all">{data.financeHistory.error}</p>
                </details>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Görünüm seçimi — sipariş sipariş bakmak ya da paketleme için ürün bazında toplamak. */}
      <div className="inline-flex rounded-lg border border-border p-0.5 bg-muted/30">
        {([
          { key: "liste", label: "Sipariş listesi", icon: ClipboardList },
          { key: "hazirlik", label: "Hazırlık", icon: PackageCheck },
        ] as const).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setView(key)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-all duration-200 active:scale-95",
              view === key
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
            {key === "hazirlik" && prepItems.length - prepDoneCount > 0 && (
              <span className="rounded-full bg-primary/15 px-1.5 py-px text-[10px] font-semibold tabular-nums text-primary">
                {prepItems.length - prepDoneCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Kontroller */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-border p-0.5 bg-muted/30">
          {(["all", "shopify", "trendyol", "hepsiburada", "manual"] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPlatform(p)}
              className={cn(
                "px-3 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5",
                platform === p ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
              style={platform === p && p !== "all" ? { color: PLATFORM_INFO[p].color } : undefined}
            >
              {p !== "all" && <PlatformLogo platform={p} className="h-3 w-3" />}
              {p === "all" ? "Tümü" : PLATFORM_INFO[p].label}
            </button>
          ))}
        </div>

        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ara: sipariş no, müşteri, ürün..." className="pl-8 h-9" />
        </div>
      </div>

      {/* "Maliyet eksik" filtresi açıkken kullanıcı NEDEN az sipariş gördüğünü bilsin. */}
      {onlyIncomplete && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs animate-in fade-in slide-in-from-top-1 duration-200">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          <span className="flex-1">
            Yalnız <strong>maliyeti eksik</strong> siparişler gösteriliyor. Bir siparişi açıp
            işaretli ürüne tıkla, maliyetini gir.
          </span>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setOnlyIncomplete(false)}>
            Filtreyi kaldır
          </Button>
        </div>
      )}

      {/* Durum filtreleri — hazırlık görünümünün kapsamı zaten sabit, orada gösterilmez. */}
      {view === "liste" && (
      <div className="flex flex-wrap gap-1.5">
        {/* "Hepsi" de çipler de listenin TAM olarak aynı kümesinden sayılır. */}
        <StatusChip active={status === "all"} onClick={() => setStatus("all")} label="Hepsi" count={beforeStatus.length} />
        {statusChips.map(({ kind, count }) => (
          <StatusChip key={kind} active={status === kind} onClick={() => setStatus(kind)} label={STATUS_STYLE[kind].label} count={count} dot={STATUS_STYLE[kind].dot} />
        ))}
      </div>
      )}

      {/* Liste ya da hazırlık görünümü */}
      {view === "hazirlik" ? (
        <PrepPanel
          items={prepItems}
          doneSet={prepDoneSet}
          unitTotal={prepUnitTotal}
          orderCount={prepOrderCount}
          doneCount={prepDoneCount}
          progress={prepProgress}
          loading={isLoading}
          onToggle={togglePrepDone}
          onReset={resetPrepDone}
        />
      ) : isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[76px] w-full rounded-xl" />
          ))}
        </div>
      ) : error ? (
        <EmptyState icon={AlertTriangle} title="Siparişler yüklenemedi" description="API bağlantısında sorun oluştu. Yenile'ye basıp tekrar dene." />
      ) : filtered.length === 0 ? (
        // "Sipariş yok" ile "veri alınamadı" AYNI ŞEY DEĞİL: alınamayan veriyi boş liste
        // olarak göstermek, olmayan bir sıfırı doğru bilgi gibi sunuyordu.
        orders.length === 0 && missingSources.length > 0 ? (
          <EmptyState
            icon={AlertTriangle}
            title="Siparişler alınamadı"
            description={`${missingSources.join(", ")} yanıt vermedi. Yenile'ye basıp tekrar dene.`}
          />
        ) : (
          <EmptyState
            icon={PackageX}
            title={orders.length === 0 ? "Son 30 günde sipariş yok" : "Filtreyle eşleşen sipariş yok"}
            description={
              orders.length === 0
                ? "Platformlardan sipariş gelince veya manuel sipariş ekleyince burada listelenir."
                : "Filtre veya aramayı değiştirip tekrar dene."
            }
          />
        )
      ) : (
        <div ref={listRef}>
          {padTop > 0 && <div style={{ height: padTop }} />}
          {vItems.map((vi) => {
            const o = pageItems[vi.index];
            if (!o) return null;
            return (
              <div
                key={`${o.platform}-${o.id}`}
                data-index={vi.index}
                ref={rowVirtualizer.measureElement}
                className="pb-2"
              >
                <OrderRow
                  order={o}
                  deleting={
                    deleteManualMutation.isPending &&
                    deleteManualMutation.variables?.id === o.id
                  }
                  onEdit={() =>
                    setEditingManual({
                      id: o.id,
                      manualOrderId: o.manualOrderId,
                      editHref: o.editHref,
                      orderNumber: o.orderNumber,
                      date: o.date,
                      customer: o.customer,
                      statusKind:
                        o.statusKind === "other"
                          ? "processing"
                          : o.statusKind,
                      total: o.total,
                      items: o.items,
                    })
                  }
                  onDelete={() => {
                    if (
                      window.confirm(
                        `"${o.orderNumber}" manuel siparişini silmek istiyor musun? Bu işlem geri alınamaz.`
                      )
                    ) {
                      deleteManualMutation.mutate(o);
                    }
                  }}
                />
              </div>
            );
          })}
          {padBottom > 0 && <div style={{ height: padBottom }} />}
        </div>
      )}

      {/* Sayfalama — tek sayfaya sığıyorsa gösterilmez (gereksiz kalabalık yapmasın). */}
      {view === "liste" && filtered.length > pageSize && (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <span className="text-xs text-muted-foreground tabular-nums">
            {safePage * pageSize + 1}–{Math.min(filtered.length, (safePage + 1) * pageSize)} / {filtered.length} sipariş
          </span>
          <div className="flex items-center gap-2">
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="h-8 rounded-md border bg-background px-2 text-xs"
              title="Sayfa başına sipariş"
            >
              {[25, 50, 100, 200].map((n) => (
                <option key={n} value={n}>{n} / sayfa</option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={safePage === 0}
              onClick={() => { setPage(safePage - 1); scrollEl?.scrollTo({ top: 0, behavior: "smooth" }); }}
            >
              Önceki
            </Button>
            <span className="text-xs tabular-nums text-muted-foreground px-1">
              {safePage + 1} / {pageCount}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={safePage >= pageCount - 1}
              onClick={() => { setPage(safePage + 1); scrollEl?.scrollTo({ top: 0, behavior: "smooth" }); }}
            >
              Sonraki
            </Button>
          </div>
        </div>
      )}

      <ManualOrderDialog
        open={manualCreateOpen || editingManual !== null}
        editing={editingManual}
        onOpenChange={(open) => {
          if (!open) {
            setManualCreateOpen(false);
            setEditingManual(null);
          }
        }}
      />
    </div>
  );
}

/** Bu süreden eski liste "bayat" sayılır — kullanıcı görsün ve tek tıkla tazeleyebilsin. */
const STALE_AFTER_MS = 10 * 60_000;

// Bağıl zaman metni kendi kendini tazelesin diye yarım dakikada bir tikleyen saat. Değer kovalara
// yuvarlanır (aynı render turunda aynı sonucu vermek zorunda) ve sunucuda null döner — böylece
// metin yalnız tarayıcıda üretilir, sunucu/tarayıcı saat farkı ekranı bozmaz.
const CLOCK_TICK_MS = 30_000;
function subscribeClock(onChange: () => void): () => void {
  const timer = setInterval(onChange, CLOCK_TICK_MS);
  return () => clearInterval(timer);
}
function clockSnapshot(): number {
  return Math.floor(Date.now() / CLOCK_TICK_MS) * CLOCK_TICK_MS;
}
function clockServerSnapshot(): null {
  return null;
}
function useClientNow(): number | null {
  return useSyncExternalStore<number | null>(
    subscribeClock,
    clockSnapshot,
    clockServerSnapshot
  );
}

/**
 * Başlığın altındaki tazelik satırı: "3 dakika önce güncellendi".
 * Sunucu hızlı açılış için kaydedilmiş bir listeyi de dönebiliyor; o zaman bu satır sararır ve
 * tıklanınca canlı çekim başlar. Zaman metni yalnız tarayıcıda üretilir (sunucu saatiyle
 * oynamasın diye) ve dakikada iki kez kendini tazeler.
 */
function FreshnessLine({
  computedAt,
  fetching,
  onRefresh,
}: {
  computedAt?: string | number | null;
  fetching: boolean;
  onRefresh: () => void;
}) {
  const now = useClientNow();

  if (now == null || computedAt == null) return null;
  const at = new Date(computedAt).getTime();
  if (!Number.isFinite(at)) return null;

  const stale = now - at > STALE_AFTER_MS;
  const label = `${formatRelativeTime(computedAt, now)} güncellendi`;
  const shared =
    "mt-1.5 inline-flex items-center gap-1.5 text-[11px] animate-in fade-in duration-500";

  if (!stale || fetching) {
    return (
      <span className={cn(shared, "text-muted-foreground", fetching && "opacity-60")}>
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/70" />
        {label}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onRefresh}
      className={cn(
        shared,
        "rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-400 transition-colors hover:bg-amber-500/20"
      )}
    >
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-70" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
      </span>
      {label}
      <span className="opacity-70">·</span>
      Yenile
    </button>
  );
}

function SummaryStat({
  label,
  value,
  sub,
  subColor,
  color,
  platform,
  strong,
  onSubClick,
  subActive,
}: {
  label: string;
  value: ReactNode;
  sub: string;
  /** Alt metin rengi — eksik maliyet uyarısında amber. */
  subColor?: string;
  color?: string;
  platform?: OrderPlatform;
  strong?: boolean;
  /** Verilirse alt metin tıklanabilir olur (ör. "maliyet eksik" → o siparişleri filtrele). */
  onSubClick?: () => void;
  /** Filtre şu an açık mı (alt metin vurgulanır). */
  subActive?: boolean;
}) {
  const c = platform ? PLATFORM_INFO[platform].color : color;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {platform && <PlatformLogo platform={platform} className="h-3 w-3" style={{ color: c }} />}
        <span className="truncate">{label}</span>
      </div>
      <div className={cn("tabular-nums mt-0.5", strong ? "text-xl font-bold" : "text-lg font-semibold")} style={c ? { color: c } : undefined}>
        {value}
      </div>
      <div className="text-[10px]" style={subColor ? { color: subColor } : undefined}>
        {onSubClick ? (
          <button
            onClick={onSubClick}
            className={cn(
              "inline-flex items-center gap-1 font-medium underline decoration-dotted underline-offset-2 transition-opacity hover:opacity-80",
              subActive && "no-underline rounded px-1 -mx-1 bg-current/15"
            )}
            title={subActive ? "Filtreyi kaldır" : "Bu siparişleri göster"}
          >
            {sub}
            <ArrowUpRight className="h-2.5 w-2.5" />
          </button>
        ) : (
          <span className={subColor ? "font-medium" : "text-muted-foreground"}>{sub}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Pazaryeri kutusu.
 *
 * 🔴 Veri ALINAMADIĞINDA "₺0 · 0 sipariş" yazıyordu: kesin bir rakam gibi duruyor, o platformun
 * cirosu sessizce yok oluyordu. Artık alınamayan kaynak "—" gösterir ve nedenini söyler.
 * Kurulu olmayan platform bundan AYRI durumdur (eksiklik değil, kullanıcının tercihi).
 */
function PlatformStat({
  label,
  platform,
  bucket,
  status,
}: {
  label: string;
  platform: OrderPlatform;
  bucket: SummaryBucket;
  status?: PlatformStatus;
}) {
  if (status && !status.ok) {
    const notSetUp = status.notConfigured === true;
    const needsKey = status.needsAdminToken === true;
    return (
      <SummaryStat
        label={label}
        platform={platform}
        value={<span className="text-muted-foreground">—</span>}
        sub={notSetUp ? "bağlı değil" : needsKey ? "bağlantı gerekli" : "veri alınamadı"}
        subColor={notSetUp ? undefined : "oklch(0.75 0.15 75)"}
      />
    );
  }
  return (
    <SummaryStat
      label={label}
      platform={platform}
      value={<AnimatedNumber value={bucket.revenue} format={fmtMoney} />}
      sub={`${bucket.orderCount} sipariş`}
    />
  );
}

function PlatformError({ platform, message }: { platform: string; message?: string }) {
  return (
    <Card className="border-destructive/40 bg-destructive/5">
      <CardContent className="py-3 flex items-start gap-3">
        <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
        <div className="text-sm">
          <p className="font-medium text-destructive">{platform} siparişleri alınamadı</p>
          {message && <p className="text-xs text-muted-foreground mt-0.5 break-all">{message}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function StatusChip({ active, onClick, label, count, dot }: { active: boolean; onClick: () => void; label: string; count: number; dot?: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors",
        active ? "bg-primary text-primary-foreground border-primary" : "bg-transparent text-muted-foreground border-border hover:border-primary/40 hover:text-foreground"
      )}
    >
      {dot && <span className={cn("h-1.5 w-1.5 rounded-full", active ? "bg-primary-foreground" : dot)} />}
      {label}
      <span className={cn("tabular-nums", active ? "opacity-90" : "opacity-60")}>{count}</span>
    </button>
  );
}

/**
 * Hazırlık listesi: gönderilmeyi bekleyen siparişlerin kalemleri ürün bazında toplanmış,
 * toplandıkça işaretlenebilir hâlde. Amaç paketleme sırasında tek ekrana bakmak.
 */
function PrepPanel({
  items,
  doneSet,
  unitTotal,
  orderCount,
  doneCount,
  progress,
  loading,
  onToggle,
  onReset,
}: {
  items: PrepItem[];
  doneSet: Set<string>;
  unitTotal: number;
  orderCount: number;
  doneCount: number;
  progress: number;
  loading: boolean;
  onToggle: (key: string) => void;
  onReset: () => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[64px] w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={PackageCheck}
        title="Hazırlanacak bir şey yok"
        description="Bekleyen ya da hazırlanan sipariş çıktığında, toplanacak ürünler adetleriyle burada listelenir."
      />
    );
  }

  const allDone = doneCount === items.length;

  return (
    <div className="space-y-3 animate-in fade-in slide-in-from-top-1 duration-300">
      {/* Özet + ilerleme */}
      <Card className="overflow-hidden">
        <CardContent className="space-y-2.5 py-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[11px] text-muted-foreground">Bugün gönderilecekler</p>
              <p className="text-xl font-bold tabular-nums">
                <AnimatedNumber value={unitTotal} /> adet
              </p>
              <p className="text-[11px] text-muted-foreground">
                {items.length} çeşit · {orderCount} sipariş
              </p>
            </div>
            <div className="text-right">
              <p className="text-[11px] text-muted-foreground">Hazırlanan</p>
              <p className="text-lg font-semibold tabular-nums">
                <AnimatedNumber value={doneCount} /> / {items.length}
              </p>
            </div>
          </div>

          <div className="h-1.5 w-full overflow-hidden rounded-full bg-border/50">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            {allDone ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-500 animate-in fade-in zoom-in-95 duration-300">
                <Sparkles className="h-3.5 w-3.5" />
                Hepsi hazır
              </span>
            ) : (
              <span className="text-[11px] text-muted-foreground">
                Ürünü topladıkça işaretle.
              </span>
            )}
            {doneCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={onReset}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                İşaretleri temizle
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Toplanacak ürünler */}
      <div className="space-y-2">
        {items.map((item, index) => {
          const done = doneSet.has(item.key);
          return (
            <div
              key={item.key}
              style={{
                animation: "nav-slide-in 260ms ease forwards",
                animationDelay: `${Math.min(index, 12) * 30}ms`,
                opacity: 0,
                animationFillMode: "forwards",
              }}
            >
              <Card
                className={cn(
                  "overflow-hidden transition-all duration-300",
                  done ? "opacity-55" : "hover:border-primary/30"
                )}
              >
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => onToggle(item.key)}
                    aria-pressed={done}
                    title={done ? "İşareti kaldır" : "Hazır olarak işaretle"}
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition-all duration-200 active:scale-90",
                      done
                        ? "border-green-500 bg-green-500 text-white"
                        : "border-border hover:border-primary/60 hover:bg-primary/10"
                    )}
                  >
                    <Check
                      className={cn(
                        "h-3.5 w-3.5 transition-all duration-200",
                        done ? "scale-100 opacity-100" : "scale-50 opacity-0"
                      )}
                      strokeWidth={3}
                    />
                  </button>

                  <Thumb src={item.image} size="h-11 w-11" />

                  <button
                    type="button"
                    onClick={() => onToggle(item.key)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <p
                      className={cn(
                        "truncate text-sm font-medium transition-all",
                        done && "line-through"
                      )}
                    >
                      {item.name}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                      {item.orderNumbers.slice(0, 3).map((no) => (
                        <span
                          key={no}
                          className="rounded border border-border/60 px-1 py-px tabular-nums"
                        >
                          {no}
                        </span>
                      ))}
                      {item.orderNumbers.length > 3 && (
                        <span className="opacity-70">
                          +{item.orderNumbers.length - 3} sipariş
                        </span>
                      )}
                      {item.madeToOrder && (
                        <span className="text-amber-500">· sipariş üzerine</span>
                      )}
                      {item.costMissing && (
                        <span className="text-amber-500">· maliyet girilmemiş</span>
                      )}
                    </div>
                  </button>

                  <span className="flex h-9 min-w-[2.25rem] shrink-0 items-center justify-center rounded-lg bg-primary/10 px-2 text-base font-bold tabular-nums text-primary">
                    ×{item.quantity}
                  </span>

                  {item.productId && (
                    <Link
                      href={`/products/${item.productId}`}
                      className="shrink-0 text-muted-foreground/60 transition-colors hover:text-primary"
                      title="Ürün sayfasına git"
                    >
                      <ArrowUpRight className="h-4 w-4" />
                    </Link>
                  )}
                </div>
              </Card>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Thumb({ src, size = "h-12 w-12" }: { src: string | null; size?: string }) {
  return (
    <div className={cn("relative shrink-0 rounded-lg overflow-hidden border bg-muted flex items-center justify-center", size)}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumbUrl(src) ?? undefined} alt="" className="max-w-full max-h-full object-contain" loading="lazy" />
      ) : (
        <Package className="h-5 w-5 text-muted-foreground/50" />
      )}
    </div>
  );
}

const OrderRow = memo(function OrderRow({
  order,
  onEdit,
  onDelete,
  deleting,
}: {
  order: UnifiedOrder;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isManualOrder = order.isManual === true || order.platform === "manual";
  const manualId = order.manualOrderId || order.id;
  // Manuel siparişte "hangi kalemin maliyeti eksik" bilgisi listeyle birlikte gelmiyor: eskiden
  // hiçbir kalem işaretlenmiyordu ve kullanıcı neyi düzelteceğini bulamıyordu. Bu kaydı YALNIZ
  // sipariş açıldığında ve gerçekten eksik varsa okuyoruz (tek satır, düzenleme penceresiyle
  // aynı kayıt → ikinci bir istek olmuyor).
  const serverMarkedMissing = order.items.some((it) => it.costMissing);
  const manualCostQuery = useQuery<ManualOrderCostDetail>({
    queryKey: ["manual-order", manualId],
    queryFn: () =>
      fetchJson<ManualOrderCostDetail>(
        order.editHref || `/api/manual-orders/${manualId}`
      ),
    enabled:
      isManualOrder &&
      open &&
      !serverMarkedMissing &&
      (order.profitPartial || order.profit == null),
    staleTime: 60_000,
    retry: false,
  });
  const missingCostItems = useMemo(() => {
    const flags = order.items.map((it) => it.costMissing === true);
    // Kayıttaki kalemler listedekiyle aynı sırada tutuluyor.
    manualCostQuery.data?.items?.forEach((stored, i) => {
      if (stored?.costKnown === false && i < flags.length) flags[i] = true;
    });
    return flags;
  }, [order.items, manualCostQuery.data]);
  const info = PLATFORM_INFO[order.platform];
  const st = STATUS_STYLE[order.statusKind];
  const firstItem = order.items[0];
  const extraItems = order.items.length - 1;
  const orderCurrency = order.currency.trim().toUpperCase() || "TRY";
  const isTryOrder = orderCurrency === "TRY";
  const profitColor = order.profit == null ? "" : order.profit >= 0 ? "text-green-500" : "text-destructive";
  // İptal/iade siparişi üstteki ciro ve kâr toplamlarına GİRMİYOR. Satır normal görünüp yeşil
  // kâr yazdığı sürece ekrandaki iki rakam birbirini tutmuyordu; artık soluk + üstü çizili.
  const isCancelled = order.statusKind === "cancelled";

  return (
    <Card
      className={cn(
        "overflow-hidden transition-[color,background-color,border-color,opacity] duration-200 hover:border-primary/30",
        // Soluk ama okunur; üzerine gelince tam görünür (kullanıcı iptal satırını da inceleyebilsin).
        isCancelled && "border-dashed bg-muted/25 opacity-70 hover:opacity-100"
      )}
    >
      <button onClick={() => setOpen((v) => !v)} className="w-full text-left">
        <div className="flex items-center gap-3 px-3 py-3">
          {/* Ürün görseli / çeşit kutusu + adet & platform rozeti */}
          <div className="relative shrink-0">
            {order.items.length > 1 ? (
              <div className="flex h-12 w-12 flex-col items-center justify-center rounded-lg border bg-muted leading-none">
                <span className="text-lg font-bold leading-none tabular-nums text-foreground">{order.items.length}</span>
                <span className="mt-0.5 text-[9px] leading-none text-muted-foreground">çeşit</span>
              </div>
            ) : (
              <Thumb src={order.image} />
            )}

            {/* Tek ürün ama birden fazla adet → sağ üstte ×N */}
            {order.items.length <= 1 && order.itemCount > 1 && (
              <span className="absolute -top-1.5 -right-1.5 z-10 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold tabular-nums text-primary-foreground ring-2 ring-card">
                ×{order.itemCount}
              </span>
            )}

            {/* Platform rozeti */}
            <span
              className="absolute -bottom-1 -right-1 flex items-center justify-center h-5 w-5 rounded-md ring-2 ring-card"
              style={{ backgroundColor: `${info.color.replace(")", " / 18%)")}` }}
              title={info.label}
            >
              <PlatformLogo platform={order.platform} className="h-3 w-3" style={{ color: info.color }} />
            </span>
          </div>

          {/* No + müşteri + ürün */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm tabular-nums">{order.orderNumber}</span>
              <span className="text-[11px] text-muted-foreground">{fmtDate(order.date)}</span>
            </div>
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {order.customer ? <span className="text-foreground/80">{order.customer}</span> : "Müşteri —"}
              {firstItem && (
                <>
                  <span className="mx-1.5">·</span>
                  {firstItem.name}
                  {extraItems > 0 && <span className="opacity-70"> +{extraItems} ürün</span>}
                </>
              )}
            </p>
          </div>

          {/* Tutar + kâr + durum */}
          <div className="flex flex-col items-end gap-1 shrink-0">
            <span
              className={cn(
                "font-bold text-sm tabular-nums transition-colors",
                isCancelled && "font-semibold text-muted-foreground line-through decoration-muted-foreground/70"
              )}
            >
              {fmtMoney2(order.total, order.currency)}
            </span>
            {isCancelled ? (
              <span className="text-[10px] font-medium text-muted-foreground">
                Toplama girmiyor
              </span>
            ) : order.statusUnknown ? (
              // Durumu tanımadığımız sipariş toplamların dışında — satırda da görünsün ki
              // ekrandaki iki rakam neden tutmuyor belli olsun.
              <span className="text-[10px] font-medium text-amber-400">
                Durumu belirsiz · toplama girmiyor
              </span>
            ) : !isTryOrder ? (
              <span
                className="text-[10px] font-medium text-amber-400"
                title={`${orderCurrency} için döviz kuru dönüşümü tanımlı değil; TL net kâr hesaplanmadı.`}
              >
                Kâr: kur dönüşümü yok
              </span>
            ) : order.profit != null ? (
              <span className={cn("text-[11px] font-semibold tabular-nums flex items-center gap-0.5", profitColor)}>
                <TrendingUp className="h-3 w-3" />
                {order.profit >= 0 ? "+" : ""}
                {fmtMoney2(order.profit, orderCurrency)}
                {order.profitPartial && (
                  <span className="text-amber-500 font-bold" title={`${order.unmatchedCount ?? 1} ürünün maliyeti girilmemiş — kâra dahil değil`}>!</span>
                )}
                {order.desiEstimated && (
                  <span
                    className="text-amber-500 font-bold"
                    title={
                      (order.missingDesiCount ?? 0) > 0
                        ? `${order.missingDesiCount} ürünün desisi eksik — kargo 1 desiyle hesaplandı`
                        : "Eşleşmeyen ürünlerin desisi, eşleşen ürünlerin ortalamasıyla tahmin edildi"
                    }
                  >
                    ◆
                  </span>
                )}
              </span>
            ) : null}
            <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border", st.cls)}>
              <span className={cn("h-1.5 w-1.5 rounded-full", st.dot)} />
              {order.statusLabel}
            </span>
          </div>

          <ChevronDown className={cn("h-4 w-4 text-muted-foreground shrink-0 transition-transform", open && "rotate-180")} />
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3.5 pt-0.5 border-t border-border/50 bg-muted/20 animate-in fade-in slide-in-from-top-1 duration-200">
          <div className="grid gap-4 pt-3 sm:grid-cols-2">
            {/* Ürünler (fotoğraflı) */}
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Ürünler ({order.itemCount} adet)</p>
              <div className="space-y-2">
                {order.items.map((it, i) => {
                  const costMissing = missingCostItems[i];
                  // Maliyeti eksik manuel kalemin ürün bağlantısı yok → düzenleme penceresine götür.
                  const opensManualEditor = isManualOrder && costMissing && !it.productId;
                  const clickable = Boolean(it.productId) || opensManualEditor;
                  const rowCls = cn(
                    "flex items-center gap-2.5 -mx-1 px-1 py-0.5 rounded-md transition-colors",
                    costMissing && "bg-amber-500/10 ring-1 ring-inset ring-amber-500/25",
                    clickable && (costMissing ? "hover:bg-amber-500/20" : "hover:bg-muted/50")
                  );
                  const body = (
                    <>
                      <Thumb src={it.image} size="h-9 w-9" />
                      <span className="flex-1 min-w-0 truncate text-xs text-foreground/90">
                        {it.name}
                        {it.madeToOrder && (
                          <span className="ml-1.5 text-[9px] text-amber-500">· sipariş üzerine</span>
                        )}
                        {/* Kâra girmeyen satır: ürünü işaretle → kullanıcı hangisini düzelteceğini görür. */}
                        {costMissing && (
                          <span className="ml-1.5 text-[9px] font-medium text-amber-500">
                            {it.productId || isManualOrder ? "· maliyet girilmemiş" : "· ürün eşleşmedi"}
                          </span>
                        )}
                      </span>
                      {clickable && <ArrowUpRight className="h-3 w-3 text-muted-foreground/60 shrink-0" />}
                      <span className="tabular-nums text-xs text-muted-foreground shrink-0">×{it.quantity}</span>
                    </>
                  );
                  if (opensManualEditor) {
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={onEdit}
                        className={cn(rowCls, "w-full text-left")}
                        title="Bu ürünün maliyetini gir"
                      >
                        {body}
                      </button>
                    );
                  }
                  return it.productId ? (
                    <Link
                      key={i}
                      href={`/products/${it.productId}`}
                      className={rowCls}
                      title={costMissing ? "Bu ürünün maliyetini gir" : "Ürün sayfasına git (maliyet/kâr detayı)"}
                    >
                      {body}
                    </Link>
                  ) : (
                    <div key={i} className={rowCls}>{body}</div>
                  );
                })}
              </div>
            </div>

            {/* Kargo & kâr */}
            <div className="sm:border-l sm:border-border/50 sm:pl-4">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Kargo & Kâr</p>
              <div className="space-y-1.5 text-xs">
                {order.cargoProvider && (
                  <div className="flex items-center gap-1.5 text-foreground/90">
                    <Truck className="h-3.5 w-3.5 text-muted-foreground" />
                    {order.cargoProvider}
                  </div>
                )}
                {order.trackingNumber ? (
                  <div className="text-muted-foreground">Takip: <span className="font-mono text-foreground/90">{order.trackingNumber}</span></div>
                ) : (
                  <div className="text-muted-foreground">Takip numarası yok</div>
                )}
                <div className="flex items-center justify-between pt-1.5 border-t border-border/40">
                  <span className="text-muted-foreground">Ciro</span>
                  <span
                    className={cn(
                      "tabular-nums font-medium",
                      isCancelled && "text-muted-foreground line-through"
                    )}
                  >
                    {fmtMoney2(order.total, order.currency)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Net kâr</span>
                  {isCancelled ? (
                    <span className="text-muted-foreground">
                      — {order.statusLabel.toLocaleLowerCase("tr-TR")}, toplama girmiyor
                    </span>
                  ) : !isTryOrder ? (
                    <span className="text-amber-400">
                      — {orderCurrency} için kur dönüşümü yok
                    </span>
                  ) : order.profit != null ? (
                    <span className={cn("tabular-nums font-semibold", profitColor)}>
                      {order.profit >= 0 ? "+" : ""}{fmtMoney2(order.profit, orderCurrency)}{order.profitPartial && <span className="text-amber-500">!</span>}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">— maliyet girilmemiş</span>
                  )}
                </div>
                {/* İptal/iade siparişte kâr ayrıntısı yanıltıcı olur — hiçbir toplama girmiyor. */}
                {!isCancelled && Math.abs(order.orderRevenueAdjustment ?? 0) >= 0.01 && (
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-muted-foreground">Kargo geliri / sipariş indirimi</span>
                    <span className="tabular-nums text-muted-foreground">
                      {(order.orderRevenueAdjustment ?? 0) >= 0 ? "+" : ""}
                      {fmtMoney2(order.orderRevenueAdjustment ?? 0, orderCurrency)}
                    </span>
                  </div>
                )}
                {!isCancelled && order.profitPartial && (
                  <p className="text-[10px] text-muted-foreground/70">
                    {order.unmatchedCount ?? 1} ürünün maliyeti girilmemiş — kâra dahil değil.
                    {isManualOrder && (
                      <button
                        type="button"
                        onClick={onEdit}
                        className="ml-1 font-medium text-amber-500 underline decoration-dotted underline-offset-2 transition-opacity hover:opacity-80"
                      >
                        Maliyeti gir
                      </button>
                    )}
                  </p>
                )}
                {!isCancelled && order.desiEstimated && (
                  <p className="text-[10px] text-amber-500/90">
                    {(order.missingDesiCount ?? 0) > 0
                      ? `${order.missingDesiCount} ürünün desisi eksik — kargo 1 desiyle hesaplandı.`
                      : "Eşleşmeyen ürünlerin desisi ortalamayla tahmin edildi."}
                  </p>
                )}
                {!isCancelled && (order.returnedLineCount ?? 0) > 0 && (
                  <p className="text-[10px] text-amber-500/90">
                    {order.returnedLineCount} ürün iade edilmiş — ciro düşülmedi.
                  </p>
                )}
                {order.statusUnknown && (
                  <p className="text-[10px] text-amber-500/90">
                    Durumu tanınmadı — ciro ve kâr toplamlarına girmedi.
                  </p>
                )}
              </div>
            </div>
          </div>
          {(order.isManual || order.platform === "manual") && (
            <div className="mt-3 flex items-center justify-end gap-2 border-t border-border/50 pt-3">
              <span className="mr-auto text-[10px] text-muted-foreground">
                Bu kayıt elle eklendi.
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                disabled={deleting}
                onClick={onEdit}
              >
                <Pencil className="h-3.5 w-3.5" />
                Düzenle
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={deleting}
                onClick={onDelete}
              >
                {deleting ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                Sil
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
});
