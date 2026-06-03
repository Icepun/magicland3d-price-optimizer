"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { Plus, Minus, Search, Trash2, Package, Link2, Loader2, AlertTriangle, EyeOff, Eye, RefreshCw, ChevronRight, Layers, Tag, Hammer, Printer } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStockWriter } from "@/lib/use-stock-writer";
import { ProductPrintModal } from "@/components/products/ProductPrintModal";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import Link from "next/link";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

/**
 * Türkçe-duyarlı arama normalleştirme: küçük harfe indir + diakritikleri sadeleştir
 * ("Kırmızı" → "kirmizi", "ŞıK" → "sik"). Kullanıcı aksansız/eksik yazsa da bulur.
 */
function normalizeSearch(s: string): string {
  return s
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/â/g, "a")
    .replace(/î/g, "i")
    .replace(/û/g, "u");
}

/**
 * Türkçe alfabetik sıralama (ç, ğ, ı, ö, ş, ü doğru yerde — sona atılmaz).
 * sensitivity: "base" → büyük/küçük harf duyarsız; numeric → "Kol 2" < "Kol 10".
 */
const trCollator = new Intl.Collator("tr-TR", { sensitivity: "base", numeric: true });

interface Product {
  id: string;
  barcode: string;
  sku: string;
  name: string;
  alias: string | null;
  categoryName: string;
  currentSalePrice: number;
  listPrice: number | null;
  stock: number;
  desi: number | null;
  imageUrl: string | null;
  isActive: boolean;
  hidden: boolean;
  madeToOrder: boolean;
  source: string;
  appliedCommissionRule: {
    id: string;
    name: string;
    categoryName: string | null;
    commissionRate: number;
    fixedCommission: number;
  } | null;
  cost: {
    totalCost: number | null;
    manualCost: number | null;
    packagingCost: number | null;
  } | null;
  /** Güncel ayarlardan yeniden hesaplanan toplam maliyet (zam dahil). */
  resolvedTotalCost: number | null;
  /** Fly'da hesaplanan güncel net kâr (KDV+kargo+komisyon dahil, indirim payı uygulanmış). */
  currentNetProfit: number | null;
  currentProfitMargin: number | null;
  hasCost: boolean;
  platforms: Array<{
    platform: "shopify" | "trendyol" | "hepsiburada";
    listingId: string;
    salePrice: number;
    stock: number;
    netProfit: number | null;
    profitMargin: number | null;
    commissionMissing: boolean;
    minOrderQty?: number;
  }>;
  variantLabel?: string | null;
  variantGroup?: { id: string; name: string } | null;
}

const PLATFORM_COLOR: Record<string, string> = {
  shopify: "oklch(0.60 0.16 152)", // yeşil
  trendyol: "oklch(0.72 0.17 60)", // turuncu
  hepsiburada: "oklch(0.66 0.19 38)", // HB turuncu
};

const AddProductSchema = z.object({
  barcode: z.string().min(1, "Barkod zorunlu"),
  sku: z.string().min(1, "SKU zorunlu"),
  name: z.string().min(1, "Ad zorunlu"),
  categoryName: z.string().min(1, "Kategori zorunlu"),
  currentSalePrice: z.coerce.number().positive("Pozitif olmali"),
  stock: z.coerce.number().int().min(0).default(0),
  desi: z.coerce.number().positive().optional().or(z.literal("")),
  productCost: z.coerce.number().min(0).optional().or(z.literal("")),
  packagingCost: z.coerce.number().min(0).optional().or(z.literal("")),
});

type AddProductForm = z.infer<typeof AddProductSchema>;

type FilterMode = "active" | "out-of-stock" | "inactive" | "all" | "negative-profit" | "missing-cost" | "hidden" | "most-profitable";


