"use client";

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { fetchJson } from "@/lib/fetch-json";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Package,
  AlertTriangle,
  TrendingDown,
  TrendingUp,
  Activity,
  ClipboardList,
  ArrowRight,
  PackageX,
  RefreshCw,
  CloudOff,
  CheckCircle2,
  ChevronDown,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatCurrency, formatPercent, formatRelativeTime } from "@/lib/format";
import { AnimatedNumber } from "@/components/ui/animated-number";
import Link from "next/link";
import { PlatformLogo } from "@/components/PlatformLogo";

type Platform = "shopify" | "trendyol" | "hepsiburada";
type OrderPlatform = Platform | "manual";

interface PlatformStats {
  platform: Platform;
  activeListings: number;
  /** Maliyeti girilmediği için kâr hesabına giremeyen ilan sayısı. */
  missingCostListings: number;
  totalProfit: number;
  /** null = o platformda hesaplanacak ciro yok. SIFIR DEĞİL — "—" gösterilir. */
  averageMargin: number | null;
  negativeProfitCount: number;
  thinMarginCount: number;
}

interface DashboardData {
  /** Gövdenin sunucuda HESAPLANDIĞI an — tazelik satırı bundan yazılır (yanıtın geldiği andan değil). */
  computedAt?: string | number | null;
  totalProducts: number;
  inStockCount: number;
  outOfStockCount: number;
  lowStockCount: number;
  lowStockProducts: {
    id: string;
    name: string;
    stock: number;
    imageUrl: string | null;
  }[];
  /** Kartta gösterilen satır sayısı ve gösterilemeyen kalan. */
  lowStockShown: number;
  lowStockMore: number;
  /** Karta sığmayanların dağılımı: stoğu bitenlerin Ürünler'de karşılığı var, "1 kalan"ların yok. */
  lowStockMoreOutOfStock?: number;
  lowStockMoreLow?: number;
  missingCost: number;
  negativeListings: number;
  grandTotalProfit: number;
  platforms: PlatformStats[];
  problemProducts: {
    id: string;
    name: string;
    listingId?: string;
    platform?: Platform;
    salePrice: number;
    problem: string;
    profit: number | null;
    margin: number | null;
  }[];
  problemTotal: number;
  problemShown: number;
  problemMore: number;
  /** Taşan satırların türü — "+N" bağlantısı gerçekten o kümeyi gösteren listeye gitsin. */
  problemMoreNegative?: number;
  problemMoreMissingCost?: number;
}

/**
 * Vurgu renkleri TEMAYA GÖRE ayrışır (değerler globals.css'te `--panel-*`).
 * Sabit oklch değerleri koyu tema için seçilmişti; açık temada beyaz kart üstünde
 * rakamlar ve kehribar uyarılar okunmuyordu.
 */
const ACCENTS = {
  primary: "var(--panel-primary)",
  amber: "var(--panel-amber)",
  red: "var(--panel-red)",
  green: "var(--panel-green)",
} as const;

const SOFT = {
  primary: "var(--panel-primary-soft)",
  amber: "var(--panel-amber-soft)",
  red: "var(--panel-red-soft)",
} as const;

/**
 * Küçük etiketler kendi `-soft` zemininin ÜSTÜNDE duruyor, beyaz kartın değil. Vurgu renkleri
 * beyazda yeterliyken o zeminlerde 4,5'in altına düşüyordu → etiket yazıları bu koyu
 * karşılıkları kullanır (koyu temada değerler aynı kalır).
 */
const ON_SOFT = {
  amber: "var(--panel-amber-on-soft)",
  red: "var(--panel-red-on-soft)",
} as const;

const PLATFORM_INFO: Record<
  Platform,
  { label: string; color: string; soft: string; onSoft: string }
> = {
  shopify: {
    label: "Shopify",
    color: "var(--panel-shopify)",
    soft: "var(--panel-shopify-soft)",
    onSoft: "var(--panel-shopify-on-soft)",
  },
  trendyol: {
    label: "Trendyol",
    color: "var(--panel-trendyol)",
    soft: "var(--panel-trendyol-soft)",
    onSoft: "var(--panel-trendyol-on-soft)",
  },
  hepsiburada: {
    label: "Hepsiburada",
    color: "var(--panel-hepsiburada)",
    soft: "var(--panel-hepsiburada-soft)",
    onSoft: "var(--panel-hepsiburada-on-soft)",
  },
};

const ORDER_PLATFORM_INFO: Record<OrderPlatform, { label: string; color: string }> = {
  ...PLATFORM_INFO,
  manual: { label: "Manuel", color: "var(--panel-manual)" },
};

const PROBLEM_LABELS: Record<
  string,
  { label: string; variant: "destructive" | "secondary" | "outline" }
> = {
  missing_cost: { label: "Maliyet Eksik", variant: "secondary" },
  negative_profit: { label: "Zarar", variant: "destructive" },
};

/** Bu süreden eski veri "bayat" sayılır — kullanıcı görsün ve tek tıkla tazeleyebilsin. */
const STALE_AFTER_MS = 10 * 60_000;

/** Fiyat hareketleri ucu — "Yenile" aynı adrese `&fresh=1` ekler, adres TEK yerde dursun. */
const PRICE_CHANGES_URL = "/api/dashboard/price-changes?days=30&limit=8";

/** Düşük stok kartında ilk açılışta görünen kutucuk sayısı; gerisi kart içinde açılır. */
const LOW_STOCK_VISIBLE = 30;

/** ISO/epoch damgayı milisaniyeye çevir; okunamıyorsa null (BİLİNMEYEN ≠ SIFIR). */
function toMs(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Satırların kademeli girişi; uzun listede bekleme olmasın diye üst sınır var. */
const ROW_STAGGER_MS = 28;
const ROW_STAGGER_MAX = 14;
const rowDelay = (index: number) => Math.min(index, ROW_STAGGER_MAX) * ROW_STAGGER_MS;

// Bağıl zaman metni kendi kendini tazelesin diye yarım dakikada bir tikleyen saat. Değer kovalara
// yuvarlanır (aynı render turunda aynı sonucu vermeli) ve sunucuda null döner — render sırasında
// Date.now() çağrılmaz.
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
  return useSyncExternalStore<number | null>(subscribeClock, clockSnapshot, clockServerSnapshot);
}

/**
 * Başka bir kartın çektiği gövdedeki hesaplama zamanını okur.
 *
 * Panel'in üç kaynağı (özet, siparişler, fiyat hareketleri) ayrı kartlarda çekiliyor; tazelik
 * satırı üçünün EN ESKİSİNİ yazacağı için hepsinin damgasına buradan erişilir. Aynı anahtarla
 * ikinci bir sorgu açmak yerine önbelleği dinleriz — fazladan istek çıkmaz.
 */
