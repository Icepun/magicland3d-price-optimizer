"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
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
import { Plus, Minus, Search, Trash2, Package, Link2, Loader2, AlertTriangle, EyeOff, Eye, RefreshCw, ChevronRight, Layers, Tag, Hammer, Printer, ArrowUp, ArrowDown, ChevronsUpDown, TrendingUp, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { StockInput } from "@/components/products/StockInput";
import { loadListState, LIST_STATE_EVENT, type ListState, saveListState, scrollContainer } from "@/lib/list-state";
import { useStockWriter } from "@/lib/use-stock-writer";
import { thumbUrl } from "@/lib/image";
import { ProductPrintModal } from "@/components/products/ProductPrintModal";
import { MatchListingModal } from "@/components/products/MatchListingModal";
import { fetchJson } from "@/lib/fetch-json";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { undoToast } from "@/components/ui/undo-toast";
import Link from "next/link";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  PLATFORM_KEYS,
  isStaleProductListKey,
  productListKey,
  selectionPreview,
  summarizeGroup,
  visibleSelection,
  type ValueRange,
} from "./product-list-logic";

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

/**
 * Grup satırının aralık metni: tüm varyantlarda aynıysa tek rakam, değilse "en düşük – en yüksek".
 * Aralıkta kuruş gösterilmez (sütun dar); tam rakam satırın kendisinde ve ipucunda durur.
 * Bilinmeyen değer "—" kalır, 0 yazılmaz.
 */
function rangeText(range: ValueRange | null): string {
  if (!range) return "—";
  if (range.min === range.max) return formatCurrency(range.min);
  return `${formatCurrency(range.min, { decimals: 0 })} – ${formatCurrency(range.max, { decimals: 0 })}`;
}