async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${url} ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function ProductImage({ src, name }: { src: string | null; name: string }) {
  const [errored, setErrored] = useState(false);

  if (!src || errored) {
    return (
      <div className="w-10 h-10 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
        <Package className="h-5 w-5 text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="w-10 h-10 rounded-md border bg-white flex items-center justify-center flex-shrink-0 overflow-hidden">
      <img
        src={src}
        alt={name}
        className="max-w-full max-h-full object-contain"
        onError={() => setErrored(true)}
        loading="lazy"
      />
    </div>
  );
}

/** URL ?filter=... query string'inden ilk filter mode'u oku (SSR safe). */
function readFilterFromUrl(): FilterMode {
  if (typeof window === "undefined") return "active";
  const f = new URLSearchParams(window.location.search).get("filter");
  if (
    f === "active" ||
    f === "out-of-stock" ||
    f === "inactive" ||
    f === "all" ||
    f === "negative-profit" ||
    f === "missing-cost" ||
    f === "hidden" ||
    f === "most-profitable"
  ) {
    return f;
  }
  return "active";
}

/**
 * Tek ürün satırı — memo'lu: yalnızca KENDİ prop'ları değişince render olur. Scroll'da
 * visibleCount artınca mevcut satırlar (product ref'i + primitive prop'ları aynı kaldığı için)
 * yeniden render OLMAZ → uzun listede scroll yağ gibi akar. Tüm handler'lar parent'ta useCallback.
 */
const ProductRow = memo(function ProductRow({
  product,
  isMember,
  isSelected,
  isEditingAlias,
  aliasValue,
  integrations,
  onToggleSelect,
  onAdjustStock,
  onAliasStart,
  onAliasChange,
  onAliasCommit,
  onAliasCancel,
  onMatch,
  onToggleHidden,
  onDelete,
  onToggleMadeToOrder,
  onPrint,
}: {
  product: Product;
  isMember: boolean;
  isSelected: boolean;
  isEditingAlias: boolean;
  aliasValue: string;
  integrations: { shopify: boolean; trendyol: boolean; hepsiburada: boolean } | undefined;
  onToggleSelect: (id: string, checked: boolean) => void;
  onAdjustStock: (id: string, delta: number, current: number) => void;
  onAliasStart: (id: string, current: string) => void;
  onAliasChange: (value: string) => void;
  onAliasCommit: () => void;
  onAliasCancel: () => void;
  onMatch: (productId: string, productName: string, platform: "trendyol" | "hepsiburada") => void;
  onToggleHidden: (id: string, hidden: boolean) => void;
  onDelete: (id: string, name: string) => void;
  onToggleMadeToOrder: (id: string, value: boolean) => void;
  onPrint: (id: string, name: string) => void;
}) {
  const cost = product.resolvedTotalCost ?? product.cost?.totalCost ?? product.cost?.manualCost;
  const findPlatform = (p: "shopify" | "trendyol" | "hepsiburada") =>
    product.platforms.find((x) => x.platform === p);

  return (
    <TableRow
      className={cn(
        "group hover:bg-muted/50",
        !product.isActive && "opacity-50",
        isMember && "bg-muted/15"
      )}
    >
      <TableCell className="py-2">
        <Checkbox checked={isSelected} onCheckedChange={(v) => onToggleSelect(product.id, !!v)} />
      </TableCell>
      <TableCell className={cn("py-2 pr-0", isMember && "pl-6")}>
        <ProductImage src={product.imageUrl} name={product.name} />
      </TableCell>
      <TableCell className="max-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          {isEditingAlias ? (
            <input
              autoFocus
              value={aliasValue}
              maxLength={80}
              placeholder="takma ad"
              onChange={(e) => onAliasChange(e.target.value)}
              onBlur={onAliasCommit}
              onKeyDown={(e) => {
                if (e.key === "Enter") onAliasCommit();
                else if (e.key === "Escape") onAliasCancel();
              }}
              onClick={(e) => e.stopPropagation()}
              className="shrink-0 w-24 rounded border border-primary/40 bg-background px-1.5 py-0.5 text-[11px] font-medium outline-none focus:border-primary"
            />
          ) : product.alias ? (
            <button
              type="button"
              title="Takma adı düzenle"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onAliasStart(product.id, product.alias ?? "");
              }}
              className="shrink-0 max-w-[8rem] truncate rounded bg-primary/15 text-primary text-[10px] font-semibold px-1.5 py-0.5 hover:bg-primary/25 transition-colors"
            >
              {product.alias}
            </button>
          ) : (
            <button
              type="button"
              title="Takma ad ekle"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onAliasStart(product.id, "");
              }}
              className="shrink-0 grid place-items-center h-5 w-5 rounded text-muted-foreground/40 hover:text-primary hover:bg-primary/10 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
            >
              <Tag className="h-3 w-3" />
            </button>
          )}
          <Link
            href={`/products/${product.id}`}
            className="font-medium hover:underline line-clamp-1 block text-sm min-w-0"
            title={product.name}
          >
            {product.name}
          </Link>
        </div>
        <div className="text-[11px] text-muted-foreground/70 truncate flex items-center gap-1.5 mt-0.5">
          <span className="font-mono">{product.barcode}</span>
          <span className="opacity-60">·</span>
          <span className="truncate">{product.categoryName}</span>
        </div>
        {isMember && product.variantLabel && (
          <span className="inline-flex items-center gap-1 mt-1 text-[10px] font-medium text-primary">
            <Layers className="h-3 w-3" /> {product.variantLabel}
          </span>
        )}
      </TableCell>
      <TableCell className="py-2">
        {product.madeToOrder ? (
          <div className="flex justify-center">
            <span
              className="text-[10px] leading-tight text-center text-muted-foreground bg-muted/60 rounded px-1.5 py-0.5"
              title="Sipariş üzerine üretilir — stok takip edilmez"
            >
              Sipariş<br />üzerine
            </span>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-1.5">
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              disabled={product.stock <= 0}
              onClick={() => onAdjustStock(product.id, -1, product.stock)}
            >
              <Minus className="h-4 w-4" />
            </Button>
            <span
              className={`tabular-nums text-sm font-semibold min-w-[2ch] text-center ${
                product.stock === 0
                  ? "text-destructive"
                  : product.stock === 1
                    ? "text-amber-500"
                    : "text-foreground"
              }`}
              title={
                product.stock === 0 ? "Stok tükendi" : product.stock === 1 ? "Kritik stok" : undefined
              }
            >
              {product.stock}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              onClick={() => onAdjustStock(product.id, 1, product.stock)}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs">
        {cost !== null && cost !== undefined ? (
          formatCurrency(cost)
        ) : (
          <span className="text-[10px] text-muted-foreground/60 italic">eksik</span>
        )}
      </TableCell>
      {(["shopify", "trendyol", "hepsiburada"] as const).map((platform) => {
        const p = findPlatform(platform);
        const integrationActive = integrations?.[platform] ?? false;
        if (!p) {
          if (!integrationActive) {
            return (
              <TableCell key={platform} className="text-center">
                <span className="text-[10px] text-muted-foreground/40">Entegrasyon yok</span>
              </TableCell>
            );
          }
          if (platform === "shopify") {
            return (
              <TableCell key={platform} className="text-center">
                <span className="text-[10px] text-muted-foreground/40">—</span>
              </TableCell>
            );
          }
          return (
            <TableCell key={platform} className="text-center">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px] px-2"
                onClick={() => onMatch(product.id, product.name, platform as "trendyol" | "hepsiburada")}
              >
                <Link2 className="h-3 w-3 mr-1" />
                Ürün Seç
              </Button>
            </TableCell>
          );
        }
        const isLoss = p.netProfit !== null && p.netProfit < 0;
        const isThin = p.netProfit !== null && p.netProfit >= 0 && (p.profitMargin ?? 0) < 0.1;
        return (
          <TableCell key={platform} className="text-center">
            <div className="text-xs font-medium tabular-nums">{formatCurrency(p.salePrice)}</div>
            {p.commissionMissing && (
              <div className="text-[10px] text-destructive font-semibold mt-0.5 flex items-center justify-center gap-1">
                <AlertTriangle className="h-3 w-3" /> Komisyon gir!
              </div>
            )}
            {p.netProfit !== null ? (
              <div
                className={`text-[11px] tabular-nums mt-0.5 ${
                  isLoss ? "text-destructive font-medium" : isThin ? "text-amber-500" : "text-green-500"
                }`}
              >
                {formatCurrency(p.netProfit)}{" "}
                <span className="opacity-70">({formatPercent(p.profitMargin ?? 0)})</span>
              </div>
            ) : (
              <div className="text-[10px] text-muted-foreground/60 mt-0.5">maliyet eksik</div>
            )}
            {(p.minOrderQty ?? 1) > 1 && (
              <div
                className="text-[9px] text-amber-500/90 mt-0.5"
                title={`Trendyol min sipariş ${p.minOrderQty} adet — kâr ${p.minOrderQty} ürün üzerinden hesaplandı`}
              >
                min {p.minOrderQty} adet
              </div>
            )}
          </TableCell>
        );
      })}
      <TableCell>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground/60 hover:text-primary"
            title="Baskı başlat"
            onClick={() => onPrint(product.id, product.name)}
          >
            <Printer className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "h-8 w-8",
              product.madeToOrder ? "text-primary" : "text-muted-foreground/50 hover:text-foreground"
            )}
            title={product.madeToOrder ? "Sipariş üzerine üretilir (kapat)" : "Sipariş üzerine üretilir olarak işaretle"}
            onClick={() => onToggleMadeToOrder(product.id, !product.madeToOrder)}
          >
            <Hammer className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            title={product.hidden ? "Geri getir" : "Gizle"}
            onClick={() => onToggleHidden(product.id, !product.hidden)}
          >
            {product.hidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive/70 hover:text-destructive"
            title="Sil"
            onClick={() => onDelete(product.id, product.name)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
});

