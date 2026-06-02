"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  ClipboardList,
  RefreshCw,
  Search,
  ChevronDown,
  Truck,
  AlertTriangle,
  PackageX,
  Package,
  KeyRound,
  TrendingUp,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { PlatformLogo } from "@/components/PlatformLogo";
import { cn } from "@/lib/utils";

type OrderStatusKind = "pending" | "processing" | "shipped" | "delivered" | "cancelled" | "other";

interface UnifiedOrderItem {
  name: string;
  quantity: number;
  image: string | null;
}
interface UnifiedOrder {
  platform: "shopify" | "trendyol" | "hepsiburada";
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
  trackingNumber: string | null;
  cargoProvider: string | null;
}
interface PlatformStatus {
  ok: boolean;
  count: number;
  needsAdminToken?: boolean;
  notConfigured?: boolean;
  error?: string;
}
interface SummaryBucket {
  revenue: number;
  profit: number;
  orderCount: number;
}
interface OrdersResponse {
  orders: UnifiedOrder[];
  summary: { days: number; shopify: SummaryBucket; trendyol: SummaryBucket; hepsiburada: SummaryBucket; total: SummaryBucket };
  shopify: PlatformStatus;
  trendyol: PlatformStatus;
  hepsiburada: PlatformStatus;
}

const PLATFORM_INFO = {
  shopify: { label: "Shopify", color: "oklch(0.60 0.16 152)" },
  trendyol: { label: "Trendyol", color: "oklch(0.72 0.17 60)" },
  hepsiburada: { label: "Hepsiburada", color: "oklch(0.66 0.19 38)" },
} as const;