function useComputedAt(key: string): number | null {
  const queryClient = useQueryClient();
  return useSyncExternalStore<number | null>(
    (onChange) => queryClient.getQueryCache().subscribe(onChange),
    () => toMs(queryClient.getQueryData<{ computedAt?: string | number | null }>([key])?.computedAt),
    () => null
  );
}

/* ------------------------------------------------------------------ */
/* Ortak küçük parçalar                                                */
/* ------------------------------------------------------------------ */

/** Kartın içinde kalan hata durumu — sayfanın geri kalanı çalışmaya devam eder. */
function CardError({
  mesaj,
  onRetry,
  deneniyor,
}: {
  mesaj: string;
  onRetry: () => void;
  deneniyor?: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-8 text-center animate-in fade-in duration-300">
      <span className="rounded-full p-2.5" style={{ backgroundColor: SOFT.amber }}>
        <CloudOff className="h-5 w-5" style={{ color: ACCENTS.amber }} />
      </span>
      <p className="text-sm text-muted-foreground max-w-xs">{mesaj}</p>
      <Button
        variant="outline"
        size="sm"
        onClick={onRetry}
        disabled={deneniyor}
        className="gap-2"
      >
        <RefreshCw className={cn("h-3.5 w-3.5", deneniyor && "animate-spin")} />
        Tekrar dene
      </Button>
    </div>
  );
}

function EmptyState({
  icon: Icon,
  mesaj,
  renk,
}: {
  icon: React.ElementType;
  mesaj: string;
  renk?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-7 text-center animate-in fade-in duration-300">
      <Icon
        aria-hidden
        className={cn("h-5 w-5", !renk && "text-muted-foreground/50")}
        style={renk ? { color: renk } : undefined}
      />
      <p className="text-sm text-muted-foreground max-w-sm">{mesaj}</p>
    </div>
  );
}

/**
 * Ürün görseli; görsel yoksa veya yüklenemezse kırık ikon yerine sade bir yer tutucu.
 *
 * Hata durumu ADRESE bağlı tutulur: liste yenilenip aynı satıra başka bir ürün gelince
 * (React aynı bileşeni tekrar kullanır) yeni görsel de "bozuk" sayılıp hiç denenmiyordu.
 */
function ProductThumb({ src }: { src: string | null }) {
  const [bozukSrc, setBozukSrc] = useState<string | null>(null);
  const gosterilebilir = !!src && bozukSrc !== src;
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/70 bg-muted/40">
      {gosterilebilir ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setBozukSrc(src)}
        />
      ) : (
        <Package className="h-3.5 w-3.5 text-muted-foreground/50" />
      )}
    </span>
  );
}

const MORE_ROW_CLASS =
  "mt-2 flex w-full items-center justify-center gap-1 rounded-lg py-2 text-xs font-medium text-muted-foreground";

/** Kartın altındaki "gösterilmeyen kalan" satırı — ilgili filtreye götürür. */
function MoreRow({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className={cn(
        MORE_ROW_CLASS,
        "transition-all duration-150 hover:bg-muted/50 hover:text-foreground active:scale-[0.99]"
      )}
    >
      {label}
      <ArrowRight className="h-3 w-3" />
    </Link>
  );
}

/** Gidilecek bir liste olmadığında kalan sayıyı yalnızca BİLDİREN satır (bağlantı değil). */
function MoreNote({ label }: { label: string }) {
  return <p className={cn(MORE_ROW_CLASS, "opacity-80")}>{label}</p>;
}

/** Kalanı kart içinde açan satır — Ürünler'de karşılığı olmayan kümeler için. */
function ExpandRow({
  label,
  acik,
  onToggle,
}: {
  label: string;
  acik: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        MORE_ROW_CLASS,
        "cursor-pointer transition-all duration-150 hover:bg-muted/50 hover:text-foreground active:scale-[0.99]"
      )}
    >
      {label}
      <ChevronDown className={cn("h-3 w-3 transition-transform duration-200", acik && "rotate-180")} />
    </button>
  );
}