export default function ProductsPage() {
  const [globalFilter, setGlobalFilter] = useState("");
  // Arama debounce: kutuya yazı ANINDA yazılır (globalFilter), pahalı filtreleme 200ms sonra
  // (debouncedFilter) çalışır → her tuşta yüzlerce üründe normalize+filtre+grupla+sırala
  // fırtınası olmaz, yazarken takılma biter.
  const [debouncedFilter, setDebouncedFilter] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedFilter(globalFilter), 200);
    return () => clearTimeout(t);
  }, [globalFilter]);
  const [filterMode, setFilterMode] = useState<FilterMode>("active");
  const [addOpen, setAddOpen] = useState(false);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null);
  const [printTarget, setPrintTarget] = useState<{ id: string; name: string } | null>(null);
  const [matchModal, setMatchModal] = useState<{
    productId: string;
    productName: string;
    platform: "trendyol" | "hepsiburada";
  } | null>(null);
  const queryClient = useQueryClient();

  // URL filter parametresinden başlangıç değeri (mount sonrası, hydration safe)
  useEffect(() => {
    const f = readFilterFromUrl();
    if (f !== filterMode) setFilterMode(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const {
    data: products = [],
    isLoading,
    isError,
  } = useQuery<Product[]>({
    queryKey: ["products", filterMode],
    queryFn: ({ signal }) =>
      // "most-profitable" sunucuda yok → aktif ürünleri çek, client'ta sırala.
      // signal: başka sayfaya geçince bu (ağır) fetch iptal olur → birikme/boşa parse yok.
      fetchJson<Product[]>(
        `/api/products?filter=${filterMode === "most-profitable" ? "active" : filterMode}`,
        { signal }
      ),
    // CACHE-FIRST: liste cache'te yaşar, KENDİLİĞİNDEN tazelenmez (staleTime: Infinity).
    // Yalnızca bir değişiklik onu invalidate edince refetch olur:
    //   • stok/maliyet/gizle/alias/madeToOrder düzeni → optimistic (zaten cache'te güncel)
    //   • Maliyet&Paketleme / Kargo / Ek Giderler / KDV değişimi → invalidate ["products"]
    //   • "Fiyatları Güncelle" butonu / ürün ekle-sil → invalidate ["products"]
    // refetchOnMount:true → invalidate edilmişse bir sonraki girişte tazeler, edilmemişse anında cache.
    // (Eski 15sn: her ~15sn'de bir girişte 368 ürünü baştan çekip kasıyordu — kaldırıldı.)
    staleTime: Infinity,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });

  // Entegrasyon durumu — hangi platformlar konfigüre
  const { data: integrations } = useQuery<{
    shopify: boolean;
    trendyol: boolean;
    hepsiburada: boolean;
  }>({
    queryKey: ["integrations-status"],
    queryFn: () => fetchJson("/api/integrations/status"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/products/${id}`, { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Ürün silindi");
    },
  });

  // Optimistic stok: UI anında güncellenir, yazma arka planda + debounce'lu + retry'lı.
  const { adjustStock } = useStockWriter();

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) =>
      fetchJson<{ deleted: number }>("/api/products/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      }),
    // Optimistic: seçilenleri listeden ANINDA çıkar + seçimi/dialog'u kapat; hata olursa geri al.
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: ["products"] });
      const prev = queryClient.getQueriesData({ queryKey: ["products"] });
      const idset = new Set(ids);
      queryClient.setQueriesData<Product[] | undefined>({ queryKey: ["products"] }, (old) =>
        Array.isArray(old) ? old.filter((p) => !idset.has(p.id)) : old
      );
      setSelectedIds(new Set());
      setBulkDeleteOpen(false);
      return { prev };
    },
    onError: (e: Error, _v, ctx) => {
      ctx?.prev?.forEach(([key, data]) => queryClient.setQueryData(key, data));
      toast.error(`Toplu silme başarısız: ${e.message} (geri alındı)`);
    },
    onSuccess: (data) => toast.success(`${data.deleted} ürün silindi`),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const bulkVisibilityMutation = useMutation({
    mutationFn: ({ ids, hidden }: { ids: string[]; hidden: boolean }) =>
      fetchJson<{ updated: number }>("/api/products/bulk-visibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, hidden }),
      }),
    // Optimistic: seçilenler mevcut görünümden ANINDA kalkar + seçim temizlenir; hata olursa geri al.
    onMutate: async ({ ids }) => {
      await queryClient.cancelQueries({ queryKey: ["products"] });
      const prev = queryClient.getQueriesData({ queryKey: ["products"] });
      const idset = new Set(ids);
      queryClient.setQueriesData<Product[] | undefined>({ queryKey: ["products"] }, (old) =>
        Array.isArray(old) ? old.filter((p) => !idset.has(p.id)) : old
      );
      setSelectedIds(new Set());
      return { prev };
    },
    onError: (e: Error, _v, ctx) => {
      ctx?.prev?.forEach(([key, data]) => queryClient.setQueryData(key, data));
      toast.error(`${e.message} (geri alındı)`);
    },
    onSuccess: (data, variables) =>
      toast.success(variables.hidden ? `${data.updated} ürün gizlendi` : `${data.updated} ürün geri getirildi`),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  // Tek ürün gizle/göster (satır içi)
  const toggleHiddenMutation = useMutation({
    mutationFn: ({ id, hidden }: { id: string; hidden: boolean }) =>
      fetch(`/api/products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden }),
      }).then((r) => r.json()),
    // Optimistic: ürün ANINDA mevcut listeden çıkar (gizlenince aktif görünümde, geri
    // gelince gizli görünümünde kalmamalı). UI beklemez; hata olursa geri alınır.
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ["products"] });
      const prev = queryClient.getQueriesData({ queryKey: ["products"] });
      queryClient.setQueriesData<Product[] | undefined>({ queryKey: ["products"] }, (old) =>
        Array.isArray(old) ? old.filter((p) => p.id !== id) : old
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      ctx?.prev?.forEach(([key, data]) => queryClient.setQueryData(key, data));
      toast.error("İşlem başarısız");
    },
    onSuccess: (_data, variables) => {
      // Liste optimistic güncellendi → tekrar çekme yok. Panel sayacı tazelensin.
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success(variables.hidden ? "Ürün gizlendi" : "Ürün geri getirildi");
    },
  });

  // Satır-içi takma ad düzenleme (id + anlık değer + orijinal — değişmediyse yazma yok).
  const [aliasEdit, setAliasEdit] = useState<{ id: string; value: string; original: string } | null>(null);

  const setAliasMutation = useMutation({
    mutationFn: async ({ id, alias }: { id: string; alias: string | null }) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12_000);
      try {
        const res = await fetch(`/api/products/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ alias }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error("alias");
        return res.json();
      } finally {
        clearTimeout(t);
      }
    },
    retry: 2,
    // Optimistic: çip anında güncellenir; kısa kopmada sessizce tekrar dener, kalıcı hatada geri alır.
    onMutate: async ({ id, alias }) => {
      await queryClient.cancelQueries({ queryKey: ["products"] });
      const prev = queryClient.getQueriesData({ queryKey: ["products"] });
      queryClient.setQueriesData<Product[] | undefined>({ queryKey: ["products"] }, (old) =>
        Array.isArray(old) ? old.map((p) => (p.id === id ? { ...p, alias } : p)) : old
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      ctx?.prev?.forEach(([key, data]) => queryClient.setQueryData(key, data));
      toast.error("Takma ad kaydedilemedi — bağlantını kontrol et (geri alındı)");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["products"] }),
  });

  // aliasEdit'i ref'te tut → commitAlias her render'da yeni closure olmaz (memo kırılmaz).
  const aliasEditRef = useRef(aliasEdit);
  aliasEditRef.current = aliasEdit;
  const commitAlias = useCallback(() => {
    const ae = aliasEditRef.current;
    if (!ae) return;
    const value = ae.value.trim();
    if (value !== ae.original.trim()) {
      setAliasMutation.mutate({ id: ae.id, alias: value || null });
    }
    setAliasEdit(null);
  }, [setAliasMutation]);

  // ProductRow'a geçilen STABİL handler'lar — useCallback, böylece scroll'da memo'lu satırlar
  // (prop ref'leri değişmediği için) yeniden render olmaz.
  const handleToggleSelect = useCallback((id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const handleAliasStart = useCallback((id: string, current: string) => {
    setAliasEdit({ id, value: current, original: current });
  }, []);
  const handleAliasChange = useCallback((value: string) => {
    setAliasEdit((prev) => (prev ? { ...prev, value } : prev));
  }, []);
  const handleAliasCancel = useCallback(() => setAliasEdit(null), []);
  const handleMatch = useCallback(
    (productId: string, productName: string, platform: "trendyol" | "hepsiburada") =>
      setMatchModal({ productId, productName, platform }),
    []
  );
  const handleToggleHidden = useCallback(
    (id: string, hidden: boolean) => toggleHiddenMutation.mutate({ id, hidden }),
    [toggleHiddenMutation]
  );
  // Silme ANINDA değil — önce onay penceresi (yanlışlıkla tıklama veri kaybettirmesin).
  const handleDelete = useCallback(
    (id: string, name: string) => setDeleteConfirm({ id, name }),
    []
  );
  const handlePrint = useCallback(
    (id: string, name: string) => setPrintTarget({ id, name }),
    []
  );

  // Listeden "Sipariş üzerine üretilir" hızlı toggle — optimistic (anında), refetch YOK.
  const setMadeToOrderMutation = useMutation({
    mutationFn: ({ id, madeToOrder }: { id: string; madeToOrder: boolean }) =>
      fetch(`/api/products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ madeToOrder }),
      }).then((r) => {
        if (!r.ok) throw new Error("madeToOrder");
        return r.json();
      }),
    onMutate: async ({ id, madeToOrder }) => {
      await queryClient.cancelQueries({ queryKey: ["products"] });
      const prev = queryClient.getQueriesData({ queryKey: ["products"] });
      queryClient.setQueriesData<Product[] | undefined>({ queryKey: ["products"] }, (old) =>
        Array.isArray(old) ? old.map((p) => (p.id === id ? { ...p, madeToOrder } : p)) : old
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      ctx?.prev?.forEach(([key, data]) => queryClient.setQueryData(key, data));
      toast.error("İşlem başarısız (geri alındı)");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["dashboard"], refetchType: "none" }),
  });
  const handleToggleMadeToOrder = useCallback(
    (id: string, madeToOrder: boolean) => setMadeToOrderMutation.mutate({ id, madeToOrder }),
    [setMadeToOrderMutation]
  );

  // "Yenile" — TEK buton: tüm platformların fiyatlarını çeker + liste/panel/siparişleri DB'den
  // tazeler (başka cihazdaki değişiklikler dahil). İlerleme çubuğu aşamayı + %'yi + X/Y'yi gösterir.
  const [refreshProgress, setRefreshProgress] = useState<{ total: number; done: number; label: string } | null>(null);
  const runRefreshAll = async () => {
    if (refreshProgress) return; // zaten çalışıyor
    const platforms = (["shopify", "trendyol", "hepsiburada"] as const).filter((p) => integrations?.[p]);
    const label = (p: string) =>
      `${p === "hepsiburada" ? "Hepsiburada" : p === "trendyol" ? "Trendyol" : "Shopify"} fiyatları çekiliyor…`;
    const total = platforms.length + 1; // +1: liste/panel tazeleme adımı
    let done = 0;
    let changed = 0;
    setRefreshProgress({ total, done, label: platforms.length ? label(platforms[0]) : "Yenileniyor…" });
    for (const p of platforms) {
      setRefreshProgress({ total, done, label: label(p) });
      const res = await fetch(`/api/${p}/sync-products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "refresh-prices" }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      changed += res?.changed ?? 0;
      done += 1;
      setRefreshProgress({ total, done, label: label(p) });
    }
    // Son adım: DB + cache tazele (kullanıcı tetikledi → bu refetch İSTENİYOR; cross-device dahil).
    setRefreshProgress({ total, done, label: "Liste & panel güncelleniyor…" });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["products"] }),
      queryClient.invalidateQueries({ queryKey: ["orders"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["price-changes"] }),
      queryClient.invalidateQueries({ queryKey: ["unmatched-listings"] }),
    ]);
    done += 1;
    setRefreshProgress({ total, done, label: "Tamamlandı ✓" });
    toast.success(changed > 0 ? `Yenilendi · ${changed} fiyat değişti` : "Her şey güncel");
    setTimeout(() => setRefreshProgress(null), 1000);
  };

  const form = useForm<AddProductForm>({
    resolver: zodResolver(AddProductSchema),
    defaultValues: { stock: 0 },
  });

  const addMutation = useMutation({
    mutationFn: async (data: AddProductForm) => {
      const product = await fetchJson<Product>("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          barcode: data.barcode,
          sku: data.sku,
          name: data.name,
          categoryName: data.categoryName,
          currentSalePrice: data.currentSalePrice,
          stock: data.stock,
          desi: data.desi || undefined,
        }),
      });

      if (data.productCost || data.packagingCost) {
        const totalCost = (Number(data.productCost) || 0) + (Number(data.packagingCost) || 0);
        await fetch(`/api/products/${product.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cost: {
              manualCost: Number(data.productCost) || 0,
              packagingCost: Number(data.packagingCost) || 0,
              totalCost,
            },
          }),
        });
      }
      return product;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Urun eklendi");
      setAddOpen(false);
      form.reset();
    },
    onError: () => toast.error("Urun eklenemedi"),
  });

  const filteredProducts = useMemo(() => {
    // Sorguyu kelimelere böl; her kelime (sırasız) eşleşmeli. Böylece "vazo kırmızı"
    // ile "Kırmızı Vazo" da bulunur. Türkçe-duyarlı + aksansız tolere edilir.
    const tokens = normalizeSearch(debouncedFilter.trim()).split(/\s+/).filter(Boolean);
    const list = Array.isArray(products) ? products : [];

    const searched = list.filter((product) => {
      if (tokens.length === 0) return true;
      const hay = normalizeSearch(
        [
          product.name,
          product.alias,
          product.barcode,
          product.sku,
          product.categoryName,
          product.variantGroup?.name,
        ]
          .filter(Boolean)
          .join(" ")
      );
      return tokens.every((t) => hay.includes(t));
    });

    // "En Kârlı": ürünün platform listing'lerinin ortalama kâr marjına göre azalan sırala
    if (filterMode === "most-profitable") {
      const avgMargin = (p: Product) => {
        const margins = p.platforms
          .map((pl) => pl.profitMargin)
          .filter((m): m is number => m !== null && m !== undefined);
        if (margins.length === 0) return -Infinity;
        return margins.reduce((a, b) => a + b, 0) / margins.length;
      };
      return [...searched].sort((a, b) => avgMargin(b) - avgMargin(a));
    }

    return searched;
  }, [debouncedFilter, products, filterMode]);

  // Varyant grubu üyelerini tek satırda topla: grup başlığı + (açıkken) üyeler.
  type DisplayRow =
    | { kind: "group"; key: string; groupId: string; groupName: string; members: Product[] }
    | { kind: "product"; key: string; product: Product; isMember: boolean };

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (id: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Düz ürün listesini grup başlıkları + tekil ürünler haline getir (sıra korunur).
  const displayRows = useMemo<DisplayRow[]>(() => {
    const rows: DisplayRow[] = [];
    const groupIdx = new Map<string, number>();
    for (const p of filteredProducts) {
      const g = p.variantGroup;
      if (g) {
        const existing = groupIdx.get(g.id);
        if (existing !== undefined) {
          (rows[existing] as Extract<DisplayRow, { kind: "group" }>).members.push(p);
        } else {
          groupIdx.set(g.id, rows.length);
          rows.push({ kind: "group", key: `g_${g.id}`, groupId: g.id, groupName: g.name, members: [p] });
        }
      } else {
        rows.push({ kind: "product", key: p.id, product: p, isMember: false });
      }
    }
    // "En Kârlı" dışındaki tüm modlarda Türkçe alfabetik sırala (görünür etikete göre).
    // Böylece sıra İSME bağlı olur → stok/maliyet düzenleyince ürün başa fırlamaz, yerinde kalır.
    if (filterMode !== "most-profitable") {
      rows.sort((a, b) =>
        trCollator.compare(
          a.kind === "group" ? a.groupName : a.product.name,
          b.kind === "group" ? b.groupName : b.product.name
        )
      );
      for (const r of rows) {
        if (r.kind === "group") {
          r.members.sort((a, b) =>
            trCollator.compare(a.variantLabel || a.name, b.variantLabel || b.name)
          );
        }
      }
    }
    return rows;
  }, [filteredProducts, filterMode]);

  // Açık grupların üyelerini başlığın hemen altına serpiştir.
  const flatRows = useMemo<DisplayRow[]>(() => {
    const out: DisplayRow[] = [];
    for (const row of displayRows) {
      out.push(row);
      if (row.kind === "group" && expandedGroups.has(row.groupId)) {
        for (const m of row.members) {
          out.push({ kind: "product", key: `${row.groupId}_${m.id}`, product: m, isMember: true });
        }
      }
    }
    return out;
  }, [displayRows, expandedGroups]);

  // Lazy/windowed render — başta 40 satır, scroll'da artar. Filtre/arama değişince
  // ve sayfaya her girişte (component remount) sıfırlanır.
  const [visibleCount, setVisibleCount] = useState(40);
  const sentinelRef = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    setVisibleCount(40);
  }, [filterMode, globalFilter]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    // TEK gözlemci — `visibleCount` deps'te DEĞİL: yoksa her +40'ta observer yeniden kurulup
    // sentinel hâlâ margin içindeyse anında tekrar tetikleniyordu (cascade → render fırtınası).
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((c) => c + 40);
        }
      },
      { rootMargin: "300px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [flatRows.length]);

  const visibleRows = flatRows.slice(0, visibleCount);

  const FILTER_OPTIONS: { value: FilterMode; label: string }[] = [
    { value: "active", label: "Aktif" },
    { value: "most-profitable", label: "En Kârlı" },
    { value: "negative-profit", label: "Zarar Eden" },
    { value: "missing-cost", label: "Maliyet Eksik" },
    { value: "out-of-stock", label: "Stoğu Bitenler" },
    { value: "inactive", label: "İnaktif" },
    { value: "hidden", label: "Gizlenenler" },
    { value: "all", label: "Tümü" },
  ];

  // Varyant grubu başlık satırı — genel ad + N varyant + aç/gizle. Üyeler açıkken altına serpilir.
  const renderGroupRow = (row: Extract<DisplayRow, { kind: "group" }>) => {
    const expanded = expandedGroups.has(row.groupId);
    const totalStock = row.members.reduce((s, m) => s + m.stock, 0);
    const prices = row.members.map((m) => m.currentSalePrice).filter((n) => n > 0);
    const priceMin = prices.length ? Math.min(...prices) : 0;
    const priceMax = prices.length ? Math.max(...prices) : 0;
    const allSelected = row.members.length > 0 && row.members.every((m) => selectedIds.has(m.id));
    const firstImg = row.members.find((m) => m.imageUrl)?.imageUrl ?? null;
    const labels = row.members.map((m) => m.variantLabel || m.name).join(" · ");
    const priceText = prices.length
      ? priceMin === priceMax
        ? formatCurrency(priceMin)
        : `${formatCurrency(priceMin)} – ${formatCurrency(priceMax)}`
      : null;
    return (
      <TableRow
        key={row.key}
        onClick={() => toggleGroup(row.groupId)}
        title={expanded ? "Varyantları gizle" : "Varyantları aç"}
        className="bg-muted/25 hover:bg-muted/40 border-y border-border/60 cursor-pointer"
      >
        <TableCell className="py-2" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={allSelected}
            onCheckedChange={(v) =>
              setSelectedIds((prev) => {
                const next = new Set(prev);
                row.members.forEach((m) => (v ? next.add(m.id) : next.delete(m.id)));
                return next;
              })
            }
          />
        </TableCell>
        <TableCell className="py-2 pr-0">
          <span className="relative block w-fit">
            <ProductImage src={firstImg} name={row.groupName} />
            <span className="absolute -bottom-1 -right-1 rounded bg-primary text-primary-foreground p-0.5 leading-none">
              <Layers className="h-2.5 w-2.5" />
            </span>
          </span>
        </TableCell>
        <TableCell className="max-w-0">
          <div className="flex items-center gap-1.5 w-full">
            <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
            <span className="font-semibold text-sm truncate">{row.groupName}</span>
            <Badge variant="secondary" className="shrink-0 tabular-nums">{row.members.length} varyant</Badge>
          </div>
          <div className="text-[11px] text-muted-foreground/70 truncate mt-0.5 pl-6">
            {labels}
            {priceText && <span className="opacity-80"> · {priceText}</span>}
          </div>
        </TableCell>
        <TableCell className="py-2 text-center">
          <span className="text-xs tabular-nums text-muted-foreground" title="Üyelerin toplam stoğu">Σ {totalStock}</span>
        </TableCell>
        <TableCell className="text-right text-xs text-muted-foreground/40">—</TableCell>
        <TableCell className="text-center text-xs text-muted-foreground/40">—</TableCell>
        <TableCell className="text-center text-xs text-muted-foreground/40">—</TableCell>
        <TableCell className="text-center text-xs text-muted-foreground/40">—</TableCell>
        <TableCell className="w-[80px]" />
      </TableRow>
    );
  };

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Ürünler</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Shopify ana ürünleri + Trendyol eşleştirmeleri · varyantlar genel başlık altında tek satırda toplanır
          </p>
        </div>
        <div className="flex gap-2">
          {selectedIds.size > 0 && (
            <>
              {filterMode === "hidden" ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={bulkVisibilityMutation.isPending}
                  onClick={() =>
                    bulkVisibilityMutation.mutate({ ids: [...selectedIds], hidden: false })
                  }
                >
                  <Eye className="h-4 w-4 mr-2" />
                  {selectedIds.size} Ürünü Geri Getir
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={bulkVisibilityMutation.isPending}
                  onClick={() =>
                    bulkVisibilityMutation.mutate({ ids: [...selectedIds], hidden: true })
                  }
                >
                  <EyeOff className="h-4 w-4 mr-2" />
                  {selectedIds.size} Seçileni Gizle
                </Button>
              )}
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setBulkDeleteOpen(true)}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                {selectedIds.size} Seçileni Sil
              </Button>
            </>
          )}
          {refreshProgress ? (
            <div className="flex flex-col gap-1 min-w-[210px] px-1 animate-in fade-in duration-200">
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="text-muted-foreground truncate flex items-center gap-1.5">
                  <RefreshCw className="h-3 w-3 animate-spin shrink-0" />
                  {refreshProgress.label}
                </span>
                <span className="tabular-nums font-semibold shrink-0">
                  {refreshProgress.done}/{refreshProgress.total} · %
                  {Math.round((refreshProgress.done / refreshProgress.total) * 100)}
                </span>
              </div>
              <Progress
                value={(refreshProgress.done / refreshProgress.total) * 100}
                className="h-1.5"
              />
            </div>
          ) : (
            <Button
              onClick={runRefreshAll}
              size="sm"
              variant="outline"
              title="Fiyatları çek + liste/panel/siparişleri tazele (başka cihazdaki değişiklikler dahil)"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Yenile
            </Button>
          )}
          <Button onClick={() => setMarketplaceOpen(true)} size="sm" variant="outline" title="Shopify'da olmayan, sadece Trendyol/HB'de bulunan ürünü barkoduyla ekle">
            <Package className="h-4 w-4 mr-2" /> Pazaryeri Ürünü Ekle
          </Button>
          <Button onClick={() => setAddOpen(true)} size="sm">
            <Plus className="h-4 w-4 mr-2" /> Ürün Ekle
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Ara: ad, barkod, SKU, kategori..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="flex items-center rounded-md border bg-muted/30 p-0.5 gap-0.5">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setFilterMode(opt.value)}
              className={`px-3 py-1.5 text-sm font-medium rounded-sm transition-colors ${
                filterMode === opt.value
                  ? "bg-background shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <span className="text-sm text-muted-foreground ml-auto">
          {displayRows.length} kayıt
          {filteredProducts.length !== displayRows.length ? ` · ${filteredProducts.length} ürün` : ""}
        </span>
      </div>

      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[36px]">
                <Checkbox
                  checked={
                    filteredProducts.length > 0 &&
                    filteredProducts.every((p) => selectedIds.has(p.id))
                  }
                  onCheckedChange={(v) => {
                    if (v) {
                      setSelectedIds(new Set(filteredProducts.map((p) => p.id)));
                    } else {
                      setSelectedIds(new Set());
                    }
                  }}
                />
              </TableHead>
              <TableHead className="w-[52px]" />
              <TableHead>Ürün</TableHead>
              <TableHead className="text-center w-[110px]">Stok</TableHead>
              <TableHead className="text-right tabular-nums w-[90px]">Maliyet</TableHead>
              <TableHead className="text-center w-[140px]" style={{ color: PLATFORM_COLOR.shopify }}>
                Shopify
              </TableHead>
              <TableHead className="text-center w-[140px]" style={{ color: PLATFORM_COLOR.trendyol }}>
                Trendyol
              </TableHead>
              <TableHead className="text-center w-[140px]" style={{ color: PLATFORM_COLOR.hepsiburada }}>
                Hepsiburada
              </TableHead>
              <TableHead className="w-[80px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                  <TableRow key={`skeleton-${i}`}>
                    <TableCell><Skeleton className="h-4 w-4 rounded" /></TableCell>
                    <TableCell><Skeleton className="h-10 w-10 rounded-md" /></TableCell>
                    <TableCell>
                      <Skeleton className="h-3 w-3/4 mb-1.5" />
                      <Skeleton className="h-2 w-1/2" />
                    </TableCell>
                    <TableCell><Skeleton className="h-3 w-16 mx-auto" /></TableCell>
                    <TableCell><Skeleton className="h-3 w-16 ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-3 w-20 mx-auto" /></TableCell>
                    <TableCell><Skeleton className="h-3 w-20 mx-auto" /></TableCell>
                    <TableCell><Skeleton className="h-3 w-20 mx-auto" /></TableCell>
                    <TableCell><Skeleton className="h-7 w-7 rounded" /></TableCell>
                  </TableRow>
                ))}
              </>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-8 text-destructive">
                  Ürünler yüklenemedi.
                </TableCell>
              </TableRow>
            ) : filteredProducts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                  {filterMode === "inactive"
                    ? "İnaktif ürün bulunmuyor."
                    : filterMode === "out-of-stock"
                      ? "Stoğu biten aktif ürün bulunmuyor."
                      : "Ürün bulunamadı. CSV ile içe aktar veya manuel ekle."}
                </TableCell>
              </TableRow>
            ) : (
              <>
              {visibleRows.map((row) => {
                if (row.kind === "group") return renderGroupRow(row);
                const product = row.product;
                return (
                  <ProductRow
                    key={row.key}
                    product={product}
                    isMember={row.isMember}
                    isSelected={selectedIds.has(product.id)}
                    isEditingAlias={aliasEdit?.id === product.id}
                    aliasValue={aliasEdit?.id === product.id ? aliasEdit.value : ""}
                    integrations={integrations}
                    onToggleSelect={handleToggleSelect}
                    onAdjustStock={adjustStock}
                    onAliasStart={handleAliasStart}
                    onAliasChange={handleAliasChange}
                    onAliasCommit={commitAlias}
                    onAliasCancel={handleAliasCancel}
                    onMatch={handleMatch}
                    onToggleHidden={handleToggleHidden}
                    onDelete={handleDelete}
                    onToggleMadeToOrder={handleToggleMadeToOrder}
                    onPrint={handlePrint}
                  />
                );
              })}
              {visibleCount < flatRows.length && (
                <TableRow ref={sentinelRef}>
                  <TableCell colSpan={9} className="text-center py-4">
                    <Loader2 className="h-4 w-4 mx-auto animate-spin text-muted-foreground/50" />
                  </TableCell>
                </TableRow>
              )}
              </>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Yeni Urun Ekle</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={form.handleSubmit((d) => addMutation.mutate(d))}
            className="space-y-3"
          >
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Barkod *</Label>
                <Input {...form.register("barcode")} />
                {form.formState.errors.barcode && (
                  <p className="text-xs text-destructive">{form.formState.errors.barcode.message}</p>
                )}
              </div>
              <div>
                <Label>SKU *</Label>
                <Input {...form.register("sku")} />
              </div>
            </div>
            <div>
              <Label>Urun Adi *</Label>
              <Input {...form.register("name")} />
              {form.formState.errors.name && (
                <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
              )}
            </div>
            <div>
              <Label>Kategori *</Label>
              <Input {...form.register("categoryName")} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Satis Fiyati (TL) *</Label>
                <Input type="number" step="0.01" {...form.register("currentSalePrice")} />
              </div>
              <div>
                <Label>Stok</Label>
                <Input type="number" {...form.register("stock")} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Desi</Label>
                <Input type="number" step="0.1" {...form.register("desi")} />
              </div>
              <div>
                <Label>Urun Maliyeti (TL)</Label>
                <Input type="number" step="0.01" {...form.register("productCost")} />
              </div>
            </div>
            <div>
              <Label>Ambalaj Maliyeti (TL)</Label>
              <Input type="number" step="0.01" {...form.register("packagingCost")} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
                Iptal
              </Button>
              <Button type="submit" disabled={addMutation.isPending}>
                {addMutation.isPending ? "Ekleniyor..." : "Ekle"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Toplu silme onayı */}
      <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Toplu Silme Onayı</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            <strong>{selectedIds.size}</strong> ürün silinecek. Bu işlem geri alınamaz.
            Maliyet bilgileri, listings ve fiyat geçmişi de silinir.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDeleteOpen(false)}>
              İptal
            </Button>
            <Button
              variant="destructive"
              onClick={() => bulkDeleteMutation.mutate([...selectedIds])}
              disabled={bulkDeleteMutation.isPending}
            >
              {bulkDeleteMutation.isPending
                ? "Siliniyor..."
                : `${selectedIds.size} Ürünü Sil`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Tekli silme onayı — yanlışlıkla tıklamaya karşı */}
      <Dialog open={!!deleteConfirm} onOpenChange={(o) => !o && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ürünü Sil</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            <strong className="text-foreground">{deleteConfirm?.name}</strong> silinecek. Bu işlem geri
            alınamaz — maliyet bilgileri, listings ve fiyat geçmişi de silinir.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              İptal
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteConfirm) deleteMutation.mutate(deleteConfirm.id);
                setDeleteConfirm(null);
              }}
            >
              Sil
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manuel match modal */}
      {matchModal && (
        <MatchListingModal
          productId={matchModal.productId}
          productName={matchModal.productName}
          platform={matchModal.platform}
          onClose={() => setMatchModal(null)}
        />
      )}

      {/* Pazaryeri (Shopify'da olmayan) ürünü doğrudan ekleme modalı */}
      {marketplaceOpen && (
        <MarketplaceAddModal integrations={integrations} onClose={() => setMarketplaceOpen(false)} />
      )}

      {/* Hızlı baskı — yazıcı/parça seç → yükle & başlat */}
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

function MatchListingModal({
  productId,
  productName,
  platform,
  onClose,
}: {
  productId: string;
  productName: string;
  platform: "trendyol" | "hepsiburada";
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Arama debounce: her tuşta fetch + yeni cache anahtarı oluşturma (250ms sonra bir kez).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data: unmatched = [], isLoading } = useQuery<
    Array<{
      id: string;
      barcode: string;
      externalSku: string | null;
      name: string;
      price: number;
      stock: number;
      imageUrl: string | null;
    }>
  >({
    queryKey: ["unmatched-listings", platform, debouncedSearch],
    queryFn: () =>
      fetchJson(
        `/api/unmatched-listings?platform=${platform}${debouncedSearch ? `&search=${encodeURIComponent(debouncedSearch)}` : ""}`
      ),
  });

  const match = useMutation({
    // Tüm yan-etkiler mutationFn İÇİNDE: onMutate modalı anında kapatıp komponenti
    // unmount edince onSuccess/onError tetiklenmeyebilir; mutationFn ise her hâlde tamamlanır.
    mutationFn: async (unmatchedListingId: string) => {
      try {
        const res = await fetchJson("/api/listings/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ unmatchedListingId, productId }),
        });
        qc.invalidateQueries({ queryKey: ["products"] });
        qc.invalidateQueries({ queryKey: ["unmatched-listings"] });
        qc.invalidateQueries({ queryKey: ["dashboard"] });
        toast.success("Ürün eşleştirildi");
        return res;
      } catch (e) {
        toast.error(`Eşleştirilemedi: ${e instanceof Error ? e.message : "tekrar dene"}`);
        throw e;
      }
    },
    onMutate: () => onClose(), // modalı ANINDA kapat — kullanıcı server'ı beklemez
  });

  const refreshPool = useMutation({
    mutationFn: () =>
      fetchJson(`/api/${platform}/sync-products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "add-new" }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["unmatched-listings"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      toast.success("Trendyol listesi tazelendi");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const platformLabel = platform === "hepsiburada" ? "Hepsiburada" : "Trendyol";

  // Windowed render: 300+ listing'i tek seferde DOM'a basmak modalı kasıyordu → başta 60, scroll'da artar.
  const [visibleCount, setVisibleCount] = useState(60);
  useEffect(() => { setVisibleCount(60); }, [debouncedSearch]);
  const visible = unmatched.slice(0, visibleCount);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{platformLabel} Ürünü Eşleştir</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            <strong className="text-foreground line-clamp-1">{productName}</strong>{" "}
            ürününe bağlanacak {platformLabel} listing'ini seç.
          </p>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Barkod, SKU veya ürün adı..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={refreshPool.isPending}
            onClick={() => refreshPool.mutate()}
            title="Trendyol'dan güncel ürün listesini çek"
          >
            <RefreshCw className={`h-4 w-4 mr-1.5 ${refreshPool.isPending ? "animate-spin" : ""}`} />
            {refreshPool.isPending ? "Tazeleniyor…" : "Tazele"}
          </Button>
        </div>

        <div
          className="flex-1 overflow-y-auto -mx-2 px-2"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 240 && visibleCount < unmatched.length) {
              setVisibleCount((c) => c + 60);
            }
          }}
        >
          {isLoading ? (
            <div className="py-8 flex items-center justify-center text-muted-foreground">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Yükleniyor...
            </div>
          ) : unmatched.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {search
                ? `"${search}" için sonuç yok`
                : `Eşleşmemiş ${platformLabel} listing'i bulunmuyor. Önce ${platformLabel} ürünlerini senkronize et.`}
            </div>
          ) : (
            <div className="space-y-1">
              {visible.map((u) => (
                <button
                  key={u.id}
                  onClick={() => match.mutate(u.id)}
                  disabled={match.isPending}
                  className="w-full text-left p-3 rounded-md hover:bg-muted/60 transition-colors flex items-center gap-3 border border-transparent hover:border-primary/30 disabled:opacity-50"
                >
                  {u.imageUrl ? (
                    <div className="w-10 h-10 rounded border bg-muted shrink-0 overflow-hidden">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={u.imageUrl}
                        alt={u.name}
                        className="w-full h-full object-contain"
                      />
                    </div>
                  ) : (
                    <div className="w-10 h-10 rounded bg-muted shrink-0 flex items-center justify-center">
                      <Package className="h-5 w-5 text-muted-foreground/60" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium line-clamp-1">{u.name}</p>
                    <p className="text-[10px] text-muted-foreground font-mono">
                      {u.barcode} · {u.externalSku ?? "no-sku"}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-semibold tabular-nums">
                      {formatCurrency(u.price)}
                    </p>
                    <p className="text-[10px] text-muted-foreground tabular-nums">
                      Stok: {u.stock}
                    </p>
                  </div>
                </button>
              ))}
              {visibleCount < unmatched.length && (
                <p className="text-center text-[11px] text-muted-foreground py-2">
                  {visible.length} / {unmatched.length} gösteriliyor — kaydır veya ara
                </p>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Pazaryeri ürünü ekleme modalı: Shopify'da OLMAYAN, sadece Trendyol/HB'de bulunan ürünleri
 * (UnmatchedListing havuzu) doğrudan yeni Product olarak ekler. Verisi pazaryerinden gelir.
 * Eklenince listeden düşer + ürünler listesine girer (stok takibi yapılabilir). Modal açık kalır.
 */
function MarketplaceAddModal({
  integrations,
  onClose,
}: {
  integrations: { shopify: boolean; trendyol: boolean; hepsiburada: boolean } | undefined;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const configured = (["trendyol", "hepsiburada"] as const).filter((p) => integrations?.[p]);
  const [platform, setPlatform] = useState<"trendyol" | "hepsiburada">(configured[0] ?? "trendyol");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Arama debounce: her tuşta fetch + yeni cache anahtarı oluşturma (250ms sonra bir kez).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data: unmatched = [], isLoading } = useQuery<
    Array<{
      id: string;
      barcode: string;
      externalSku: string | null;
      name: string;
      price: number;
      stock: number;
      imageUrl: string | null;
    }>
  >({
    queryKey: ["unmatched-listings", platform, debouncedSearch],
    queryFn: () =>
      fetchJson(
        `/api/unmatched-listings?platform=${platform}${debouncedSearch ? `&search=${encodeURIComponent(debouncedSearch)}` : ""}`
      ),
  });

  const promote = useMutation({
    mutationFn: async (listingId: string) => {
      const res = await fetch(`/api/unmatched-listings/${listingId}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error || "Eklenemedi");
      }
      return res.json();
    },
    onSuccess: () => {
      // Modal AÇIK kalır (peş peşe ekleme): eklenen listeden düşer, ürün listesine girer.
      qc.invalidateQueries({ queryKey: ["unmatched-listings"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Ürün eklendi");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const refreshPool = useMutation({
    mutationFn: () =>
      fetchJson(`/api/${platform}/sync-products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "add-new" }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["unmatched-listings"] });
      toast.success("Pazaryeri listesi tazelendi");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const platformLabel = platform === "hepsiburada" ? "Hepsiburada" : "Trendyol";

  // Windowed render: 300+ satırı tek seferde basmak modalı kasıyordu → başta 60, scroll'da artar.
  const [visibleCount, setVisibleCount] = useState(60);
  useEffect(() => { setVisibleCount(60); }, [debouncedSearch, platform]);
  const visible = unmatched.slice(0, visibleCount);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Pazaryeri Ürünü Ekle</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Shopify&apos;da olmayan, sadece {platformLabel}&apos;de bulunan ürünü yeni ürün olarak
            ekle — adı, resmi, fiyatı, stoğu pazaryerinden gelir.
          </p>
        </DialogHeader>

        {configured.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            Önce Trendyol veya Hepsiburada entegrasyonunu yapılandır.
          </div>
        ) : (
          <>
            {configured.length > 1 && (
              <div className="flex items-center gap-1 rounded-lg bg-muted p-1 w-fit">
                {configured.map((p) => (
                  <button
                    key={p}
                    onClick={() => setPlatform(p)}
                    className={cn(
                      "px-3 py-1 rounded-md text-xs font-medium transition-colors",
                      platform === p ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {p === "hepsiburada" ? "Hepsiburada" : "Trendyol"}
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Barkod, SKU veya ürün adı..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={refreshPool.isPending}
                onClick={() => refreshPool.mutate()}
                title={`${platformLabel}'dan güncel ürün listesini çek`}
              >
                <RefreshCw className={`h-4 w-4 mr-1.5 ${refreshPool.isPending ? "animate-spin" : ""}`} />
                {refreshPool.isPending ? "Tazeleniyor…" : "Tazele"}
              </Button>
            </div>

            <div
              className="flex-1 overflow-y-auto -mx-2 px-2"
              onScroll={(e) => {
                const el = e.currentTarget;
                if (el.scrollHeight - el.scrollTop - el.clientHeight < 240 && visibleCount < unmatched.length) {
                  setVisibleCount((c) => c + 60);
                }
              }}
            >
              {isLoading ? (
                <div className="py-8 flex items-center justify-center text-muted-foreground">
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Yükleniyor...
                </div>
              ) : unmatched.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  {search
                    ? `"${search}" için sonuç yok`
                    : `Eklenebilecek ${platformLabel} ürünü yok. "Tazele" ile listeyi güncelle.`}
                </div>
              ) : (
                <div className="space-y-1">
                  {visible.map((u) => {
                    const adding = promote.isPending && promote.variables === u.id;
                    return (
                      <div
                        key={u.id}
                        className="w-full p-3 rounded-md flex items-center gap-3 border border-transparent hover:bg-muted/40"
                      >
                        {u.imageUrl ? (
                          <div className="w-10 h-10 rounded border bg-muted shrink-0 overflow-hidden">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={u.imageUrl} alt={u.name} className="w-full h-full object-contain" />
                          </div>
                        ) : (
                          <div className="w-10 h-10 rounded bg-muted shrink-0 flex items-center justify-center">
                            <Package className="h-5 w-5 text-muted-foreground/60" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium line-clamp-1">{u.name}</p>
                          <p className="text-[10px] text-muted-foreground font-mono">
                            {u.barcode} · {u.externalSku ?? "no-sku"}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-xs font-semibold tabular-nums">{formatCurrency(u.price)}</p>
                          <p className="text-[10px] text-muted-foreground tabular-nums">Stok: {u.stock}</p>
                        </div>
                        <Button
                          size="sm"
                          className="shrink-0 h-8"
                          disabled={promote.isPending}
                          onClick={() => promote.mutate(u.id)}
                        >
                          {adding ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <>
                              <Plus className="h-3.5 w-3.5 mr-1" /> Ekle
                            </>
                          )}
                        </Button>
                      </div>
                    );
                  })}
                  {visibleCount < unmatched.length && (
                    <p className="text-center text-[11px] text-muted-foreground py-2">
                      {visible.length} / {unmatched.length} gösteriliyor — kaydır veya ara
                    </p>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
