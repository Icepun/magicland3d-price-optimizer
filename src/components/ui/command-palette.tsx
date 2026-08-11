"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  BarChart3,
  Boxes,
  CalculatorIcon,
  ClipboardList,
  CornerDownLeft,
  Disc3,
  Factory,
  LayoutDashboard,
  Package,
  PackageCheck,
  Percent,
  Printer,
  Receipt,
  Search,
  Settings,
  Settings2,
  Truck,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { thumbUrl } from "@/lib/image";
import { formatCurrency, formatNumber } from "@/lib/format";
import { PlatformLogo } from "@/components/PlatformLogo";

/* ══════════════════════════════════════════════════════════════════════════
   SAF ARAMA ÇEKİRDEĞİ (React'ten bağımsız — testlerde doğrudan çağrılır)
   ══════════════════════════════════════════════════════════════════════════ */

export type PaletteKind = "sayfa" | "urun" | "siparis" | "makara";

export interface PaletteItem {
  id: string;
  kind: PaletteKind;
  title: string;
  subtitle?: string;
  /** Başlıkta görünmeyen ama aranabilir metinler: barkod, takma ad, müşteri, eş anlamlı. */
  terms?: string[];
  href?: string;
  image?: string | null;
  /** Renk noktası (filament makarası). */
  dot?: string;
  /** Sağdaki küçük etiket (fiyat, adet…). */
  badge?: string;
  platform?: "shopify" | "trendyol" | "hepsiburada" | "manual";
  icon?: LucideIcon;
}

/**
 * Türkçe harfleri aramada eşitler: "şoför" yazamayan da "sofor" ile bulsun.
 * Eşleme TEK karakter → TEK karakter; bu sayede normalleştirilmiş metindeki konum,
 * ham metindeki konumla birebir aynı kalır (vurgulama bunun üzerine kuruludur).
 * `İ` özellikle önce eşlenir: JS'te "İ".toLowerCase() iki karaktere açılır.
 */
const HARF_ESLEME: Record<string, string> = {
  İ: "i",
  I: "i",
  ı: "i",
  Ş: "s",
  ş: "s",
  Ğ: "g",
  ğ: "g",
  Ü: "u",
  ü: "u",
  Ö: "o",
  ö: "o",
  Ç: "c",
  ç: "c",
  Â: "a",
  â: "a",
  Î: "i",
  î: "i",
  Û: "u",
  û: "u",
};

export function normalizeSearchText(value: string): string {
  let out = "";
  for (const ch of value) out += HARF_ESLEME[ch] ?? ch;
  return out.toLowerCase();
}

/** Kelime başı sayılan ayraçlar — ortada geçmek yerine kelime başı eşleşmesi daha değerli. */
const AYRAC = /[\s\-_/(.,:;·×#]/;

/**
 * Tek bir metin ile tek bir arama kelimesinin yakınlığı: 100 tam, 80 baştan,
 * 60 kelime başı, 40 içinde geçiyor, 0 eşleşme yok.
 */
export function scoreMatch(haystack: string, needle: string): number {
  const n = normalizeSearchText(needle);
  if (!n) return 1;
  const h = normalizeSearchText(haystack);
  if (!h) return 0;
  if (h === n) return 100;
  if (h.startsWith(n)) return 80;
  const at = h.indexOf(n);
  if (at < 0) return 0;
  return AYRAC.test(h[at - 1] ?? "") ? 60 : 40;
}

/**
 * Bir kaydın toplam puanı. Aramadaki HER kelime en az bir alanda geçmeli
 * ("mavi kutu" → hem "mavi" hem "kutu"); puan kelime puanlarının ortalamasıdır.
 */
export function scoreEntry(
  fields: Array<string | null | undefined>,
  query: string
): number {
  const tokens = normalizeSearchText(query).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 1;
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const field of fields) {
      if (!field) continue;
      const score = scoreMatch(field, token);
      if (score > best) best = score;
    }
    if (best === 0) return 0;
    total += best;
  }
  return total / tokens.length;
}