/** Oran barı — ilk görünüşte dolar, değer değişince akar. */
function RatioBar({ ratio, color, height = "h-1.5" }: { ratio: number; color: string; height?: string }) {
  const genislik = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0)) * 100;
  return (
    <div
      className={cn("w-full overflow-hidden rounded-full", height)}
      style={{ backgroundColor: "var(--panel-track)" }}
    >
      <div
        className="h-full origin-left rounded-full"
        style={{
          width: `${genislik}%`,
          backgroundColor: color,
          transition: "width 700ms cubic-bezier(0.22, 1, 0.36, 1)",
          animation: "panel-bar-fill 700ms cubic-bezier(0.22, 1, 0.36, 1) both",
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Üst rakam kartları                                                   */
/* ------------------------------------------------------------------ */

function StatCard({
  title,
  value,
  birim,
  sub,
  icon: Icon,
  accentColor,
  accentSoft,
  delay = 0,
  href,
}: {
  title: string;
  value: React.ReactNode;
  /** Rakamın neyi saydığı ("ürün" / "ilan") — sayfadaki sayılar birbirine karışmasın. */
  birim?: string;
  sub?: string;
  icon: React.ElementType;
  accentColor: string;
  accentSoft: string;
  delay?: number;
  href?: string;
}) {
  const card = (
    <Card
      className={`h-full overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-500 ${
        href ? "cursor-pointer transition-transform hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.99]" : ""
      }`}
      style={{
        animationDelay: `${delay}ms`,
        animationFillMode: "both",
        borderTop: `2px solid ${accentColor}`,
      }}
    >
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <div className="rounded-lg p-2" style={{ backgroundColor: accentSoft }}>
          <Icon className="h-4 w-4" style={{ color: accentColor }} />
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums" style={{ color: accentColor }}>
          {value}
          {birim && <span className="ml-1 text-sm font-semibold opacity-70">{birim}</span>}
        </div>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );

  return href ? (
    <Link href={href} className="block h-full">
      {card}
    </Link>
  ) : (
    card
  );
}

function StatCardSkeleton({ delay }: { delay: number }) {
  return (
    <Card
      className="h-full overflow-hidden animate-in fade-in duration-300"
      style={{ animationDelay: `${delay}ms`, animationFillMode: "both", borderTop: "2px solid var(--border)" }}
    >
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-8 rounded-lg" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-16" />
        <Skeleton className="h-3 w-32 mt-2" />
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Platform kartı                                                       */
/* ------------------------------------------------------------------ */

/** Marj barında %40 ve üstü tam dolu sayılır — normal aralıktaki farklar görünür kalsın. */
const MARGIN_FULL = 0.4;

function PlatformCard({ stats, delay }: { stats: PlatformStats; delay: number }) {
  const info = PLATFORM_INFO[stats.platform];
  // Marj null olabilir (hesaplanacak ciro yok) — 0 sanılmasın diye "—" gösterilir.
  const marj =
    typeof stats.averageMargin === "number" && Number.isFinite(stats.averageMargin)
      ? stats.averageMargin
      : null;
  const marjRenk = marj !== null && marj < 0 ? ACCENTS.red : info.color;
  const zararOrani =
    stats.activeListings > 0 ? stats.negativeProfitCount / stats.activeListings : 0;

  return (
    <Card
      className="h-full gap-0 py-0 overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-500 transition-transform hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.99]"
      style={{
        animationDelay: `${delay}ms`,
        animationFillMode: "both",
        borderLeft: `3px solid ${info.color}`,
      }}
    >
      {/* Kart gövdesi ve alttaki "maliyeti eksik" satırı AYRI bağlantılar: iç içe link olmaz. */}
      <Link
        href={`/products?platform=${stats.platform}`}
        className="flex flex-1 cursor-pointer flex-col gap-4 py-4"
      >
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <PlatformLogo platform={stats.platform} className="h-4 w-4" style={{ color: info.color }} />
            <span style={{ color: info.color }}>{info.label}</span>
          </CardTitle>
          <Badge variant="outline" className="text-xs tabular-nums">
            {stats.activeListings} ilan
          </Badge>
        </CardHeader>
        <CardContent className="space-y-2">
          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-muted-foreground">Ortalama Marj</span>
              <span className="text-lg font-bold tabular-nums" style={{ color: marjRenk }}>
                {marj === null ? (
                  "—"
                ) : (
                  <AnimatedNumber value={marj} format={(n) => formatPercent(n)} />
                )}
              </span>
            </div>
            <div className="mt-1.5">
              <RatioBar ratio={marj === null ? 0 : Math.abs(marj) / MARGIN_FULL} color={marjRenk} />
            </div>
          </div>

          <div className="pt-1.5 border-t border-border/50">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <TrendingDown className="h-3 w-3" />
                Zarar Eden
              </span>
              <span
                className="text-sm font-bold tabular-nums"
                style={{ color: stats.negativeProfitCount > 0 ? ACCENTS.red : undefined }}
              >
                <AnimatedNumber value={stats.negativeProfitCount} /> / {stats.activeListings}
              </span>
            </div>
            <div className="mt-1.5">
              <RatioBar
                ratio={zararOrani}
                color={stats.negativeProfitCount > 0 ? ACCENTS.red : "var(--panel-track)"}
                height="h-1"
              />
            </div>
          </div>
        </CardContent>
      </Link>

      {/* Maliyeti olmayan ilanlar kâr/marj hesabına HİÇ girmez — kaç ilanın dışarıda kaldığı görünsün. */}
      {stats.missingCostListings > 0 && (
        <Link
          // Sayı BU platformun ilanlarını anlatıyor; liste de o platformla daraltılmalı.
          // Daraltmasız gidilirse "3 ilan" yazıp 88 ürünlük karışık liste açılıyordu.
          href={`/products?filter=missing-cost&platform=${stats.platform}`}
          className="flex items-center justify-between gap-2 border-t border-border/60 px-4 py-2.5 text-xs font-medium transition-colors hover:bg-muted/50 active:scale-[0.99]"
          style={{ color: ACCENTS.amber }}
        >
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" />
            {stats.missingCostListings} ilanın maliyeti eksik
          </span>
          <ArrowRight className="h-3 w-3 opacity-70" />
        </Link>
      )}
    </Card>
  );
}

/**
 * İskelet GERÇEK kartla aynı iskelete oturur: dış boşluklar (`gap-0 py-0` + iç `py-4`) ve
 * alttaki "maliyeti eksik" şeridi dahil. Şerit iskelette yoktu; veri gelince her platform
 * kartı ~38px uzayıp sayfayı aşağı itiyordu.
 */
function PlatformCardSkeleton({ delay }: { delay: number }) {
  return (
    <Card
      className="h-full gap-0 py-0 overflow-hidden animate-in fade-in duration-300"
      style={{ animationDelay: `${delay}ms`, animationFillMode: "both", borderLeft: "3px solid var(--border)" }}
    >
      <div className="flex flex-1 flex-col gap-4 py-4">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-5 w-14 rounded-md" />
        </CardHeader>
        <CardContent className="space-y-2">
          <div>
            <div className="flex items-baseline justify-between">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-5 w-14" />
            </div>
            <Skeleton className="h-1.5 w-full mt-2 rounded-full" />
          </div>
          <div className="pt-1.5 border-t border-border/50">
            <div className="flex items-baseline justify-between">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-4 w-12" />
            </div>
            <Skeleton className="h-1 w-full mt-2 rounded-full" />
          </div>
        </CardContent>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border/60 px-4 py-2.5">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-3 w-3 rounded-sm" />
      </div>
    </Card>
  );
}

/** Platform bölümünün iskeleti/gerçeği aynı düzende: üstte iki pazaryeri, altta ortalı Shopify. */
function PlatformSectionLayout({
  marketplaces,
  shopify,
}: {
  marketplaces: React.ReactNode;
  shopify: React.ReactNode;
}) {
  return (
    <div>
      <h2 className="text-base font-semibold mb-3">Platform Bazlı Özet</h2>
      <div className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-stretch">{marketplaces}</div>
        <div className="md:flex md:justify-center">
          <div className="md:w-[calc(50%-0.375rem)]">{shopify}</div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Fiyat hareketleri                                                    */
/* ------------------------------------------------------------------ */

interface PriceChangeItem {
  productId: string;
  productName: string;
  firstPrice: number;
  lastPrice: number;
  /** null = yüzde hesaplanamadı (eski fiyat yok/sıfır). SIFIR DEĞİL — "—" gösterilir. */
  changePercent: number | null;
  changeCount: number;
  lastChangedAt: string;
}

interface PriceChangesData {
  /** Gövdenin sunucuda hesaplandığı an — tazelik satırı üç kaynağın en eskisini yazar. */
  computedAt?: string | number | null;
  days: number;
  totalChanges: number;
  productsAffected: number;
  recent: PriceChangeItem[];
}

function PriceChangesCard({ delay }: { delay: number }) {
  const { data, isLoading, isError, isFetching, refetch } = useQuery<PriceChangesData>({
    queryKey: ["price-changes"],
    queryFn: ({ signal }) => fetchJson(PRICE_CHANGES_URL, { signal }),
    // Fiyat geçmişi yalnızca fiyat değişince değişir (manuel "Fiyatları Güncelle") → interval yok.
    staleTime: Infinity,
    refetchOnMount: true,
  });

  if (isLoading && !data) {
    return (
      <SectionCard delay={delay} icon={Activity} renk={ACCENTS.primary} baslik="Son 30 Gün Fiyat Hareketleri">
        <ListSkeleton rows={6} />
      </SectionCard>
    );
  }

  if (isError && !data) {
    return (
      <SectionCard delay={delay} icon={Activity} renk={ACCENTS.primary} baslik="Fiyat Hareketleri">
        <CardError
          mesaj="Fiyat hareketleri şu an alınamadı."
          onRetry={() => void refetch()}
          deneniyor={isFetching}
        />
      </SectionCard>
    );
  }

  // Veri yok ama hata da yok: ağ kopunca React Query isteği DURAKLATIR (isLoading ve isError
  // ikisi de false). Eskiden burada `return null` vardı ve kart sessizce yok oluyordu —
  // kullanıcı böyle bir kartın varlığını bile fark etmiyordu.
  if (!data) {
    return (
      <SectionCard delay={delay} icon={Activity} renk={ACCENTS.primary} baslik="Son 30 Gün Fiyat Hareketleri">
        <CardError mesaj="Fiyat hareketleri şu an alınamadı." onRetry={() => void refetch()} deneniyor={isFetching} />
      </SectionCard>
    );
  }

  if (data.totalChanges === 0) {
    return (
      <SectionCard delay={delay} icon={Activity} renk={ACCENTS.primary} baslik={`Son ${data.days} Gün Fiyat Hareketleri`}>
        <EmptyState icon={Activity} mesaj={`Son ${data.days} günde fiyat değişikliği olmadı.`} />
      </SectionCard>
    );
  }

  return (
    <SectionCard
      delay={delay}
      icon={Activity}
      renk={ACCENTS.primary}
      baslik={`Son ${data.days} Gün Fiyat Hareketleri`}
      rozet={
        <Badge variant="outline" className="ml-1 tabular-nums">
          {data.totalChanges} değişim · {data.productsAffected} ürün
        </Badge>
      }
    >
      <div className="space-y-0.5">
        {data.recent.map((item, idx) => {
          const yuzde = item.changePercent;
          const biliniyor = typeof yuzde === "number" && Number.isFinite(yuzde);
          const up = biliniyor && yuzde >= 0;
          return (
            <Link
              key={item.productId}
              href={`/products/${item.productId}`}
              className="block animate-in fade-in slide-in-from-bottom-1 duration-300"
              style={{ animationDelay: `${rowDelay(idx)}ms`, animationFillMode: "both" }}
            >
              <div className="flex items-center justify-between py-2 px-3 -mx-3 rounded-lg cursor-pointer transition-all duration-150 hover:bg-muted/40 active:scale-[0.995] group">
                <div className="min-w-0 flex-1">
                  <p className="text-sm truncate group-hover:text-foreground transition-colors">
                    {item.productName}
                  </p>
                  <p className="text-[11px] text-muted-foreground tabular-nums mt-0.5">
                    {formatCurrency(item.firstPrice)} → {formatCurrency(item.lastPrice)}
                    {item.changeCount > 1 && (
                      <span className="ml-1.5 opacity-70">· {item.changeCount}×</span>
                    )}
                  </p>
                </div>
                <div
                  className={cn(
                    "flex items-center gap-1 text-sm font-bold tabular-nums shrink-0 ml-3",
                    !biliniyor && "text-muted-foreground"
                  )}
                  style={
                    biliniyor ? { color: up ? ACCENTS.green : ACCENTS.red } : undefined
                  }
                >
                  {biliniyor &&
                    (up ? (
                      <TrendingUp className="h-3.5 w-3.5" />
                    ) : (
                      <TrendingDown className="h-3.5 w-3.5" />
                    ))}
                  {biliniyor ? `${up ? "+" : ""}${formatPercent(yuzde / 100)}` : "—"}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
      {/* Rozet TÜM ürün sayısını yazıyor ama kart yalnız son hareketleri gösteriyor — kalan
          sessizce kaybolmasın. Ürünler'de "son 30 günde fiyatı değişenler" diye bir liste
          olmadığı için bu satır bilgi verir, bir yere götürmez. */}
      {data.productsAffected > data.recent.length && (
        <MoreNote label={`+${data.productsAffected - data.recent.length} ürün daha fiyat değiştirdi`} />
      )}
    </SectionCard>
  );
}

/**
 * Düşük stok iskeleti — GERÇEK düzen: 3 sütunlu ızgara + görsel/ad/rozet üçlüsü, altında
 * "+N" satırı. Eskiden 3 satırlık düz bir listeydi; veri gelince kart bir anda 10 satıra
 * çıkıp sayfayı aşağı fırlatıyordu. Satır sayısı önceden bilinemez → makul, SABİT bir
 * yükseklik ayrılır ve sıçrama küçük kalır.
 */
function LowStockSkeleton() {
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
        {Array.from({ length: 12 }, (_, i) => (
          <div
            key={i}
            className="flex items-center gap-2.5 py-2 px-3 rounded-lg border border-transparent"
          >
            <Skeleton className="h-8 w-8 shrink-0 rounded-md" />
            <Skeleton className="h-3.5 flex-1" />
            <Skeleton className="h-5 w-14 shrink-0 rounded-md" />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-center py-2">
        <Skeleton className="h-3.5 w-28" />
      </div>
    </>
  );
}

/** Acil müdahale iskeleti — gerçeği iki satırlık kayıtlar; tek satırlık iskelet zıplatıyordu. */
function ProblemSkeleton() {
  return (
    <>
      <div className="space-y-0.5">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex items-center justify-between gap-3 py-2.5 px-3 -mx-3">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-3 w-24 mt-1.5" />
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <Skeleton className="h-3.5 w-14" />
              <Skeleton className="h-5 w-20 rounded-md" />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-center py-2">
        <Skeleton className="h-3.5 w-28" />
      </div>
    </>
  );
}

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-3 py-1.5">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
          <Skeleton className="h-4 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sipariş özeti                                                        */
/* ------------------------------------------------------------------ */

interface OrdersSummaryBucket {
  revenue: number;
  profit: number;
  orderCount: number;
}
interface OrdersSummary {
  days: number;
  shopify: OrdersSummaryBucket;
  trendyol: OrdersSummaryBucket;
  hepsiburada: OrdersSummaryBucket;
  manual: OrdersSummaryBucket;
  total: OrdersSummaryBucket;
}

const fmtTL = (n: number) => formatCurrency(n, { decimals: 0 });

/** Bir pazaryerinden veri alınamadıysa yanıtta o platformun durumu ok:false gelir. */
interface PlatformFetchStatus {
  ok: boolean;
  notConfigured?: boolean;
  incompleteCount?: number;
}

function OrdersCardShell({ delay, children }: { delay: number; children: React.ReactNode }) {
  return (
    <Card
      className="overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-500"
      style={{
        animationDelay: `${delay}ms`,
        animationFillMode: "both",
        borderTop: `2px solid ${ACCENTS.primary}`,
      }}
    >
      <CardContent className="p-5">{children}</CardContent>
    </Card>
  );
}

function OrdersSummaryCard({ delay }: { delay: number }) {
  const { data, isLoading, isError, isFetching, refetch } = useQuery<{
    summary?: OrdersSummary;
    shopify?: PlatformFetchStatus;
    trendyol?: PlatformFetchStatus;
    hepsiburada?: PlatformFetchStatus;
  }>({
    queryKey: ["orders"],
    queryFn: ({ signal }) => fetchJson("/api/orders", { signal }),
    // Panele girince son-30-gün siparişlerini arkadan tazele (bayatsa); cache anında görünür,
    // istek bitince sayılar güncellenir (SWR). 5dk içinde tekrar girişte fetch yok.
    staleTime: 5 * 60_000,
    refetchOnMount: true,
  });
  const s = data?.summary;

  if (isLoading && !s) {
    return (
      <OrdersCardShell delay={delay}>
        <div className="flex items-center justify-between mb-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-20" />
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="space-y-1.5">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-7 w-20" />
              <Skeleton className="h-2.5 w-12" />
            </div>
          ))}
        </div>
      </OrdersCardShell>
    );
  }

  if (!s) {
    return (
      <OrdersCardShell delay={delay}>
        {isError ? (
          <CardError
            mesaj="Sipariş özeti şu an alınamadı."
            onRetry={() => void refetch()}
            deneniyor={isFetching}
          />
        ) : (
          // Veri gelmedi ≠ satış yok. Duraklamış istekte "sipariş yok" demek, kullanıcıya
          // gerçekte olmayan bir sıfırı doğru bilgi gibi gösterirdi.
          <CardError
            mesaj="Sipariş özeti şu an alınamadı."
            onRetry={() => void refetch()}
            deneniyor={isFetching}
          />
        )}
      </OrdersCardShell>
    );
  }

  const profitPos = s.total.profit >= 0;
  // Kurulmamış platform "hata" değildir; yalnız kurulu olup ALINAMAYAN veri uyarı üretir.
  const failed = (st?: PlatformFetchStatus) => !!st && !st.ok && !st.notConfigured;
  const rows: {
    platform: OrderPlatform;
    bucket: OrdersSummaryBucket;
    unavailable: boolean;
  }[] = [
    { platform: "shopify", bucket: s.shopify, unavailable: failed(data?.shopify) },
    { platform: "trendyol", bucket: s.trendyol, unavailable: failed(data?.trendyol) },
    { platform: "hepsiburada", bucket: s.hepsiburada, unavailable: failed(data?.hepsiburada) },
    { platform: "manual", bucket: s.manual, unavailable: false },
  ];
  const anyUnavailable = rows.some((r) => r.unavailable);

  return (
    <Link href="/orders" className="group block">
      <Card
        className="overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-500 cursor-pointer transition-transform hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.995]"
        style={{
          animationDelay: `${delay}ms`,
          animationFillMode: "both",
          borderTop: `2px solid ${ACCENTS.primary}`,
        }}
      >
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <ClipboardList className="h-4 w-4" style={{ color: ACCENTS.primary }} />
              Son {s.days} Gün Siparişleri
            </h2>
            <span className="text-[11px] text-primary flex items-center gap-0.5 transition-transform group-hover:translate-x-0.5">
              Tümünü gör <ArrowRight className="h-3 w-3" />
            </span>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-6">
            {/* Toplam ciro */}
            <div>
              <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                Toplam ciro
                {anyUnavailable && (
                  <span
                    className="inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium"
                    style={{ color: ON_SOFT.amber, backgroundColor: SOFT.amber }}
                  >
                    eksik veri
                  </span>
                )}
              </p>
              <p
                className="text-2xl font-bold tabular-nums leading-tight"
                style={{ color: ACCENTS.primary }}
              >
                <AnimatedNumber value={s.total.revenue} format={fmtTL} />
              </p>
              <p className="text-[11px] text-muted-foreground tabular-nums mt-0.5">
                {s.total.orderCount} sipariş
              </p>
            </div>

            {/* Sipariş kârı — genel gider ödemeleri aylık raporda ayrıca düşülür. */}
            <div className="sm:border-l sm:border-border/50 sm:pl-4">
              <p className="text-[11px] text-muted-foreground">Sipariş kârı</p>
              <p
                className="text-2xl font-bold tabular-nums leading-tight"
                style={{ color: profitPos ? ACCENTS.green : ACCENTS.red }}
              >
                {profitPos ? "+" : ""}
                <AnimatedNumber value={s.total.profit} format={fmtTL} />
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">tahmini</p>
            </div>

            {/* Platform kırılımı */}
            {rows.map(({ platform, bucket, unavailable }) => {
              const info = ORDER_PLATFORM_INFO[platform];
              return (
                <div key={platform} className="sm:border-l sm:border-border/50 sm:pl-4">
                  <p className="text-[11px] flex items-center gap-1.5">
                    {platform === "manual" ? (
                      <ClipboardList className="h-3 w-3" style={{ color: info.color }} />
                    ) : (
                      <PlatformLogo
                        platform={platform}
                        className="h-3 w-3"
                        style={{ color: info.color }}
                      />
                    )}
                    <span style={{ color: info.color }} className="font-medium">
                      {info.label}
                    </span>
                  </p>
                  {/* Veri alınamadıysa "₺0" YAZMA — sıfır satış ile alınamayan veri aynı şey değil. */}
                  {unavailable ? (
                    <>
                      <p className="text-xl font-bold tabular-nums leading-tight mt-0.5 text-muted-foreground/60">
                        —
                      </p>
                      <p className="text-[11px] mt-0.5" style={{ color: ACCENTS.amber }}>
                        Veri alınamadı
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-xl font-bold tabular-nums leading-tight mt-0.5">
                        <AnimatedNumber value={bucket.revenue} format={fmtTL} />
                      </p>
                      <p className="text-[11px] text-muted-foreground tabular-nums mt-0.5">
                        {bucket.orderCount} sipariş
                      </p>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* Düşük stok + acil müdahale                                           */
/* ------------------------------------------------------------------ */

function SectionCard({
  delay,
  icon: Icon,
  renk,
  baslik,
  rozet,
  className,
  kenarRengi,
  children,
}: {
  delay: number;
  icon: React.ElementType;
  renk: string;
  baslik: string;
  rozet?: React.ReactNode;
  className?: string;
  /** Uyarı durumundaki kart kenarlığı — sabit sarı yerine tema değişkeni. */
  kenarRengi?: string;
  children: React.ReactNode;
}) {
  return (
    <Card
      className={cn("animate-in fade-in slide-in-from-bottom-2 duration-500", className)}
      style={{
        animationDelay: `${delay}ms`,
        animationFillMode: "both",
        ...(kenarRengi ? { borderColor: kenarRengi } : null),
      }}
    >
      <CardHeader className="border-b border-border/50 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Icon className="h-4 w-4" style={{ color: renk }} />
          {baslik}
          {rozet}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-3">{children}</CardContent>
    </Card>
  );
}

function LowStockCard({ data, delay }: { data: DashboardData; delay: number }) {
  const [hepsiAcik, setHepsiAcik] = useState(false);
  const tumu = data.lowStockProducts;
  const gorunen = hepsiAcik ? tumu : tumu.slice(0, LOW_STOCK_VISIBLE);
  const icerdeKalan = tumu.length - gorunen.length;
  // Karta hiç sığmayanlar: stoğu bitenlerin Ürünler'de bir listesi var, "1 kalan"ların yok.
  const disardaBiten = data.lowStockMoreOutOfStock ?? 0;
  const disardaAzalan = data.lowStockMoreLow ?? Math.max(0, data.lowStockMore - disardaBiten);

  return (
    <SectionCard
      delay={delay}
      icon={PackageX}
      renk={ACCENTS.amber}
      baslik="Düşük Stok Uyarısı"
      kenarRengi={data.lowStockCount > 0 ? "var(--panel-amber-line)" : undefined}
      rozet={
        data.lowStockCount > 0 ? (
          <Badge variant="outline" className="ml-1 tabular-nums">
            {data.lowStockCount} ürün
          </Badge>
        ) : undefined
      }
    >
      {data.lowStockCount === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          renk={ACCENTS.green}
          mesaj="Stoğu biten ya da azalan ürün yok."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
            {gorunen.map((p, idx) => (
              <Link
                key={p.id}
                href={`/products/${p.id}`}
                className="block animate-in fade-in slide-in-from-bottom-1 duration-300"
                style={{ animationDelay: `${rowDelay(idx)}ms`, animationFillMode: "both" }}
              >
                <div className="flex items-center gap-2.5 py-2 px-3 rounded-lg cursor-pointer transition-all duration-150 hover:bg-muted/40 active:scale-[0.99] group border border-transparent hover:border-[color:var(--panel-amber-line)]">
                  <ProductThumb src={p.imageUrl} />
                  <span className="text-sm truncate group-hover:text-foreground transition-colors flex-1 min-w-0">
                    {p.name}
                  </span>
                  <Badge
                    variant="outline"
                    className="ml-1 shrink-0 tabular-nums"
                    style={{
                      color: p.stock === 0 ? ON_SOFT.red : ON_SOFT.amber,
                      borderColor: p.stock === 0 ? "var(--panel-red-line)" : "var(--panel-amber-line)",
                      backgroundColor: p.stock === 0 ? SOFT.red : SOFT.amber,
                    }}
                  >
                    {p.stock === 0 ? "Bitti" : `${p.stock} adet`}
                  </Badge>
                </div>
              </Link>
            ))}
          </div>
          {/* Kalanı KART İÇİNDE aç: taşan satırların hepsi "stoğu 1 kalan" olduğu için
              Ürünler'deki hiçbir filtre bu kümeyi göstermiyor (bağlantı boş liste açardı). */}
          {(icerdeKalan > 0 || hepsiAcik) && (
            <ExpandRow
              acik={hepsiAcik}
              onToggle={() => setHepsiAcik((v) => !v)}
              label={hepsiAcik ? "Daha az göster" : `+${icerdeKalan} ürün daha`}
            />
          )}
          {disardaBiten > 0 && (
            <MoreRow
              href="/products?filter=out-of-stock"
              label={`+${disardaBiten} ürünün stoğu bitti`}
            />
          )}
          {disardaAzalan > 0 && <MoreNote label={`+${disardaAzalan} üründe son 1 adet kaldı`} />}
        </>
      )}
    </SectionCard>
  );
}

function ProblemCard({ data, delay }: { data: DashboardData; delay: number }) {
  // Taşan satırların türü — sayıların TOPLAMI değil, gerçekten sığmayan küme.
  const kalanZarar = data.problemMoreNegative ?? 0;
  const kalanMaliyet = data.problemMoreMissingCost ?? Math.max(0, data.problemMore - kalanZarar);

  return (
    <SectionCard
      delay={delay}
      icon={AlertTriangle}
      renk={ACCENTS.amber}
      // Listede ilanı olmayan (yalnız maliyeti eksik) ürünler de var → başlık "ilan" demiyor.
      baslik="Acil Müdahale Gerekenler"
      rozet={
        data.problemTotal > 0 ? (
          <Badge variant="outline" className="ml-1 tabular-nums">
            {data.problemTotal}
          </Badge>
        ) : undefined
      }
    >
      {data.problemProducts.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          renk={ACCENTS.green}
          mesaj="Tüm ürün ve ilanlar sağlıklı."
        />
      ) : (
        <>
          <div className="space-y-0.5">
            {data.problemProducts.map((p, idx) => {
              const pb =
                PROBLEM_LABELS[p.problem] ?? {
                  label: p.problem,
                  variant: "outline" as const,
                };
              const platformInfo = p.platform ? PLATFORM_INFO[p.platform] : null;
              return (
                <Link
                  key={`${p.id}-${p.listingId ?? idx}`}
                  href={`/products/${p.id}`}
                  className="block animate-in fade-in slide-in-from-bottom-1 duration-300"
                  style={{ animationDelay: `${rowDelay(idx)}ms`, animationFillMode: "both" }}
                >
                  <div className="flex items-center justify-between py-2.5 px-3 -mx-3 rounded-lg cursor-pointer transition-all duration-150 hover:bg-muted/40 active:scale-[0.995] group">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate group-hover:text-foreground transition-colors flex items-center gap-2">
                        {/* CSS `uppercase` kaldırıldı: "Trendyol" → "TRENDYOL" dönüşümü Türkçe'de
                            noktalı İ üretiyordu. Etiket adı zaten yazıldığı gibi doğru. */}
                        <span
                          className={cn(
                            "text-[10px] tracking-wide px-1.5 py-0.5 rounded font-semibold shrink-0",
                            !platformInfo && "bg-muted text-muted-foreground"
                          )}
                          style={
                            platformInfo
                              ? { backgroundColor: platformInfo.soft, color: platformInfo.onSoft }
                              : undefined
                          }
                        >
                          {/* İlanı olmayan ürünler de bu listede — hangi satırın ilan hangisinin
                              ürün olduğu görünsün, fiyat da ona göre etiketlensin. */}
                          {platformInfo ? platformInfo.label : "Ürün"}
                        </span>
                        {p.name}
                      </p>
                      <p className="text-xs text-muted-foreground tabular-nums mt-0.5">
                        {platformInfo ? "İlan fiyatı" : "Ürün fiyatı"} {formatCurrency(p.salePrice)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 ml-3">
                      {p.profit !== null && (
                        <div className="text-right tabular-nums">
                          <p
                            className="text-xs font-medium"
                            style={{ color: p.profit < 0 ? ACCENTS.red : undefined }}
                          >
                            {formatCurrency(p.profit)}
                          </p>
                          {p.margin !== null && (
                            <p className="text-[10px] text-muted-foreground">
                              {formatPercent(p.margin)}
                            </p>
                          )}
                        </div>
                      )}
                      <Badge variant={pb.variant} className="text-xs shrink-0">
                        {pb.label}
                      </Badge>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
          {/* İki ayrı satır: taşanların çoğu "maliyeti eksik" iken tek bağlantı "zarar edenler"e
              gidiyordu → kullanıcı "+32 satır daha" deyip 12 kayıt görüyordu. */}
          {kalanZarar > 0 && (
            <MoreRow
              href="/products?filter=negative-profit"
              label={`+${kalanZarar} zarar eden ilan`}
            />
          )}
          {kalanMaliyet > 0 && (
            <MoreRow
              href="/products?filter=missing-cost"
              label={`+${kalanMaliyet} maliyeti eksik ürün`}
            />
          )}
        </>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Tazelik satırı                                                       */
/* ------------------------------------------------------------------ */

/**
 * "N dakika önce güncellendi". Panel verisi kaydedilmiş bir kopyadan da gelebiliyor ve
 * tazeleme sessizce başarısız olabiliyor; bayat veya güncellenememiş veri uyarı rengiyle görünür.
 *
 * `updatedAt` = gövdelerin HESAPLANDIĞI an (yanıtın geldiği an değil) ve üç kaynağın EN ESKİSİ:
 * en kötü durum dürüstçe yazılsın.
 */
function FreshnessLine({
  updatedAt,
  yenileniyor,
  guncellenemedi,
}: {
  updatedAt: number | null;
  yenileniyor: boolean;
  guncellenemedi: boolean;
}) {
  const now = useClientNow();
  if (now == null || updatedAt == null) return null;

  const bayat = now - updatedAt > STALE_AFTER_MS;
  const label = `${formatRelativeTime(updatedAt, now)} güncellendi`;
  const shared =
    "mt-1.5 inline-flex items-center gap-1.5 text-[11px] animate-in fade-in duration-500";

  if (yenileniyor) {
    return (
      <span className={cn(shared, "text-muted-foreground")}>
        <RefreshCw className="h-3 w-3 animate-spin" />
        Güncelleniyor…
      </span>
    );
  }

  if (guncellenemedi) {
    return (
      <span
        className={cn(shared, "rounded-full px-2 py-0.5 font-medium")}
        style={{ color: ON_SOFT.amber, backgroundColor: SOFT.amber }}
      >
        <CloudOff className="h-3 w-3" />
        Güncellenemedi · {label}
      </span>
    );
  }

  if (bayat) {
    return (
      <span
        className={cn(shared, "rounded-full px-2 py-0.5 font-medium")}
        style={{ color: ON_SOFT.amber, backgroundColor: SOFT.amber }}
      >
        <span className="relative flex h-1.5 w-1.5">
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70"
            style={{ backgroundColor: ON_SOFT.amber }}
          />
          <span
            className="relative inline-flex h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: ON_SOFT.amber }}
          />
        </span>
        {label}
      </span>
    );
  }

  return (
    <span className={cn(shared, "text-muted-foreground")}>
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: ACCENTS.green }}
      />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Sayfa                                                                */
/* ------------------------------------------------------------------ */

export default function DashboardPage() {
  const { data, isLoading, isError, isFetching, refetch } = useQuery<DashboardData>({
    queryKey: ["dashboard"],
    queryFn: ({ signal }) => fetchJson("/api/dashboard", { signal }),
    // CACHE-FIRST: ürün-türevi kartlar (toplam ürün, eksik maliyet, kâr özeti) sadece ürün/maliyet
    // değişince invalidate olur (ürün edit + cost/kargo/gider/KDV ayarları zaten invalidate ediyor).
    // 60sn'lik interval kaldırıldı (açıkken her dakika ağır /api/dashboard recompute = gereksiz).
    // refetchOnMount:true → invalidate edilmişse girişte tazeler; aksi halde anında cache (isLoading
    // sadece İLK yüklemede true → arka plan refetch'inde cache görünür, SWR).
    staleTime: Infinity,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });

  const queryClient = useQueryClient();
  const [yenileniyor, setYenileniyor] = useState(false);
  // Düğme disabled olsa da klavye/çift tık yarışını kesen ikinci kilit.
  const calisiyorRef = useRef(false);

  /**
   * "Yenile" üç ucun da SUNUCU önbelleğini atlar (`?fresh=1`).
   *
   * Eskiden yalnız istemci sorguları tazeleniyordu; üç uç da kayıtlı gövdeyi döndürdüğü için
   * kullanıcı pazaryerinde fiyat değiştirip Yenile'ye bastığında hiçbir rakam değişmiyor ama
   * satır "az önce güncellendi" oluyordu.
   */
  const yenile = useCallback(() => {
    if (calisiyorRef.current) return;
    calisiyorRef.current = true;
    setYenileniyor(true);
    const taze = <T,>(key: string, url: string) =>
      queryClient.fetchQuery<T>({
        queryKey: [key],
        queryFn: ({ signal }) => fetchJson<T>(url, { signal }),
        staleTime: 0,
      });
    void Promise.allSettled([
      taze<DashboardData>("dashboard", "/api/dashboard?fresh=1"),
      taze<unknown>("orders", "/api/orders?fresh=1"),
      taze<PriceChangesData>("price-changes", `${PRICE_CHANGES_URL}&fresh=1`),
    ]).finally(() => {
      calisiyorRef.current = false;
      setYenileniyor(false);
    });
  }, [queryClient]);

  // Elde veri varken hata görünüyorsa: tazeleme başarısız oldu, ekrandaki rakamlar eski.
  const guncellenemedi = isError && !!data;

  /**
   * Ekranda görünen tazelik = ÜÇ kaynağın en eskisi. Sunucu kayıtlı bir kopyayı anında
   * döndürebildiği için "yanıtın geldiği an" bir haftalık veriyi de "az önce" gösteriyordu;
   * damga artık gövdenin içinden okunuyor ve en kötü durum yazılıyor.
   */
  const siparisHesabi = useComputedAt("orders");
  const fiyatHesabi = useComputedAt("price-changes");
  const ozetHesabi = toMs(data?.computedAt);
  const guncellenmeAni = useMemo(() => {
    const damgalar = [ozetHesabi, siparisHesabi, fiyatHesabi].filter(
      (n): n is number => n !== null
    );
    return damgalar.length > 0 ? Math.min(...damgalar) : null;
  }, [ozetHesabi, siparisHesabi, fiyatHesabi]);

  // Stok sayımına yalnız stok tutan ürünler girer; kalanlar sipariş üzerine üretilir.
  const siparisUzerine = data
    ? Math.max(0, data.totalProducts - data.inStockCount - data.outOfStockCount)
    : 0;

  const platformlar = data?.platforms ?? [];
  const pazaryerleri = platformlar.filter(
    (p) => p.platform === "trendyol" || p.platform === "hepsiburada"
  );
  const shopify = platformlar.find((p) => p.platform === "shopify");

  const cekirdekHata = isError && !data;

  return (
    <div className="p-6 space-y-6 animate-in fade-in duration-300">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Panel</h1>
          <FreshnessLine
            updatedAt={guncellenmeAni}
            yenileniyor={yenileniyor}
            guncellenemedi={guncellenemedi}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={yenile}
          disabled={yenileniyor}
          className="gap-2 shrink-0"
        >
          <RefreshCw className={cn("h-4 w-4", yenileniyor && "animate-spin")} />
          {yenileniyor ? "Yenileniyor…" : "Yenile"}
        </Button>
      </div>

      {/* Sipariş bazlı ciro/kâr — son 30 gün (öne çıkan) */}
      <OrdersSummaryCard delay={0} />

      {/* Genel rakamlar */}
      {isLoading ? (
        // İskelet GERÇEK düzenle birebir aynı: veri gelince satırlar yer değiştirip zıplamaz.
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 items-stretch">
            <StatCardSkeleton delay={80} />
            <StatCardSkeleton delay={120} />
            <StatCardSkeleton delay={160} />
          </div>
          <PlatformSectionLayout
            marketplaces={
              <>
                <PlatformCardSkeleton delay={220} />
                <PlatformCardSkeleton delay={260} />
              </>
            }
            shopify={<PlatformCardSkeleton delay={300} />}
          />
        </>
      ) : cekirdekHata || !data ? (
        <Card
          className="animate-in fade-in slide-in-from-bottom-2 duration-500"
          style={{ animationDelay: "80ms", animationFillMode: "both" }}
        >
          <CardContent>
            <CardError
              mesaj="Ürün ve platform özeti şu an yüklenemedi."
              onRetry={() => void refetch()}
              deneniyor={isFetching}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 items-stretch">
            <StatCard
              title="Toplam Ürün"
              value={<AnimatedNumber value={data.totalProducts} />}
              sub={`Stokta ${data.inStockCount} · Biten ${data.outOfStockCount} · Sipariş üzerine ${siparisUzerine}`}
              icon={Package}
              accentColor={ACCENTS.primary}
              accentSoft={SOFT.primary}
              delay={80}
              href="/products"
            />
            {/* BİRİM açıkça yazılır: bu kart ÜRÜN sayar, platform kartlarının altındaki şerit
                İLAN sayar. Birimsiz bırakıldığında üstte 40, altta toplam 120 görünüyor ve iki
                rakam birbirini tutmuyormuş gibi okunuyordu. */}
            <StatCard
              title="Maliyet Eksik"
              value={<AnimatedNumber value={data.missingCost} />}
              birim="ürün"
              sub="Net kâr hesabı yapılamıyor"
              icon={AlertTriangle}
              accentColor={ACCENTS.amber}
              accentSoft={SOFT.amber}
              delay={120}
              href="/products?filter=missing-cost"
            />
            <StatCard
              title="Zarar Eden İlanlar"
              value={<AnimatedNumber value={data.negativeListings} />}
              birim="ilan"
              sub="Acil müdahale gerek"
              icon={TrendingDown}
              accentColor={ACCENTS.red}
              accentSoft={SOFT.red}
              delay={160}
              href="/products?filter=negative-profit"
            />
          </div>

          <PlatformSectionLayout
            marketplaces={pazaryerleri.map((p, i) => (
              <PlatformCard key={p.platform} stats={p} delay={220 + i * 40} />
            ))}
            shopify={shopify ? <PlatformCard stats={shopify} delay={300} /> : null}
          />
        </>
      )}

      <PriceChangesCard delay={360} />

      {isLoading ? (
        <>
          <SectionCard delay={420} icon={PackageX} renk="var(--muted-foreground)" baslik="Düşük Stok Uyarısı">
            <LowStockSkeleton />
          </SectionCard>
          <SectionCard
            delay={480}
            icon={AlertTriangle}
            renk="var(--muted-foreground)"
            baslik="Acil Müdahale Gerekenler"
          >
            <ProblemSkeleton />
          </SectionCard>
        </>
      ) : data ? (
        <>
          <LowStockCard data={data} delay={420} />
          <ProblemCard data={data} delay={480} />
        </>
      ) : (
        // Bu iki kart eskiden veri gelmeyince SESSİZCE kayboluyordu; artık kendi hata
        // durumlarını gösteriyorlar.
        <>
          <SectionCard delay={420} icon={PackageX} renk={ACCENTS.amber} baslik="Düşük Stok Uyarısı">
            <CardError
              mesaj="Düşük stok listesi şu an yüklenemedi."
              onRetry={() => void refetch()}
              deneniyor={isFetching}
            />
          </SectionCard>
          <SectionCard
            delay={480}
            icon={AlertTriangle}
            renk={ACCENTS.amber}
            baslik="Acil Müdahale Gerekenler"
          >
            <CardError
              mesaj="Acil müdahale listesi şu an yüklenemedi."
              onRetry={() => void refetch()}
              deneniyor={isFetching}
            />
          </SectionCard>
        </>
      )}
    </div>
  );
}