const STATUS_STYLE: Record<OrderStatusKind, { label: string; cls: string; dot: string }> = {
  pending: { label: "Bekleyen", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30", dot: "bg-amber-500" },
  processing: { label: "Hazırlanıyor", cls: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30", dot: "bg-blue-500" },
  shipped: { label: "Kargoda", cls: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border-indigo-500/30", dot: "bg-indigo-500" },
  delivered: { label: "Teslim", cls: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30", dot: "bg-green-500" },
  cancelled: { label: "İptal/İade", cls: "bg-destructive/15 text-destructive border-destructive/30", dot: "bg-destructive" },
  other: { label: "Diğer", cls: "bg-muted text-muted-foreground border-border", dot: "bg-muted-foreground" },
};
const STATUS_ORDER: OrderStatusKind[] = ["pending", "processing", "shipped", "delivered", "cancelled"];

function fmtMoney(amount: number, currency = "TRY") {
  try {
    return new Intl.NumberFormat("tr-TR", { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${Math.round(amount)} ${currency}`;
  }
}
function fmtMoney2(amount: number, currency = "TRY") {
  try {
    return new Intl.NumberFormat("tr-TR", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function OrdersPage() {
  const { data, isLoading, isFetching, refetch, error } = useQuery<OrdersResponse>({
    queryKey: ["orders"],
    queryFn: ({ signal }) => fetch("/api/orders", { signal }).then((r) => r.json()),
    // 5dk taze: sekmeye dönüşte 3 pazaryeri API'sini tekrar çağırma (anında cache). Tazelemek için "Yenile".
    staleTime: 5 * 60_000,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });

  const [platform, setPlatform] = useState<"all" | "shopify" | "trendyol" | "hepsiburada">("all");
  const [status, setStatus] = useState<"all" | OrderStatusKind>("all");
  const [search, setSearch] = useState("");

  const orders = useMemo(() => data?.orders ?? [], [data]);
  const summary = data?.summary;

  const statusCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const o of orders) c[o.statusKind] = (c[o.statusKind] ?? 0) + 1;
    return c;
  }, [orders]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((o) => {
      if (platform !== "all" && o.platform !== platform) return false;
      if (status !== "all" && o.statusKind !== status) return false;
      if (q) {
        const hay = `${o.orderNumber} ${o.customer ?? ""} ${o.items.map((i) => i.name).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [orders, platform, status, search]);

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      {/* Başlık */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ClipboardList className="h-6 w-6 text-primary" /> Siparişler
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Son {summary?.days ?? 30} günde Shopify ve Trendyol&apos;dan gelen siparişler — canlı.
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={isFetching} onClick={() => refetch()} className="gap-2 shrink-0">
          <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
          Yenile
        </Button>
      </div>

      {/* 30 günlük özet şeridi */}
      {summary && summary.total.orderCount > 0 && (
        <Card className="overflow-hidden">
          <CardContent className="py-3 grid grid-cols-2 sm:grid-cols-5 gap-3">
            <SummaryStat label={`${summary.total.orderCount} sipariş`} value={fmtMoney(summary.total.revenue)} sub="Toplam ciro" strong />
            <SummaryStat
              label="Net kâr"
              value={fmtMoney(summary.total.profit)}
              sub="tahmini (eşleşen)"
              color={summary.total.profit >= 0 ? "oklch(0.72 0.18 145)" : "oklch(0.63 0.22 25)"}
            />
            <SummaryStat label="Shopify" value={fmtMoney(summary.shopify.revenue)} sub={`${summary.shopify.orderCount} sipariş`} platform="shopify" />
            <SummaryStat label="Trendyol" value={fmtMoney(summary.trendyol.revenue)} sub={`${summary.trendyol.orderCount} sipariş`} platform="trendyol" />
            <SummaryStat label="Hepsiburada" value={fmtMoney(summary.hepsiburada.revenue)} sub={`${summary.hepsiburada.orderCount} sipariş`} platform="hepsiburada" />
          </CardContent>
        </Card>
      )}

      {/* Platform uyarıları */}
      {data?.shopify?.needsAdminToken && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="py-3 flex items-start gap-3">
            <KeyRound className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <div className="text-sm">
              <p className="font-medium text-amber-600 dark:text-amber-400">Shopify siparişleri için Client ID + Secret gerekli</p>
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

      {/* Kontroller */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-border p-0.5 bg-muted/30">
          {(["all", "shopify", "trendyol", "hepsiburada"] as const).map((p) => (
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

      {/* Durum filtreleri */}
      <div className="flex flex-wrap gap-1.5">
        <StatusChip active={status === "all"} onClick={() => setStatus("all")} label="Hepsi" count={orders.length} />
        {STATUS_ORDER.map((k) => (
          <StatusChip key={k} active={status === k} onClick={() => setStatus(k)} label={STATUS_STYLE[k].label} count={statusCounts[k] ?? 0} dot={STATUS_STYLE[k].dot} />
        ))}
      </div>

      {/* Liste */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[76px] w-full rounded-xl" />
          ))}
        </div>
      ) : error ? (
        <EmptyState icon={AlertTriangle} title="Siparişler yüklenemedi" description="API bağlantısında sorun oluştu. Yenile'ye basıp tekrar dene." />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={PackageX}
          title={orders.length === 0 ? "Son 30 günde sipariş yok" : "Filtreyle eşleşen sipariş yok"}
          description={
            orders.length === 0
              ? "Platformlardan canlı sipariş gelince burada listelenir. API bilgilerinin Entegrasyonlar'da tanımlı olduğundan emin ol."
              : "Filtre veya aramayı değiştirip tekrar dene."
          }
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((o) => (
            <OrderRow key={`${o.platform}-${o.id}`} order={o} />
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  sub,
  color,
  platform,
  strong,
}: {
  label: string;
  value: string;
  sub: string;
  color?: string;
  platform?: "shopify" | "trendyol" | "hepsiburada";
  strong?: boolean;
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
      <div className="text-[10px] text-muted-foreground">{sub}</div>
    </div>
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

function Thumb({ src, size = "h-12 w-12" }: { src: string | null; size?: string }) {
  return (
    <div className={cn("relative shrink-0 rounded-lg overflow-hidden border bg-muted flex items-center justify-center", size)}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="max-w-full max-h-full object-contain" loading="lazy" />
      ) : (
        <Package className="h-5 w-5 text-muted-foreground/50" />
      )}
    </div>
  );
}

function OrderRow({ order }: { order: UnifiedOrder }) {
  const [open, setOpen] = useState(false);
  const info = PLATFORM_INFO[order.platform];
  const st = STATUS_STYLE[order.statusKind];
  const firstItem = order.items[0];
  const extraItems = order.items.length - 1;
  const profitColor = order.profit == null ? "" : order.profit >= 0 ? "text-green-600 dark:text-green-500" : "text-destructive";

  return (
    <Card className="overflow-hidden transition-colors hover:border-primary/30">
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
            <span className="font-bold text-sm tabular-nums">{fmtMoney2(order.total, order.currency)}</span>
            {order.profit != null && (
              <span className={cn("text-[11px] font-semibold tabular-nums flex items-center gap-0.5", profitColor)}>
                <TrendingUp className="h-3 w-3" />
                {order.profit >= 0 ? "+" : ""}
                {fmtMoney2(order.profit)}
                {order.profitPartial && <span className="opacity-60" title="Bazı ürünler eşleşmedi — kâr kısmi">*</span>}
              </span>
            )}
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
                {order.items.map((it, i) => (
                  <div key={i} className="flex items-center gap-2.5">
                    <Thumb src={it.image} size="h-9 w-9" />
                    <span className="flex-1 min-w-0 truncate text-xs text-foreground/90">{it.name}</span>
                    <span className="tabular-nums text-xs text-muted-foreground shrink-0">×{it.quantity}</span>
                  </div>
                ))}
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
                  <span className="tabular-nums font-medium">{fmtMoney2(order.total, order.currency)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Tahmini net kâr</span>
                  {order.profit != null ? (
                    <span className={cn("tabular-nums font-semibold", profitColor)}>
                      {order.profit >= 0 ? "+" : ""}{fmtMoney2(order.profit)}{order.profitPartial && "*"}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">— (maliyet eşleşmedi)</span>
                  )}
                </div>
                {order.profitPartial && (
                  <p className="text-[10px] text-muted-foreground/70">* Bazı ürünler ürün listesiyle eşleşmedi; kâr kısmi.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