/** Aralık ipucu: tam rakamlar + kaç varyantta değer yok. */
function rangeHint(range: ValueRange | null, baslik: string): string | undefined {
  if (!range) return undefined;
  const tutar =
    range.min === range.max
      ? formatCurrency(range.min)
      : `${formatCurrency(range.min)} – ${formatCurrency(range.max)}`;
  const taban = `${baslik}: ${tutar} · ${range.bilinen} varyant`;
  return range.bilinmeyen > 0 ? `${taban} · ${range.bilinmeyen} varyantta yok` : taban;
}

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
  /** Net kâr ÷ baskı süresi (süre girilmemişse null). */
  profitPerHour: number | null;
  /** Net kâr ÷ filament gramajı (gramaj girilmemişse null). */
  profitPerGram: number | null;
  /** Fiyat bir kural bandının hemen altındaysa: küçük zamla gelen kâr artışı. */
  priceThreshold: {
    platform: string;
    currentPrice: number;
    targetPrice: number;
    currentProfit: number;
    targetProfit: number;
    gain: number;
  } | null;
  hasCost: boolean;
  missingDesi: boolean;
  platforms: Array<{
    platform: "shopify" | "trendyol" | "hepsiburada";
    listingId: string;
    salePrice: number;
    stock: number;
    netProfit: number | null;
    profitMargin: number | null;
    commissionMissing: boolean;
    cargoMissing?: boolean;
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

type FilterMode = "active" | "out-of-stock" | "inactive" | "all" | "negative-profit" | "missing-cost" | "missing-desi" | "hidden" | "most-profitable" | "near-threshold";

/** Sunucuda karşılığı olmayan, istemcide sıralanan/süzülen görünümler → "active" listesini çeker. */
const CLIENT_ONLY_FILTERS: FilterMode[] = ["most-profitable", "near-threshold"];

/** Kolon başlığından sıralama: kâr/saat ve kâr/gram. null → varsayılan (alfabetik) sıra. */
type SortKey = "profitPerHour" | "profitPerGram";


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
      {/* Pazaryeri CDN alan adları kullanıcıya göre değişir; URL zaten küçük thumbnail'e çevriliyor. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={thumbUrl(src, 100) ?? src}
        alt={name}
        width={40}
        height={40}
        className="max-w-full max-h-full object-contain"
        onError={() => setErrored(true)}
        loading="lazy"
        decoding="async"
      />
    </div>
  );
}

/** Tıklanabilir kolon başlığı — aktif yön oku ile. */
function SortableHead({
  label,
  hint,
  active,
  onClick,
}: {
  label: string;
  hint: string;
  active: "asc" | "desc" | null;
  onClick: () => void;
}) {
  const Icon = active === "desc" ? ArrowDown : active === "asc" ? ArrowUp : ChevronsUpDown;
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={cn(
        "group/sort w-full h-full px-2 py-1 flex items-center justify-end gap-1 rounded-sm transition-colors active:scale-[0.97]",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
      <Icon
        className={cn(
          "h-3 w-3 transition-opacity",
          active ? "opacity-100" : "opacity-30 group-hover/sort:opacity-70"
        )}
      />
    </button>
  );
}

type PlatformParam = "shopify" | "trendyol" | "hepsiburada";

/** Panel'deki platform kartından gelen ?platform=... (SSR safe). Tanınmayan değer yok sayılır. */
function readPlatformFromUrl(): PlatformParam | null {
  if (typeof window === "undefined") return null;
  const p = new URLSearchParams(window.location.search).get("platform");
  return p === "shopify" || p === "trendyol" || p === "hepsiburada" ? p : null;
}

const PLATFORM_PARAM_LABEL: Record<PlatformParam, string> = {
  shopify: "Shopify",
  trendyol: "Trendyol",
  hepsiburada: "Hepsiburada",
};

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
    f === "missing-desi" ||
    f === "hidden" ||
    f === "most-profitable" ||
    f === "near-threshold"
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
  onSetStock,
  onAliasStart,
  onAliasChange,
  onAliasCommit,
  onAliasCancel,
  onMatch,
  onToggleHidden,
  onDelete,
  onToggleMadeToOrder,
  onPrint,
  measureRef,
  dataIndex,
}: {
  product: Product;
  isMember: boolean;
  isSelected: boolean;
  isEditingAlias: boolean;
  aliasValue: string;
  integrations: { shopify: boolean; trendyol: boolean; hepsiburada: boolean } | undefined;
  /** Virtualizer: satırın gerçek yüksekliğini ölçmek için (dinamik) + flatRows indexi. */
  measureRef?: (node: HTMLTableRowElement | null) => void;
  dataIndex?: number;
  onToggleSelect: (id: string, checked: boolean) => void;
  /** `current` + `name`: yanlış tıklamayı geri alabilmek için eski değer ve okunur ad gerekir. */
  onAdjustStock: (id: string, delta: number, current: number, name: string) => void;
  onSetStock: (id: string, stock: number, current: number, name: string) => void;
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
  // ⚠️ Maliyet BİLİNİRLİĞİ tutara bakılarak anlaşılmaz: paketleme her ürüne otomatik eklendiği
  // için toplam asla 0 olmuyor. Sunucu bu kararı zaten `hasCost` ile gönderiyor
  // (çekirdekteki `productionCostKnown`). Bunu yok saydığımız için aynı satır "Maliyet ₺12,40"
  // derken yanındaki Kâr/saat "—" ve platform hücresi "maliyet eksik" diyordu; ürün detayı ise
  // "Üretim Maliyeti —" gösteriyordu. Tek kaynak: hasCost.
  const cost = product.hasCost
    ? (product.resolvedTotalCost ?? product.cost?.totalCost ?? product.cost?.manualCost)
    : null;
  const findPlatform = (p: "shopify" | "trendyol" | "hepsiburada") =>
    product.platforms.find((x) => x.platform === p);

  return (
    <TableRow
      ref={measureRef}
      data-index={dataIndex}
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
      {/* max-w-0: uzun ürün adı sütunu şişirmesin, üç nokta ile kırpılsın.
          min-w: taban genişlik olmadan diğer sütunlar bu sütunu tek harfe eziyordu. */}
      <TableCell className="max-w-0 min-w-[260px]">
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
        {product.missingDesi && (
          <span className="inline-flex mt-1 text-[10px] font-medium text-amber-500">
            Desi eksik · kargo 1 desi
          </span>
        )}
        {product.priceThreshold && (
          <span
            className="inline-flex items-center gap-1 mt-1 rounded-full border border-green-500/40 bg-green-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-green-600 dark:text-green-500 transition-colors hover:bg-green-500/20"
            title={`Fiyatı ${formatCurrency(product.priceThreshold.targetPrice)} yaparsan kâr ${formatCurrency(product.priceThreshold.targetProfit)} olur`}
          >
            <TrendingUp className="h-3 w-3" />
            {formatCurrency(product.priceThreshold.targetPrice)} yap · kâr +
            {formatCurrency(product.priceThreshold.gain)}
          </span>
        )}
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
              onClick={() => onAdjustStock(product.id, -1, product.stock, product.name)}
            >
              <Minus className="h-4 w-4" />
            </Button>
            {/* Elle giriş: büyük stok değişikliklerinde (+/- ile tek tek imkânsızdı) tıkla-yaz */}
            <StockInput
              value={product.stock}
              onCommit={(next) => onSetStock(product.id, next, product.stock, product.name)}
              className="text-sm w-[5ch] py-0.5"
              title={product.stock === 0 ? "Stok tükendi" : product.stock === 1 ? "Kritik stok" : undefined}
            />
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              onClick={() => onAdjustStock(product.id, 1, product.stock, product.name)}
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
      {/* Baskı süresi ve gramaj başına kazanç — "şimdi hangisini basayım?" kolonları. */}
      <TableCell className="text-right tabular-nums text-xs">
        {product.profitPerHour != null ? (
          <span className={cn("font-medium", product.profitPerHour < 0 && "text-destructive")}>
            {formatCurrency(product.profitPerHour)}
          </span>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs">
        {product.profitPerGram != null ? (
          <span className={cn("font-medium", product.profitPerGram < 0 && "text-destructive")}>
            {formatCurrency(product.profitPerGram)}
          </span>
        ) : (
          <span className="text-muted-foreground/40">—</span>
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
            {/* Kargo bareni eşleşmediyse kâr olduğundan yüksek görünür — sessiz kalmasın. */}
            {p.cargoMissing && (
              <div className="text-[10px] text-amber-500 font-semibold mt-0.5 flex items-center justify-center gap-1">
                <AlertTriangle className="h-3 w-3" /> Kargo tanımlı değil
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
  // Panel'in platform kartından gelen daraltma (?platform=trendyol gibi).
  const [platformParam, setPlatformParam] = useState<PlatformParam | null>(null);
  /**
   * URL parametreleri mount efektinde okunuyor (hydration güvenliği). Sorgu o efektten ÖNCE
   * açılırsa `?platform=` ile gelindiğinde önce daraltmasız TÜM katalog çekilir (300+ ürünün
   * kâr simülasyonu) ve yanıt çöpe gider. Bu bayrak, ilk isteği doğru adresle attırır.
   */
  const [urlOkundu, setUrlOkundu] = useState(false);
  // Kâr/saat · kâr/gram sıralaması — başlığa tıklayınca önce büyükten küçüğe, sonra tersi, sonra kapalı.
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null);
  const toggleSort = useCallback((key: SortKey) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "desc" };
      if (prev.dir === "desc") return { key, dir: "asc" };
      return null;
    });
  }, []);
  const [addOpen, setAddOpen] = useState(false);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /**
   * Filtre veya platform daraltması değişince seçim SIFIRLANIR — veri kümesi tamamen değişir.
   *
   * ARAMA metni bilerek DIŞARIDA: kullanıcı "kutu" arayıp 12 ürün işaretledikten sonra kontrol
   * için arama kutusunu temizleyince seçimi kaybediyordu ve düğmeler sessizce yok oluyordu.
   * Asıl koruma zaten `visibleSelection`: toplu işlem YALNIZ o an görünen satırlara uygulanır,
   * yani ekranda görünmeyen ürün hiçbir şekilde silinemez.
   */
  useEffect(() => {
    setSelectedIds((prev) => (prev.size === 0 ? prev : new Set()));
  }, [filterMode, platformParam]);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  // Toplu düzenleme — her alan kendi anahtarıyla açılır, kapalı alan OLDUĞU GİBİ kalır.
  // ⚠️ Maliyet alanı bilerek yok: maliyet-kâr rakamını değiştiren düzenlemeler ayrı onay ister.
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkEdit, setBulkEdit] = useState({
    desiOn: false,
    desi: "",
    categoryOn: false,
    category: "",
    madeToOrderOn: false,
    madeToOrder: false,
  });
  const [bulkEditProgress, setBulkEditProgress] = useState<{ done: number; total: number } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null);
  const [printTarget, setPrintTarget] = useState<{ id: string; name: string } | null>(null);
  const [matchModal, setMatchModal] = useState<{
    productId: string;
    productName: string;
    platform: "trendyol" | "hepsiburada";
  } | null>(null);
  const queryClient = useQueryClient();

  /**
   * Gizle / geri getir sonrası DİĞER sekmelerin listesini önbellekten sil.
   *
   * Ekrandaki liste iyimser güncellenir; geri kalan sekmelerin gövdesi artık yanlıştır. Bu liste
   * kendiliğinden tazelenmediği için (staleTime: Infinity + refetchOnMount: false) onları yalnız
   * "bayat" işaretlemek işe yaramıyordu: gizlenen ürün Gizlenenler'e HİÇ girmiyor, geri getirilen
   * ürün Aktif'e dönmüyordu. Silince o sekmeye geçildiğinde taze çekim garanti olur — ekrandaki
   * listeye dokunulmadığı için gereksiz ağır çekim de olmaz.
   */
  const dropOtherProductLists = useCallback(() => {
    queryClient.removeQueries({
      queryKey: ["products"],
      predicate: (query) => isStaleProductListKey(query.queryKey, filterMode, platformParam),
    });
  }, [queryClient, filterMode, platformParam]);

  /** "Geri al" — satırları ekrandaki listeye geri koyar (372 ürünü baştan çekmeden). */
  const restoreProductRows = useCallback(
    (rows: Product[]) => {
      if (rows.length === 0) return;
      queryClient.setQueryData<Product[]>(productListKey(filterMode, platformParam), (old) => {
        if (!Array.isArray(old)) return old;
        const mevcut = new Set(old.map((p) => p.id));
        const eksik = rows.filter((row) => !mevcut.has(row.id));
        // Sıra istemcide (alfabetik / kolon sıralaması) kurulduğu için sona eklemek yeterli.
        return eksik.length ? [...old, ...eksik] : old;
      });
    },
    [queryClient, filterMode, platformParam]
  );

  // URL filter parametresinden başlangıç değeri (mount sonrası, hydration safe).
  // URL'de filtre YOKSA oturumdaki son durumu (arama + filtre) geri yükle → ürün detayına girip
  // dönünce "kaldığın yerden devam" (eskiden arama sıfırlanıyordu).
  useEffect(() => {
    const url = new URL(window.location.href);
    const hasUrlFilter = url.searchParams.has("filter");
    const f = readFilterFromUrl();
    const platform = readPlatformFromUrl();
    const saved = loadListState("products");
    if (platform) setPlatformParam(platform);
    if (hasUrlFilter) {
      if (f !== filterMode) setFilterMode(f);
    } else if (platform) {
      // Adres bir platform istiyorsa oturumdaki son filtreyi GERİ YÜKLEME: Trendyol kartına
      // basınca "Gizlenenler" listesi açılıyordu.
      if (filterMode !== "active") setFilterMode("active");
    } else if (saved.filterMode && saved.filterMode !== filterMode) {
      setFilterMode(saved.filterMode as FilterMode);
    }
    if (saved.search) {
      setGlobalFilter(saved.search);
      setDebouncedFilter(saved.search); // filtre ANINDA uygulansın (200ms debounce'u bekleme)
    }
    // Kaydırma konumu — liste boyandıktan sonra geri al.
    if (saved.scrollTop) {
      requestAnimationFrame(() => {
        const el = scrollContainer();
        if (el) el.scrollTop = saved.scrollTop!;
      });
    }
    setUrlOkundu(true); // artık ilk istek doğru adresle atılabilir
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sayfa AÇIKKEN gelen istek (Ctrl+K → "Tümünü Ürünler'de gör"): mount efekti bir daha
  // çalışmadığı için aramayı burada uygularız.
  useEffect(() => {
    const uygula = (event: Event) => {
      const detay = (event as CustomEvent<{ name: string; patch: ListState }>).detail;
      if (!detay || detay.name !== "products") return;
      if (detay.patch.filterMode) setFilterMode(detay.patch.filterMode as FilterMode);
      if (typeof detay.patch.search === "string") {
        setGlobalFilter(detay.patch.search);
        setDebouncedFilter(detay.patch.search);
      }
      if (detay.patch.scrollTop != null) {
        requestAnimationFrame(() => {
          const el = scrollContainer();
          if (el) el.scrollTop = detay.patch.scrollTop!;
        });
      }
    };
    window.addEventListener(LIST_STATE_EVENT, uygula);
    return () => window.removeEventListener(LIST_STATE_EVENT, uygula);
  }, []);

  // Durumu oturuma yaz (arama/filtre anında; kaydırma sayfadan ayrılırken).
  useEffect(() => {
    saveListState("products", { search: globalFilter, filterMode });
  }, [globalFilter, filterMode]);
  useEffect(() => {
    return () => {
      const el = scrollContainer();
      if (el) saveListState("products", { scrollTop: el.scrollTop });
    };
  }, []);

  const {
    data: products = [],
    isLoading,
    isError,
  } = useQuery<Product[]>({
    enabled: urlOkundu,
    queryKey: ["products", filterMode, platformParam],
    queryFn: ({ signal }) =>
      // "En Kârlı" / "Eşiğe Yakın" sunucuda yok → aktif ürünleri çek, client'ta süz/sırala.
      // signal: başka sayfaya geçince bu (ağır) fetch iptal olur → birikme/boşa parse yok.
      fetchJson<Product[]>(
        `/api/products?filter=${CLIENT_ONLY_FILTERS.includes(filterMode) ? "active" : filterMode}` +
          (platformParam ? `&platform=${platformParam}` : ""),
        { signal }
      ),
    // CACHE-FIRST: liste cache'te yaşar, KENDİLİĞİNDEN tazelenmez (staleTime: Infinity).
    // Yalnızca bir değişiklik onu invalidate edince refetch olur:
    //   • stok/maliyet/gizle/alias/madeToOrder düzeni → optimistic (zaten cache'te güncel)
    //   • Maliyet&Paketleme / Kargo / Ek Giderler / KDV değişimi → invalidate ["products"]
    //   • "Fiyatları Güncelle" butonu / ürün ekle-sil → invalidate ["products"]
    // refetchOnMount:false → sayfaya her DÖNÜŞTE otomatik refetch YOK. Bir düzenleme listeyi yalnızca
    // BAYAT işaretler; gerçek tazeleme SADECE "Yenile"/sync ile olur (o an mounted query'yi invalidate
    // edince aktif refetch tetiklenir). Böylece her geri dönüşte 368 ürün + ~736 kâr simülasyonu baştan
    // çekilip uygulama donmuyor. (Kullanıcı isteği: "ben Yenile demedikçe sürekli veri çekme.")
    staleTime: Infinity,
    refetchOnMount: false,
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
      fetchJson(`/api/products/${id}`, { method: "DELETE" }),
    // Optimistic: ürünü listeden ANINDA çıkar (fetch YOK); hata olursa geri al.
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ["products"] });
      const prev = queryClient.getQueriesData({ queryKey: ["products"] });
      queryClient.setQueriesData<Product[] | undefined>({ queryKey: ["products"] }, (old) =>
        Array.isArray(old) ? old.filter((p) => p.id !== id) : old
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      ctx?.prev?.forEach(([key, data]) => queryClient.setQueryData(key, data));
      toast.error("Ürün silinemedi — listeye geri alındı");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard"], refetchType: "none" });
      toast.success("Ürün silindi");
    },
  });

  // Optimistic stok: UI anında güncellenir, yazma arka planda + debounce'lu + retry'lı.
  const { adjustStock, setStock } = useStockWriter();

  /**
   * Stok değişikliğine "Geri al" ekle.
   *
   * Art arda basılan +/- tıklamaları TEK bildirime toplanır: her tıklamada bildirim çıkarsa
   * ekran çöp olur. Bekleyen kayıt ilk tıklamadaki değeri (`original`) saklar; 800 ms sessizlik
   * sonrası tek bildirim çıkar ve geri alma o ilk değere döner.
   */
  const stockUndo = useRef<
    Map<string, { original: number; latest: number; name: string; timer: ReturnType<typeof setTimeout> }>
  >(new Map());
  const armStockUndo = useCallback(
    (id: string, name: string, before: number, after: number) => {
      const pending = stockUndo.current.get(id);
      if (pending) clearTimeout(pending.timer);
      const original = pending?.original ?? before;
      const timer = setTimeout(() => {
        const entry = stockUndo.current.get(id);
        stockUndo.current.delete(id);
        if (!entry || entry.latest === entry.original) return;
        undoToast({
          message: `${entry.name} · stok ${entry.original} → ${entry.latest}`,
          onUndo: () => setStock(id, entry.original),
        });
      }, 800);
      stockUndo.current.set(id, { original, latest: after, name, timer });
    },
    [setStock]
  );
  // Sayfadan ayrılırken bekleyen bildirim zamanlayıcıları asılı kalmasın.
  useEffect(() => {
    const timers = stockUndo.current;
    return () => {
      timers.forEach((entry) => clearTimeout(entry.timer));
      timers.clear();
    };
  }, []);

  const handleAdjustStock = useCallback(
    (id: string, delta: number, current: number, name: string) => {
      adjustStock(id, delta, current);
      armStockUndo(id, name, current, Math.max(0, current + delta));
    },
    [adjustStock, armStockUndo]
  );
  const handleSetStock = useCallback(
    (id: string, stock: number, current: number, name: string) => {
      setStock(id, stock);
      armStockUndo(id, name, current, Math.max(0, Math.round(stock)));
    },
    [setStock, armStockUndo]
  );

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
      toast.error(`Ürünler silinemedi — listeye geri alındı (${e.message})`);
    },
    onSuccess: (data) => toast.success(`${data.deleted} ürün silindi`),
    onSettled: () => {
      // Optimistic kaldırma yeterli → liste refetch YOK; yalnız panel bayat işaretlenir.
      queryClient.invalidateQueries({ queryKey: ["dashboard"], refetchType: "none" });
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
      const prev = queryClient.getQueriesData<Product[]>({ queryKey: ["products"] });
      const idset = new Set(ids);
      // Geri alma satırları: "Geri al"a basılınca listeyi baştan çekmeden yerine koyabilmek için.
      const kaldirilan = new Map<string, Product>();
      for (const [, data] of prev) {
        if (!Array.isArray(data)) continue;
        for (const p of data) if (idset.has(p.id) && !kaldirilan.has(p.id)) kaldirilan.set(p.id, p);
      }
      queryClient.setQueriesData<Product[] | undefined>({ queryKey: ["products"] }, (old) =>
        Array.isArray(old) ? old.filter((p) => !idset.has(p.id)) : old
      );
      setSelectedIds(new Set());
      return { prev, kaldirilan: [...kaldirilan.values()] };
    },
    onError: (e: Error, _v, ctx) => {
      ctx?.prev?.forEach(([key, data]) => queryClient.setQueryData(key, data));
      toast.error(`${e.message} — değişiklik geri alındı`);
    },
    onSuccess: (data, variables, ctx) => {
      // Ürünler karşı sekmeye (Aktif ↔ Gizlenenler) geçti → o sekmenin önbelleği artık yanlış.
      dropOtherProductLists();
      undoToast({
        message: variables.hidden
          ? `${data.updated} ürün gizlendi`
          : `${data.updated} ürün geri getirildi`,
        onUndo: async () => {
          // Hata YUTULMAMALI: eskiden istek düşse bile satır listeye geri konuyordu ve
          // kullanıcı ürünü geri gelmiş sanıyordu — oysa veritabanında hâlâ gizliydi.
          try {
            await fetchJson("/api/products/bulk-visibility", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ids: variables.ids, hidden: !variables.hidden }),
            });
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Geri alınamadı");
            return;
          }
          restoreProductRows(ctx?.kaldirilan ?? []);
          dropOtherProductLists();
        },
      });
    },
    onSettled: () => {
      // Optimistic kaldırma yeterli → liste refetch YOK; yalnız panel bayat işaretlenir.
      queryClient.invalidateQueries({ queryKey: ["dashboard"], refetchType: "none" });
    },
  });

  // Tek ürün gizle/göster (satır içi)
  const toggleHiddenMutation = useMutation({
    mutationFn: ({ id, hidden }: { id: string; hidden: boolean }) =>
      fetchJson(`/api/products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden }),
      }),
    // Optimistic: ürün ANINDA mevcut listeden çıkar (gizlenince aktif görünümde, geri
    // gelince gizli görünümünde kalmamalı). UI beklemez; hata olursa geri alınır.
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ["products"] });
      const prev = queryClient.getQueriesData<Product[]>({ queryKey: ["products"] });
      // Geri alma satırı: "Geri al"a basılınca listeyi baştan çekmeden yerine koyabilmek için.
      const kaldirilan = prev
        .map(([, data]) => (Array.isArray(data) ? data.find((p) => p.id === id) : undefined))
        .find((p): p is Product => p != null);
      queryClient.setQueriesData<Product[] | undefined>({ queryKey: ["products"] }, (old) =>
        Array.isArray(old) ? old.filter((p) => p.id !== id) : old
      );
      return { prev, kaldirilan };
    },
    onError: (_e, _v, ctx) => {
      ctx?.prev?.forEach(([key, data]) => queryClient.setQueryData(key, data));
      toast.error("İşlem başarısız");
    },
    onSuccess: (_data, variables, ctx) => {
      // Liste optimistic güncellendi → tekrar çekme yok. Panel sayacı tazelensin.
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      // Ürün karşı sekmeye (Aktif ↔ Gizlenenler) geçti → o sekmenin önbelleği artık yanlış.
      dropOtherProductLists();
      undoToast({
        message: variables.hidden ? "Ürün gizlendi" : "Ürün geri getirildi",
        onUndo: async () => {
          try {
            await fetchJson(`/api/products/${variables.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ hidden: !variables.hidden }),
            });
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Geri alınamadı");
            return;
          }
          restoreProductRows(ctx?.kaldirilan ? [ctx.kaldirilan] : []);
          dropOtherProductLists();
        },
      });
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
      toast.error("Takma ad kaydedilemedi — bağlantını kontrol et");
    },
    // Optimistic zaten çipi güncelledi → tüm listeyi refetch ETME (refetchType:none = sadece bayat işaretle).
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["products"], refetchType: "none" }),
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
      toast.error("İşlem başarısız — değişiklik geri alındı");
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
    // Her platformun sonucunu TUT — hata yutma yok (eskiden `.catch(()=>null)` ile hata gizlenip
    // "Her şey güncel" deniyordu; kullanıcı neyin olduğunu göremiyordu).
    const results: { p: string; ok: boolean; checked: number; changed: number; error?: string }[] = [];
    setRefreshProgress({ total, done, label: platforms.length ? label(platforms[0]) : "Yenileniyor…" });
    // Platformlar PARALEL yenilenir: süre artık en yavaş platform kadar, üçünün TOPLAMI değil.
    // (Her platform kendi pazaryeri API'sini bekliyor; sırayla çalıştırmak bu beklemeleri topluyordu.)
    // İlerleme çubuğu determinate kalır: her platform bittikçe sayaç artar.
    await Promise.all(
      platforms.map(async (p) => {
        try {
          const r = await fetch(`/api/${p}/sync-products`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "refresh-prices" }),
          });
          const body = (await r.json().catch(() => ({}))) as { changed?: number; checked?: number; error?: string };
          if (!r.ok) {
            // Durum kodu kullanıcıya hitap etmiyor → sade bir neden yaz.
            results.push({ p, ok: false, checked: 0, changed: 0, error: String(body?.error || "bağlantı kurulamadı") });
          } else {
            const ch = Number(body?.changed) || 0;
            results.push({ p, ok: true, checked: Number(body?.checked) || 0, changed: ch });
            changed += ch;
          }
        } catch (e) {
          results.push({ p, ok: false, checked: 0, changed: 0, error: e instanceof Error ? e.message : "ağ hatası" });
        }
        done += 1;
        setRefreshProgress({ total, done, label: label(p) });
      })
    );
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
    // DÜRÜST sonuç: hata varsa AÇIKÇA göster, yoksa platform-bazlı kaç fiyat değişti / kaç kontrol edildi.
    const short = (p: string) => (p === "hepsiburada" ? "Hepsiburada" : p === "trendyol" ? "Trendyol" : "Shopify");
    const errs = results.filter((r) => !r.ok);
    if (errs.length) {
      toast.error(`Fiyat güncellenemedi → ${errs.map((e) => `${short(e.p)}: ${e.error}`).join(" · ")}`, { duration: 9000 });
    } else if (changed > 0) {
      toast.success(`Fiyatlar güncellendi → ${results.map((r) => `${short(r.p)} ${r.changed}`).join(" · ")}`);
    } else {
      const totalChecked = results.reduce((s, r) => s + r.checked, 0);
      toast.success(`Fiyatlar zaten güncel · ${totalChecked} ürün kontrol edildi`);
    }
    setTimeout(() => setRefreshProgress(null), 1200);
  };

  /**
   * Seçili ürünleri topluca düzenle.
   *
   * Kimlikler 200'lük dilimler hâlinde gönderilir: hem tek istek devasa olmaz hem de
   * ilerleme çubuğu GERÇEKTEN belirli olur (kaçıncı dilim / kaç dilim).
   *
   * `ids` dışarıdan verilir: yalnız O AN LİSTEDE GÖRÜNEN seçili ürünler gelsin.
   */
  const runBulkEdit = async (ids: string[]) => {
    if (bulkEditProgress) return;
    if (ids.length === 0) {
      toast.error("Seçili ürün kalmadı");
      return;
    }
    const patch: { desi?: number; categoryName?: string; madeToOrder?: boolean } = {};
    if (bulkEdit.desiOn) {
      const value = Number(bulkEdit.desi.replace(",", "."));
      if (!Number.isFinite(value) || value <= 0 || value > 30) {
        toast.error("Desi 0'dan büyük, 30'dan küçük olmalı");
        return;
      }
      patch.desi = value;
    }
    if (bulkEdit.categoryOn) {
      const value = bulkEdit.category.trim();
      if (!value) {
        toast.error("Kategori boş olamaz");
        return;
      }
      patch.categoryName = value;
    }
    if (bulkEdit.madeToOrderOn) patch.madeToOrder = bulkEdit.madeToOrder;
    if (Object.keys(patch).length === 0) {
      toast.error("Değiştirilecek bir alan seç");
      return;
    }

    const chunks: string[][] = [];
    for (let offset = 0; offset < ids.length; offset += 200) {
      chunks.push(ids.slice(offset, offset + 200));
    }
    setBulkEditProgress({ done: 0, total: chunks.length });
    let updated = 0;
    try {
      for (let index = 0; index < chunks.length; index += 1) {
        const result = await fetchJson<{ updated: number }>("/api/products/bulk-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: chunks[index], ...patch }),
        });
        updated += result.updated;
        setBulkEditProgress({ done: index + 1, total: chunks.length });
      }
      setBulkEditOpen(false);
      setSelectedIds(new Set());
      // Desi ve kategori kâr rakamını besliyor → listeyi optimistic yamamak ESKİ kârı ekranda
      // bırakırdı. Kullanıcı bilerek tetikledi, gerçek tazeleme burada doğru olan.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["products"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["orders"], refetchType: "none" }),
      ]);
      toast.success(`${updated} ürün güncellendi`);
    } catch (error) {
      toast.error(
        error instanceof Error ? `Güncellenemedi — ${error.message}` : "Ürünler güncellenemedi"
      );
    } finally {
      setBulkEditProgress(null);
    }
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
        await fetchJson(`/api/products/${product.id}`, {
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
      toast.success("Ürün eklendi");
      setAddOpen(false);
      form.reset();
    },
    onError: () => toast.error("Ürün eklenemedi"),
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

    // "Eşiğe Yakın": küçük bir zamla kârı belirgin artan ürünler — en çok kazandıran başta.
    if (filterMode === "near-threshold") {
      return searched
        .filter((p) => p.priceThreshold != null)
        .sort((a, b) => (b.priceThreshold?.gain ?? 0) - (a.priceThreshold?.gain ?? 0));
    }

    return searched;
  }, [debouncedFilter, products, filterMode]);

  /**
   * Toplu işlemlerin dokunacağı ürünler — SADECE o an listede görünenler.
   * Filtre/arama değişince seçim zaten sıfırlanıyor; bu kesişim ikinci emniyet kemeri.
   */
  const selectedProducts = useMemo(
    () => visibleSelection(filteredProducts, selectedIds),
    [filteredProducts, selectedIds]
  );
  const selectedCount = selectedProducts.length;
  const selectedIdList = useMemo(() => selectedProducts.map((p) => p.id), [selectedProducts]);
  /** Onay penceresinde ürün adları görünsün — "12 ürün" tek başına neyin gittiğini anlatmıyor. */
  const selectedNames = useMemo(
    () => selectionPreview(selectedProducts.map((p) => p.name)),
    [selectedProducts]
  );

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
    if (sort) {
      // Kolon sıralaması: grup satırı üyelerinin EN İYİsiyle temsil edilir (grubu açınca aynı sıra).
      // Değeri olmayan ürün her yönde en sona düşer — "—" satırları listenin başını kapatmasın.
      const valueOf = (p: Product) => p[sort.key];
      const best = (row: DisplayRow) => {
        const values =
          row.kind === "group"
            ? row.members.map(valueOf).filter((v): v is number => v != null)
            : [valueOf(row.product)].filter((v): v is number => v != null);
        return values.length ? Math.max(...values) : null;
      };
      const direction = sort.dir === "desc" ? -1 : 1;
      const compare = (a: number | null, b: number | null) => {
        if (a == null && b == null) return 0;
        if (a == null) return 1;
        if (b == null) return -1;
        return (a - b) * direction;
      };
      rows.sort((a, b) => compare(best(a), best(b)));
      for (const r of rows) {
        if (r.kind === "group") r.members.sort((a, b) => compare(valueOf(a), valueOf(b)));
      }
      return rows;
    }
    // "En Kârlı"/"Eşiğe Yakın" kendi sırasını korur; diğer tüm modlarda Türkçe alfabetik sırala
    // (görünür etikete göre). Sıra İSME bağlı olunca stok/maliyet düzenleyince ürün başa fırlamaz.
    if (!CLIENT_ONLY_FILTERS.includes(filterMode)) {
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
  }, [filteredProducts, filterMode, sort]);

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

  // ── Virtualization (sanallaştırma) ──
  // Sayfa <main> ile scroll olur. Eski windowing DOM'u biriktiriyordu (40→368 satır, hiç düşmüyor)
  // → ~15k düğüm → scroll/paint kasması. react-virtual ile DOM'da yalnız GÖRÜNÜR pencere + 2 boşluk
  // satırı kalır; scroll nereye gelirse gelsin sabit ~25 satır. Satır markup'ı AYNI (görsel değişmez).
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setScrollEl(document.querySelector<HTMLElement>("main"));
  }, []);
  const listRef = useRef<HTMLTableSectionElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  // tbody'nin scroll konteyneri (main) içindeki üst ofseti → virtualizer satırları doğru konumlasın.
  useEffect(() => {
    if (!scrollEl) return;
    const measure = () => {
      const tb = listRef.current;
      if (!tb || !scrollEl) return;
      setScrollMargin(
        tb.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // selectedIds/refreshProgress üst toolbar yüksekliğini değiştirebilir → yeniden ölç.
  }, [scrollEl, isLoading, selectedIds.size, refreshProgress]);

  // TanStack Virtual callback tabanlı API döndürür; React Compiler bu bileşeni bilinçli olarak atlar.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => 64,
    overscan: 10,
    scrollMargin,
    getItemKey: (i) => flatRows[i]?.key ?? i,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualItems.length > 0 ? Math.max(0, virtualItems[0].start - scrollMargin) : 0;
  const paddingBottom =
    virtualItems.length > 0
      ? Math.max(0, rowVirtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end)
      : 0;

  // Scroll konumunu koru: başka sayfaya geçip Ürünler'e dönünce kaldığın yerden devam (en başa atmaz).
  const scrollRestoredRef = useRef(false);
  useEffect(() => {
    if (!scrollEl) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        try {
          sessionStorage.setItem(
            "mh-products-scroll",
            JSON.stringify({ key: filterMode, top: scrollEl.scrollTop })
          );
        } catch { /* ignore */ }
      });
    };
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollEl, filterMode]);

  useEffect(() => {
    if (scrollRestoredRef.current || isLoading || flatRows.length === 0 || !scrollEl) return;
    scrollRestoredRef.current = true;
    try {
      const raw = sessionStorage.getItem("mh-products-scroll");
      if (!raw) return;
      const s = JSON.parse(raw) as { key: string; top: number };
      if (s.key !== filterMode || !(s.top > 0)) return;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (scrollEl) scrollEl.scrollTop = s.top;
        })
      );
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, flatRows.length, scrollEl]);

  const FILTER_OPTIONS: { value: FilterMode; label: string }[] = [
    { value: "active", label: "Aktif" },
    { value: "most-profitable", label: "En Kârlı" },
    { value: "near-threshold", label: "Eşiğe Yakın" },
    { value: "negative-profit", label: "Zarar Eden" },
    { value: "missing-cost", label: "Maliyet Eksik" },
    { value: "missing-desi", label: "Desi Eksik" },
    { value: "out-of-stock", label: "Stoğu Bitenler" },
    { value: "inactive", label: "İnaktif" },
    { value: "hidden", label: "Gizlenenler" },
    { value: "all", label: "Tümü" },
  ];

  /**
   * Varyant grubu başlık satırı — genel ad + görünen varyantlar + özet rakamlar.
   *
   * ⚠️ Özet YENİ bir kâr hesabı YAPMAZ: satırlarda zaten duran maliyet/kâr/fiyat değerlerini
   * aralığa çevirir. Bilinmeyen değer 0 gösterilmez, "—" kalır.
   * Tüm sayılar O AN LİSTEDE GÖRÜNEN varyantlardan gelir (filtre/arama ile tutarlı).
   */
  const renderGroupRow = (
    row: Extract<DisplayRow, { kind: "group" }>,
    measureRef?: (node: HTMLTableRowElement | null) => void,
    dataIndex?: number
  ) => {
    const expanded = expandedGroups.has(row.groupId);
    const ozet = summarizeGroup(row.members);
    const allSelected = row.members.length > 0 && row.members.every((m) => selectedIds.has(m.id));
    const firstImg = row.members.find((m) => m.imageUrl)?.imageUrl ?? null;
    const labels = row.members.map((m) => m.variantLabel || m.name).join(" · ");
    const priceText = ozet.fiyat ? rangeText(ozet.fiyat) : null;
    const stokIpucu = [
      `Görünen ${ozet.stokTutan} varyantın toplam stoğu`,
      ozet.siparisUzerine > 0 ? `${ozet.siparisUzerine} varyant sipariş üzerine` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <TableRow
        key={row.key}
        ref={measureRef}
        data-index={dataIndex}
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
        {/* Ürün satırıyla aynı taban genişlik — grup ve varyant satırları hizalı kalsın. */}
        <TableCell className="max-w-0 min-w-[260px]">
          <div className="flex items-center gap-1.5 w-full">
            <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
            <span className="font-semibold text-sm truncate">{row.groupName}</span>
            <Badge
              variant="secondary"
              className="shrink-0 tabular-nums"
              title="Listede görünen varyant sayısı"
            >
              {ozet.varyant} varyant
            </Badge>
          </div>
          <div className="text-[11px] text-muted-foreground/70 truncate mt-0.5 pl-6">
            {labels}
            {priceText && <span className="opacity-80"> · {priceText}</span>}
          </div>
        </TableCell>
        <TableCell className="py-2 text-center">
          {ozet.stokToplam == null ? (
            <span
              className="text-[10px] leading-tight text-muted-foreground bg-muted/60 rounded px-1.5 py-0.5"
              title="Tüm varyantlar sipariş üzerine üretilir — stok takip edilmez"
            >
              Sipariş üzerine
            </span>
          ) : (
            <span className="text-xs tabular-nums text-muted-foreground" title={stokIpucu}>
              Σ {ozet.stokToplam}
            </span>
          )}
        </TableCell>
        <TableCell className="text-right tabular-nums text-xs">
          <span
            className={cn(
              ozet.maliyet ? "text-muted-foreground" : "text-muted-foreground/40"
            )}
            title={rangeHint(ozet.maliyet, "Maliyet")}
          >
            {rangeText(ozet.maliyet)}
          </span>
        </TableCell>
        <TableCell className="text-right tabular-nums text-xs">
          <span
            className={cn(
              ozet.karSaat
                ? ozet.karSaat.max < 0
                  ? "text-destructive font-medium"
                  : "text-muted-foreground"
                : "text-muted-foreground/40"
            )}
            title={rangeHint(ozet.karSaat, "Kâr/saat")}
          >
            {rangeText(ozet.karSaat)}
          </span>
        </TableCell>
        <TableCell className="text-right tabular-nums text-xs">
          <span
            className={cn(
              ozet.karGram
                ? ozet.karGram.max < 0
                  ? "text-destructive font-medium"
                  : "text-muted-foreground"
                : "text-muted-foreground/40"
            )}
            title={rangeHint(ozet.karGram, "Kâr/gram")}
          >
            {rangeText(ozet.karGram)}
          </span>
        </TableCell>
        {PLATFORM_KEYS.map((platform) => {
          const ps = ozet.platformlar[platform];
          const integrationActive = integrations?.[platform] ?? false;
          if (!ps) {
            return (
              <TableCell key={platform} className="text-center">
                <span className="text-[10px] text-muted-foreground/40">
                  {integrationActive ? "—" : "Entegrasyon yok"}
                </span>
              </TableCell>
            );
          }
          const zarar = ps.kar != null && ps.kar.max < 0;
          const karisik = ps.kar != null && ps.kar.min < 0 && ps.kar.max >= 0;
          return (
            <TableCell key={platform} className="text-center">
              <div className="text-xs font-medium tabular-nums" title={rangeHint(ps.fiyat, "Fiyat")}>
                {rangeText(ps.fiyat)}
              </div>
              {ps.ilanli < ozet.varyant && (
                <div className="text-[9px] text-muted-foreground/60 mt-0.5 tabular-nums">
                  {ps.ilanli}/{ozet.varyant} varyantta
                </div>
              )}
              {ps.kar ? (
                <div
                  className={cn(
                    "text-[11px] tabular-nums mt-0.5",
                    zarar ? "text-destructive font-medium" : karisik ? "text-amber-500" : "text-green-500"
                  )}
                  title={rangeHint(ps.kar, "Kâr")}
                >
                  {rangeText(ps.kar)}
                  {ps.marj && (
                    <span className="opacity-70">
                      {" "}
                      (
                      {ps.marj.min === ps.marj.max
                        ? formatPercent(ps.marj.min)
                        : `${formatPercent(ps.marj.min, 0)} – ${formatPercent(ps.marj.max, 0)}`}
                      )
                    </span>
                  )}
                </div>
              ) : (
                <div className="text-[10px] text-muted-foreground/60 mt-0.5">maliyet eksik</div>
              )}
              {ps.komisyonEksik > 0 && (
                <div className="text-[10px] text-destructive font-semibold mt-0.5 flex items-center justify-center gap-1">
                  <AlertTriangle className="h-3 w-3" /> {ps.komisyonEksik} varyantta komisyon yok
                </div>
              )}
              {ps.kargoEksik > 0 && (
                <div className="text-[10px] text-amber-500 font-semibold mt-0.5 flex items-center justify-center gap-1">
                  <AlertTriangle className="h-3 w-3" /> {ps.kargoEksik} varyantta kargo yok
                </div>
              )}
            </TableCell>
          );
        })}
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
          {selectedCount > 0 && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setBulkEditOpen(true)}
                title="Seçili ürünlerin desi, kategori ve sipariş üzerine üretim bilgisini birlikte değiştir"
              >
                <SlidersHorizontal className="h-4 w-4 mr-2" />
                {selectedCount} Ürünü Düzenle
              </Button>
              {filterMode === "hidden" ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={bulkVisibilityMutation.isPending}
                  onClick={() =>
                    bulkVisibilityMutation.mutate({ ids: selectedIdList, hidden: false })
                  }
                >
                  <Eye className="h-4 w-4 mr-2" />
                  {selectedCount} Ürünü Geri Getir
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={bulkVisibilityMutation.isPending}
                  onClick={() =>
                    bulkVisibilityMutation.mutate({ ids: selectedIdList, hidden: true })
                  }
                >
                  <EyeOff className="h-4 w-4 mr-2" />
                  {selectedCount} Seçileni Gizle
                </Button>
              )}
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setBulkDeleteOpen(true)}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                {selectedCount} Seçileni Sil
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
              title="Tüm platformlardan güncel fiyatları çeker ve listeyi tazeler"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Fiyatları Güncelle &amp; Yenile
            </Button>
          )}
          <Button onClick={() => setMarketplaceOpen(true)} size="sm" variant="outline" title="Shopify'da olmayan, sadece Trendyol veya Hepsiburada'daki ürünü ekle">
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

        {/* Panel'den gelen platform daraltması görünür olsun ve tek tıkla kalksın. */}
        {platformParam && (
          <button
            type="button"
            onClick={() => setPlatformParam(null)}
            title="Bu platform daraltmasını kaldır"
            className="inline-flex items-center gap-1.5 rounded-md border bg-muted/30 px-2.5 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/60"
          >
            {PLATFORM_PARAM_LABEL[platformParam]}
            <X className="h-3.5 w-3.5 opacity-70" />
          </button>
        )}

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
              {/* Sütunun tabanı burada belirlenir; dar pencerede ezilmek yerine tablo yatay kayar. */}
              <TableHead className="min-w-[260px]">Ürün</TableHead>
              <TableHead className="text-center w-[110px]">Stok</TableHead>
              <TableHead className="text-right tabular-nums w-[90px]">Maliyet</TableHead>
              <TableHead className="text-right w-[100px] p-0">
                <SortableHead
                  label="Kâr/saat"
                  hint="Baskı süresine göre kazanç — sıralamak için tıkla"
                  active={sort?.key === "profitPerHour" ? sort.dir : null}
                  onClick={() => toggleSort("profitPerHour")}
                />
              </TableHead>
              <TableHead className="text-right w-[100px] p-0">
                <SortableHead
                  label="Kâr/gram"
                  hint="Filament gramajına göre kazanç — sıralamak için tıkla"
                  active={sort?.key === "profitPerGram" ? sort.dir : null}
                  onClick={() => toggleSort("profitPerGram")}
                />
              </TableHead>
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
          <TableBody ref={listRef}>
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
                    <TableCell><Skeleton className="h-3 w-12 ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-3 w-12 ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-3 w-20 mx-auto" /></TableCell>
                    <TableCell><Skeleton className="h-3 w-20 mx-auto" /></TableCell>
                    <TableCell><Skeleton className="h-3 w-20 mx-auto" /></TableCell>
                    <TableCell><Skeleton className="h-7 w-7 rounded" /></TableCell>
                  </TableRow>
                ))}
              </>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={11} className="text-center py-8 text-destructive">
                  Ürünler yüklenemedi.
                </TableCell>
              </TableRow>
            ) : filteredProducts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={11} className="text-center py-8 text-muted-foreground">
                  {filterMode === "inactive"
                    ? "İnaktif ürün bulunmuyor."
                    : filterMode === "out-of-stock"
                      ? "Stoğu biten aktif ürün bulunmuyor."
                      : filterMode === "near-threshold"
                        ? "Şu an küçük bir zamla kârı belirgin artacak ürün yok."
                        : "Ürün bulunamadı. CSV ile içe aktar veya manuel ekle."}
                </TableCell>
              </TableRow>
            ) : (
              <>
              {paddingTop > 0 && (
                <tr aria-hidden="true">
                  <td colSpan={11} className="p-0 border-0" style={{ height: paddingTop }} />
                </tr>
              )}
              {virtualItems.map((vi) => {
                const row = flatRows[vi.index];
                if (!row) return null;
                if (row.kind === "group") return renderGroupRow(row, rowVirtualizer.measureElement, vi.index);
                const product = row.product;
                return (
                  <ProductRow
                    key={row.key}
                    measureRef={rowVirtualizer.measureElement}
                    dataIndex={vi.index}
                    product={product}
                    isMember={row.isMember}
                    isSelected={selectedIds.has(product.id)}
                    isEditingAlias={aliasEdit?.id === product.id}
                    aliasValue={aliasEdit?.id === product.id ? aliasEdit.value : ""}
                    integrations={integrations}
                    onToggleSelect={handleToggleSelect}
                    onAdjustStock={handleAdjustStock}
                    onSetStock={handleSetStock}
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
              {paddingBottom > 0 && (
                <tr aria-hidden="true">
                  <td colSpan={11} className="p-0 border-0" style={{ height: paddingBottom }} />
                </tr>
              )}
              </>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Yeni Ürün Ekle</DialogTitle>
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
              <Label>Ürün Adı *</Label>
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
                <Label>Satış Fiyatı (TL) *</Label>
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
                <Label>Ürün Maliyeti (TL)</Label>
                <Input type="number" step="0.01" {...form.register("productCost")} />
              </div>
            </div>
            <div>
              <Label>Ambalaj Maliyeti (TL)</Label>
              <Input type="number" step="0.01" {...form.register("packagingCost")} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
                İptal
              </Button>
              <Button type="submit" disabled={addMutation.isPending}>
                {addMutation.isPending ? "Ekleniyor..." : "Ekle"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Toplu düzenleme — yalnız işaretlenen alanlar değişir */}
      <Dialog
        open={bulkEditOpen}
        onOpenChange={(open) => {
          if (bulkEditProgress) return; // iş sürerken kapanmasın
          setBulkEditOpen(open);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{selectedCount} Ürünü Düzenle</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground -mt-1">
            Listede seçili {selectedCount} ürün güncellenecek. Yalnız işaretlediğin alanlar
            değişir; diğerleri olduğu gibi kalır.
          </p>

          <div className="space-y-3">
            <div className="rounded-lg border p-3 space-y-2 transition-colors hover:bg-muted/30">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={bulkEdit.desiOn}
                  onCheckedChange={(v) => setBulkEdit((s) => ({ ...s, desiOn: !!v }))}
                />
                <span className="text-sm font-medium">Desi</span>
              </label>
              {bulkEdit.desiOn && (
                <div className="animate-in fade-in slide-in-from-top-1 duration-200">
                  <Input
                    type="number"
                    step="0.1"
                    min="0.1"
                    max="30"
                    placeholder="örn. 2"
                    value={bulkEdit.desi}
                    onChange={(e) => setBulkEdit((s) => ({ ...s, desi: e.target.value }))}
                  />
                  <p className="text-[11px] text-amber-500 mt-1">Desi değişince kargo ve kâr yeniden hesaplanır.</p>
                </div>
              )}
            </div>

            <div className="rounded-lg border p-3 space-y-2 transition-colors hover:bg-muted/30">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={bulkEdit.categoryOn}
                  onCheckedChange={(v) => setBulkEdit((s) => ({ ...s, categoryOn: !!v }))}
                />
                <span className="text-sm font-medium">Kategori</span>
              </label>
              {bulkEdit.categoryOn && (
                <div className="animate-in fade-in slide-in-from-top-1 duration-200">
                  <Input
                    placeholder="örn. Dekorasyon"
                    value={bulkEdit.category}
                    onChange={(e) => setBulkEdit((s) => ({ ...s, category: e.target.value }))}
                  />
                  <p className="text-[11px] text-amber-500 mt-1">Kategori değişince komisyon ve kâr yeniden hesaplanır.</p>
                </div>
              )}
            </div>

            <div className="rounded-lg border p-3 space-y-2 transition-colors hover:bg-muted/30">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={bulkEdit.madeToOrderOn}
                  onCheckedChange={(v) => setBulkEdit((s) => ({ ...s, madeToOrderOn: !!v }))}
                />
                <span className="text-sm font-medium">Sipariş üzerine üretilir</span>
              </label>
              {bulkEdit.madeToOrderOn && (
                <div className="flex items-center gap-2 animate-in fade-in slide-in-from-top-1 duration-200">
                  <Switch
                    checked={bulkEdit.madeToOrder}
                    onCheckedChange={(v) => setBulkEdit((s) => ({ ...s, madeToOrder: v }))}
                  />
                  <span className="text-sm text-muted-foreground">
                    {bulkEdit.madeToOrder ? "Evet — stok tutulmaz" : "Hayır — stok tutulur"}
                  </span>
                </div>
              )}
            </div>
          </div>

          {bulkEditProgress && (
            <div className="space-y-1 animate-in fade-in duration-200">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" /> Ürünler güncelleniyor…
                </span>
                <span className="tabular-nums font-semibold">
                  {bulkEditProgress.done}/{bulkEditProgress.total} · %
                  {Math.round((bulkEditProgress.done / Math.max(1, bulkEditProgress.total)) * 100)}
                </span>
              </div>
              <Progress
                value={(bulkEditProgress.done / Math.max(1, bulkEditProgress.total)) * 100}
                className="h-1.5"
              />
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBulkEditOpen(false)}
              disabled={!!bulkEditProgress}
            >
              İptal
            </Button>
            <Button
              onClick={() => void runBulkEdit(selectedIdList)}
              disabled={!!bulkEditProgress || selectedCount === 0}
            >
              {bulkEditProgress ? "Güncelleniyor…" : `${selectedCount} Ürünü Güncelle`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Toplu silme onayı — hangi ürünlerin gittiği AÇIKÇA görünür */}
      <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Toplu Silme Onayı</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Listede seçili <strong className="text-foreground">{selectedCount}</strong> ürün
            silinecek. Bu işlem geri alınamaz — maliyet bilgileri, platform ilanları ve fiyat
            geçmişi de silinir.
          </p>
          {selectedCount > 0 && (
            <div className="rounded-md border bg-muted/30 max-h-48 overflow-y-auto p-2 space-y-0.5 animate-in fade-in duration-200">
              {selectedNames.shown.map((name, i) => (
                <p key={`${name}-${i}`} className="text-xs truncate" title={name}>
                  {name}
                </p>
              ))}
              {selectedNames.rest > 0 && (
                <p className="text-xs text-muted-foreground pt-1">
                  ve {selectedNames.rest} ürün daha
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDeleteOpen(false)}>
              İptal
            </Button>
            <Button
              variant="destructive"
              onClick={() => bulkDeleteMutation.mutate(selectedIdList)}
              disabled={bulkDeleteMutation.isPending || selectedCount === 0}
            >
              {bulkDeleteMutation.isPending
                ? "Siliniyor..."
                : `${selectedCount} Ürünü Sil`}
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
            alınamaz — maliyet bilgileri, platform ilanları ve fiyat geçmişi de silinir.
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
  const windowKey = `${platform}:${debouncedSearch}`;
  const [visibleWindow, setVisibleWindow] = useState({ key: windowKey, count: 60 });
  const visibleCount = visibleWindow.key === windowKey ? visibleWindow.count : 60;
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
                  setVisibleWindow((current) => ({
                    key: windowKey,
                    count: (current.key === windowKey ? current.count : 60) + 60,
                  }));
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
                            {u.barcode} · {u.externalSku ?? "SKU yok"}
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