const KIND_PRIORITY: Record<PaletteKind, number> = {
  sayfa: 3,
  urun: 2,
  siparis: 1,
  makara: 0,
};

/**
 * Kayıtları puana göre sıralar ve kırpar.
 * Arama kutusu BOŞKEN yalnız sayfalar listelenir: yüzlerce ürünü sebepsiz basmak hem
 * yavaş hem de kullanıcıya hiçbir şey söylemez.
 */
export function rankPaletteItems(
  items: PaletteItem[],
  query: string,
  limit = 24,
  perKind = 6
): PaletteItem[] {
  const trimmed = query.trim();
  const pool = trimmed ? items : items.filter((item) => item.kind === "sayfa");

  const scored: Array<{ item: PaletteItem; score: number }> = [];
  for (const item of pool) {
    const score = scoreEntry(
      [item.title, item.subtitle, ...(item.terms ?? [])],
      trimmed
    );
    if (score > 0) scored.push({ item, score });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      KIND_PRIORITY[b.item.kind] - KIND_PRIORITY[a.item.kind] ||
      a.item.title.localeCompare(b.item.title, "tr")
  );

  const perKindCount = new Map<PaletteKind, number>();
  const out: PaletteItem[] = [];
  for (const { item } of scored) {
    const used = perKindCount.get(item.kind) ?? 0;
    if (used >= perKind) continue;
    perKindCount.set(item.kind, used + 1);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/** Sıralamayı bozmadan türlere ayırır: en iyi eşleşmenin türü en üstte kalır. */
export function groupPaletteItems(
  items: PaletteItem[]
): Array<{ kind: PaletteKind; items: PaletteItem[] }> {
  const order: PaletteKind[] = [];
  const buckets = new Map<PaletteKind, PaletteItem[]>();
  for (const item of items) {
    let bucket = buckets.get(item.kind);
    if (!bucket) {
      bucket = [];
      buckets.set(item.kind, bucket);
      order.push(item.kind);
    }
    bucket.push(item);
  }
  return order.map((kind) => ({ kind, items: buckets.get(kind) ?? [] }));
}

/** Ok tuşları listenin başında/sonunda takılmasın diye başa/sona sarar. */
export function moveActiveIndex(
  current: number,
  delta: number,
  count: number
): number {
  if (count <= 0) return 0;
  return (((current + delta) % count) + count) % count;
}

/** Eşleşen bölümü kalınlaştırmak için metni parçalara böler. */
export function highlightParts(
  text: string,
  query: string
): Array<{ text: string; hit: boolean }> {
  const token = normalizeSearchText(query).trim().split(/\s+/).filter(Boolean)[0];
  if (!token) return [{ text, hit: false }];
  const hay = normalizeSearchText(text);
  // Konum eşlemesi bozulduysa vurgulama yapma (yanlış harfi kalınlaştırmaktansa hiç yapma).
  if (hay.length !== text.length) return [{ text, hit: false }];
  const at = hay.indexOf(token);
  if (at < 0) return [{ text, hit: false }];
  const parts: Array<{ text: string; hit: boolean }> = [];
  if (at > 0) parts.push({ text: text.slice(0, at), hit: false });
  parts.push({ text: text.slice(at, at + token.length), hit: true });
  if (at + token.length < text.length) {
    parts.push({ text: text.slice(at + token.length), hit: false });
  }
  return parts;
}

/* ══════════════════════════════════════════════════════════════════════════
   SAYFALAR ARASI KÜÇÜK İSTEK KÖPRÜSÜ
   Aramadan bir siparişe basınca Siparişler sayfası o numarayla açılmalı. Adres
   çubuğuna parametre koymak bu ekranda ön-render kuralları yüzünden pahalı; onun
   yerine oturumluk bir not + anlık olay kullanıyoruz (sayfa açıksa anında uygular,
   değilse açılırken notu okur).
   ══════════════════════════════════════════════════════════════════════════ */

export interface OrdersRequest {
  search?: string;
  view?: "liste" | "hazirlik";
}

export const ORDERS_REQUEST_EVENT = "mh-siparis-istegi";
const ORDERS_REQUEST_KEY = "mh-list-state:siparis-istegi";

export function requestOrdersView(request: OrdersRequest): void {
  try {
    sessionStorage.setItem(ORDERS_REQUEST_KEY, JSON.stringify(request));
  } catch {
    /* kota/gizli mod → istek yalnız anlık olayla iletilir */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<OrdersRequest>(ORDERS_REQUEST_EVENT, { detail: request })
    );
  }
}

/** Bekleyen isteği okur ve siler (aynı istek ikinci kez uygulanmasın). */
export function takeOrdersRequest(): OrdersRequest | null {
  try {
    const raw = sessionStorage.getItem(ORDERS_REQUEST_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(ORDERS_REQUEST_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { search, view } = parsed as OrdersRequest;
    return {
      search: typeof search === "string" ? search : undefined,
      view: view === "hazirlik" || view === "liste" ? view : undefined,
    };
  } catch {
    return null;
  }
}

export const PALETTE_OPEN_EVENT = "mh-arama-ac";

/** Kenar çubuğundaki arama düğmesi bunu çağırır. */
export function openCommandPalette(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PALETTE_OPEN_EVENT));
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   VERİ TİPLERİ (yalnız aramanın okuduğu küçük alanlar)
   ══════════════════════════════════════════════════════════════════════════ */

interface LiteProduct {
  id: string;
  name: string;
  alias?: string | null;
  barcode?: string | null;
  sku?: string | null;
  imageUrl?: string | null;
  currentSalePrice?: number | null;
}

interface LiteSpool {
  id: string;
  name: string;
  material?: string | null;
  colorName?: string | null;
  colorHex?: string | null;
  brand?: string | null;
  remainingGrams?: number | null;
}

interface LiteOrder {
  platform: "shopify" | "trendyol" | "hepsiburada" | "manual";
  id: string;
  orderNumber: string;
  customer: string | null;
  itemCount: number;
  items: Array<{ name: string }>;
}

interface OrdersCacheShape {
  orders?: LiteOrder[];
}

/* ══════════════════════════════════════════════════════════════════════════
   SAYFA KAYITLARI
   ══════════════════════════════════════════════════════════════════════════ */

const HAZIRLIK_ID = "sayfa:hazirlik";

const PAGE_ITEMS: PaletteItem[] = [
  { id: "sayfa:/", kind: "sayfa", title: "Panel", subtitle: "Günün özeti", href: "/", icon: LayoutDashboard, terms: ["ana sayfa", "gosterge", "ozet"] },
  { id: "sayfa:/reports", kind: "sayfa", title: "Raporlar", subtitle: "Ciro ve kâr grafikleri", href: "/reports", icon: BarChart3, terms: ["grafik", "aylik", "kazanc"] },
  { id: "sayfa:/products", kind: "sayfa", title: "Ürünler", subtitle: "Fiyat, stok ve maliyet", href: "/products", icon: Package, terms: ["urun listesi", "fiyat", "stok"] },
  { id: "sayfa:/orders", kind: "sayfa", title: "Siparişler", subtitle: "Tüm platformlardan gelen satışlar", href: "/orders", icon: ClipboardList, terms: ["satis", "musteri"] },
  { id: HAZIRLIK_ID, kind: "sayfa", title: "Hazırlık Listesi", subtitle: "Bugün gönderilecek ürünler, adetleriyle", href: "/orders", icon: PackageCheck, terms: ["paketleme", "toplama", "gonderilecek", "kargo hazirlik"] },
  { id: "sayfa:/printers", kind: "sayfa", title: "Yazıcılar", subtitle: "Baskı durumu ve kuyruk", href: "/printers", icon: Printer, terms: ["baski", "3d"] },
  { id: "sayfa:/models", kind: "sayfa", title: "Modeller", subtitle: "Tasarım dosyaların", href: "/models", icon: Boxes, terms: ["tasarim", "dosya"] },
  { id: "sayfa:/cost-templates", kind: "sayfa", title: "Maliyet & Paketleme", subtitle: "Kutu, koli ve maliyet şablonları", href: "/cost-templates", icon: CalculatorIcon, terms: ["kutu", "koli", "sablon"] },
  { id: "sayfa:/spools", kind: "sayfa", title: "Filament", subtitle: "Makara stoğu ve renkler", href: "/spools", icon: Disc3, terms: ["makara", "renk", "gram"] },
  { id: "sayfa:/planner", kind: "sayfa", title: "Üretim", subtitle: "Ne basılmalı planı", href: "/planner", icon: Factory, terms: ["plan", "uretim kuyrugu"] },
  { id: "sayfa:/commission-rules", kind: "sayfa", title: "Komisyonlar", subtitle: "Platform kesinti oranları", href: "/commission-rules", icon: Percent, terms: ["oran", "kesinti"] },
  { id: "sayfa:/cargo-rules", kind: "sayfa", title: "Kargo", subtitle: "Desi ve gönderi fiyatları", href: "/cargo-rules", icon: Truck, terms: ["desi", "gonderi"] },
  { id: "sayfa:/expenses", kind: "sayfa", title: "Gider Ödemeleri", subtitle: "Aylık sabit giderler", href: "/expenses", icon: Receipt, terms: ["fatura", "masraf", "odeme"] },
  { id: "sayfa:/api-settings", kind: "sayfa", title: "Entegrasyonlar", subtitle: "Mağaza bağlantıları", href: "/api-settings", icon: Settings2, terms: ["shopify", "trendyol", "hepsiburada", "baglanti"] },
  { id: "sayfa:/settings", kind: "sayfa", title: "Ayarlar", subtitle: "Yedek, tema ve genel ayarlar", href: "/settings", icon: Settings, terms: ["yedek", "tema", "senkron"] },
];

const KIND_LABEL: Record<PaletteKind, string> = {
  sayfa: "Sayfalar",
  urun: "Ürünler",
  siparis: "Siparişler",
  makara: "Filament",
};

const KIND_ICON: Record<PaletteKind, LucideIcon> = {
  sayfa: LayoutDashboard,
  urun: Package,
  siparis: ClipboardList,
  makara: Disc3,
};

/* ══════════════════════════════════════════════════════════════════════════
   BİLEŞEN
   ══════════════════════════════════════════════════════════════════════════ */

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Ctrl/Cmd + K her yerden açar-kapatır; kenar çubuğundaki düğme de aynı kapıyı kullanır.
  // Her açılış temiz başlasın diye kutu burada sıfırlanır.
  useEffect(() => {
    const reset = () => {
      setQuery("");
      setDebounced("");
      setActiveIndex(0);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        reset();
        setOpen((value) => !value);
      }
    };
    const onOpenRequest = () => {
      reset();
      setOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(PALETTE_OPEN_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(PALETTE_OPEN_EVENT, onOpenRequest);
    };
  }, []);

  // Yazarken her tuşta süzme yapmayalım; kutu anında yazar, liste 160ms sonra.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 160);
    return () => clearTimeout(timer);
  }, [query]);

  const trimmed = debounced.trim();

  // Hafif ürün listesi — varyant seçicinin kullandığı AYNI kayıtla paylaşılır, ikinci kez çekilmez.
  const { data: products, isLoading: productsLoading } = useQuery<LiteProduct[]>({
    queryKey: ["products", "variant-picker"],
    queryFn: () =>
      fetch("/api/products?filter=all&lite=1").then((response) => response.json()),
    enabled: open,
    staleTime: 5 * 60_000,
  });

  const { data: spools } = useQuery<LiteSpool[]>({
    queryKey: ["spools"],
    queryFn: () => fetch("/api/spools").then((response) => response.json()),
    enabled: open,
    staleTime: 5 * 60_000,
  });

  // Siparişler YALNIZ daha önce yüklendiyse aranır: arama kutusu üç pazaryerini
  // canlı yoklayıp kullanıcıyı bekletmemeli.
  const { data: ordersData } = useQuery<OrdersCacheShape>({
    queryKey: ["orders"],
    queryFn: skipToken,
  });

  // Barkod/stok kodu hafif listede yok. Bu yüzden yalnız hiçbir ürün eşleşmediğinde
  // ve en az 3 karakter yazıldığında tek bir arama isteği atılır.
  const localProductHit = useMemo(() => {
    if (!trimmed || !products?.length) return false;
    return products.some(
      (product) =>
        scoreEntry([product.name, product.alias, product.barcode, product.sku], trimmed) > 0
    );
  }, [products, trimmed]);

  const { data: deepProducts, isFetching: deepFetching } = useQuery<LiteProduct[]>({
    queryKey: ["products", "arama", trimmed],
    queryFn: () =>
      fetch(`/api/products?search=${encodeURIComponent(trimmed)}`).then((response) =>
        response.json()
      ),
    enabled: open && trimmed.length >= 3 && Boolean(products) && !localProductHit,
    staleTime: 5 * 60_000,
  });

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [...PAGE_ITEMS];

    const seenProducts = new Set<string>();
    const pushProduct = (product: LiteProduct) => {
      if (!product?.id || seenProducts.has(product.id)) return;
      seenProducts.add(product.id);
      list.push({
        id: `urun:${product.id}`,
        kind: "urun",
        title: product.name,
        subtitle: product.alias ?? undefined,
        terms: [product.alias, product.barcode, product.sku].filter(
          (value): value is string => Boolean(value)
        ),
        href: `/products/${product.id}`,
        image: product.imageUrl ?? null,
        badge:
          typeof product.currentSalePrice === "number"
            ? formatCurrency(product.currentSalePrice, { decimals: 0 })
            : undefined,
      });
    };
    products?.forEach(pushProduct);
    deepProducts?.forEach(pushProduct);

    ordersData?.orders?.forEach((order) => {
      list.push({
        id: `siparis:${order.platform}:${order.id}`,
        kind: "siparis",
        title: order.orderNumber,
        subtitle:
          [order.customer, `${order.itemCount} adet`].filter(Boolean).join(" · ") ||
          undefined,
        terms: (order.items ?? []).map((item) => item.name),
        platform: order.platform,
      });
    });

    spools?.forEach((spool) => {
      const parts = [spool.material, spool.colorName].filter(Boolean) as string[];
      if (typeof spool.remainingGrams === "number") {
        parts.push(`${formatNumber(spool.remainingGrams)} g kaldı`);
      }
      list.push({
        id: `makara:${spool.id}`,
        kind: "makara",
        title: spool.name,
        subtitle: parts.join(" · ") || undefined,
        terms: [spool.material, spool.colorName, spool.brand].filter(
          (value): value is string => Boolean(value)
        ),
        href: "/spools",
        dot: spool.colorHex ?? undefined,
      });
    });

    return list;
  }, [products, deepProducts, ordersData, spools]);

  const ranked = useMemo(
    () => rankPaletteItems(items, trimmed),
    [items, trimmed]
  );
  const groups = useMemo(() => groupPaletteItems(ranked), [ranked]);
  const flatItems = useMemo(
    () => groups.flatMap((group) => group.items),
    [groups]
  );

  // Sonuçlar kısalınca seçim listenin dışında kalmasın (veri sonradan gelebilir).
  const safeIndex = Math.min(activeIndex, Math.max(0, flatItems.length - 1));

  // Seçili satır her zaman görünür kalsın.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-secim="${safeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [safeIndex, flatItems.length]);

  const run = useCallback(
    (item: PaletteItem | undefined) => {
      if (!item) return;
      setOpen(false);
      if (item.kind === "siparis") {
        requestOrdersView({ search: item.title, view: "liste" });
        router.push("/orders");
        return;
      }
      if (item.id === HAZIRLIK_ID) {
        requestOrdersView({ view: "hazirlik" });
        router.push("/orders");
        return;
      }
      if (item.href) router.push(item.href);
    },
    [router]
  );

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(moveActiveIndex(safeIndex, 1, flatItems.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(moveActiveIndex(safeIndex, -1, flatItems.length));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, flatItems.length - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      run(flatItems[safeIndex]);
    }
  };

  if (!open) return null;

  const busy = productsLoading || deepFetching;
  let renderIndex = -1;

  return (
    <div
      className="fixed inset-0 z-[120] flex justify-center bg-background/70 px-4 pt-[10vh] backdrop-blur-sm animate-in fade-in duration-150"
      onMouseDown={() => setOpen(false)}
      role="presentation"
    >
      <div
        className="flex max-h-[72vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl animate-in fade-in zoom-in-95 slide-in-from-top-2 duration-200"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onPanelKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="Arama"
      >
        {/* Arama kutusu */}
        <div className="flex items-center gap-2.5 border-b border-border/70 px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            // Kutu açılır açılmaz yazmaya başlanabilsin.
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            placeholder="Ürün, sipariş, makara ya da sayfa ara…"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Arama"
            autoComplete="off"
            spellCheck={false}
          />
          {busy && (
            <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
            </span>
          )}
          <kbd className="shrink-0 rounded border border-border/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            Esc
          </kbd>
        </div>

        {/* Sonuçlar */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
          {flatItems.length === 0 ? (
            <div className="px-3 py-10 text-center animate-in fade-in duration-300">
              <Search className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" strokeWidth={1.4} />
              <p className="text-sm font-medium">Sonuç bulunamadı</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Ürün adı, barkod, sipariş numarası ya da makara adı deneyebilirsin.
              </p>
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.kind} className="mb-1.5 last:mb-0">
                <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {KIND_LABEL[group.kind]}
                </p>
                {group.items.map((item) => {
                  renderIndex += 1;
                  const index = renderIndex;
                  return (
                    <PaletteRow
                      key={item.id}
                      item={item}
                      query={trimmed}
                      index={index}
                      active={index === safeIndex}
                      onHover={() => setActiveIndex(index)}
                      onSelect={() => run(item)}
                    />
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Klavye ipuçları */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/70 px-4 py-2 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <kbd className="rounded border border-border/70 px-1 py-0.5">↑</kbd>
            <kbd className="rounded border border-border/70 px-1 py-0.5">↓</kbd>
            gez
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="inline-flex items-center rounded border border-border/70 px-1 py-0.5">
              <CornerDownLeft className="h-2.5 w-2.5" />
            </kbd>
            aç
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="rounded border border-border/70 px-1 py-0.5">Esc</kbd>
            kapat
          </span>
        </div>
      </div>
    </div>
  );
}

function PaletteRow({
  item,
  query,
  index,
  active,
  onHover,
  onSelect,
}: {
  item: PaletteItem;
  query: string;
  index: number;
  active: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  const Icon = item.icon ?? KIND_ICON[item.kind];
  const thumb = thumbUrl(item.image, 64);
  return (
    <button
      type="button"
      data-secim={index}
      onMouseMove={onHover}
      onClick={onSelect}
      className={cn(
        "relative flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors",
        active ? "bg-primary/10" : "hover:bg-muted/50"
      )}
      style={{
        animation: "nav-slide-in 220ms ease forwards",
        animationDelay: `${Math.min(index, 8) * 18}ms`,
        opacity: 0,
        animationFillMode: "forwards",
      }}
    >
      {active && (
        <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-r-full bg-primary" />
      )}

      <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/70 bg-muted/50">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" className="max-h-full max-w-full object-contain" loading="lazy" />
        ) : item.dot ? (
          <span
            className="h-4 w-4 rounded-full border border-border/60"
            style={{ backgroundColor: item.dot }}
          />
        ) : item.platform ? (
          <PlatformLogo platform={item.platform} className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <Icon className="h-4 w-4 text-muted-foreground" strokeWidth={1.8} />
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">
          {highlightParts(item.title, query).map((part, i) =>
            part.hit ? (
              <mark key={i} className="rounded bg-primary/20 px-0.5 text-foreground">
                {part.text}
              </mark>
            ) : (
              <span key={i}>{part.text}</span>
            )
          )}
        </span>
        {item.subtitle && (
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {item.subtitle}
          </span>
        )}
      </span>

      {item.badge && (
        <span className="shrink-0 rounded-md border border-border/70 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {item.badge}
        </span>
      )}
    </button>
  );
}
