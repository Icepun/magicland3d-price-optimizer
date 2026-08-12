"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
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
import { requestListState } from "@/lib/list-state";
import { usePrefersReducedMotion } from "@/lib/client-state";
import { Skeleton } from "@/components/ui/skeleton";
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
  /** Varyantı ayırt eden kısa parça ("Sarı") — başlık aynı kalır, çip sağda görünür. */
  variant?: string;
  /** Durum rozeti: "Gizli" / "Pasif". */
  tag?: string;
  /** Satıştan kaldırılmış kayıt: bulunur ama aktiflerin altında sıralanır. */
  muted?: boolean;
  /** Sonuç değil, eylem satırı (sıralamaya girmez). */
  action?: "tum-urunler";
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

/** İki taraf da sadeleştirilmişken puanı hesaplar (sıcak yol: her tuşta binlerce kez çağrılır). */
function scoreNormalized(haystack: string, needle: string): number {
  if (!needle) return 1;
  if (!haystack) return 0;
  if (haystack === needle) return 100;
  if (haystack.startsWith(needle)) return 80;
  const at = haystack.indexOf(needle);
  if (at < 0) return 0;
  return AYRAC.test(haystack[at - 1] ?? "") ? 60 : 40;
}

/**
 * Tek bir metin ile tek bir arama kelimesinin yakınlığı: 100 tam, 80 baştan,
 * 60 kelime başı, 40 içinde geçiyor, 0 eşleşme yok.
 */
export function scoreMatch(haystack: string, needle: string): number {
  return scoreNormalized(normalizeSearchText(haystack), normalizeSearchText(needle));
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
  const hays: string[] = [];
  for (const field of fields) {
    if (field) hays.push(normalizeSearchText(field));
  }
  return scoreTokens(hays, tokens);
}

function scoreTokens(hays: string[], tokens: string[]): number {
  if (tokens.length === 0) return 1;
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const hay of hays) {
      const score = scoreNormalized(hay, token);
      if (score > best) best = score;
    }
    if (best === 0) return 0;
    total += best;
  }
  return total / tokens.length;
}

/**
 * Kaydın aranabilir metinleri, sadeleştirilmiş halde saklanır.
 * Kayıt nesneleri yalnız veri değiştiğinde yeniden kurulduğu için her tuşta 400 ürünün
 * metnini baştan sadeleştirmek gereksiz; barkod okuyucunun hızına ancak böyle yetişilir.
 */
const HAYSTACK_CACHE = new WeakMap<PaletteItem, string[]>();

function itemHaystacks(item: PaletteItem): string[] {
  const cached = HAYSTACK_CACHE.get(item);
  if (cached) return cached;
  const fields = [item.title, item.subtitle, item.variant, ...(item.terms ?? [])];
  const hays: string[] = [];
  for (const field of fields) {
    if (field) hays.push(normalizeSearchText(field));
  }
  HAYSTACK_CACHE.set(item, hays);
  return hays;
}

const KIND_PRIORITY: Record<PaletteKind, number> = {
  sayfa: 3,
  urun: 2,
  siparis: 1,
  makara: 0,
};

export interface PaletteGroup {
  kind: PaletteKind;
  items: PaletteItem[];
  /** Kırpmadan ÖNCEKİ eşleşme sayısı — başlıkta "Ürünler · 130" olarak yazılır. */
  total: number;
}

export interface PaletteResults {
  groups: PaletteGroup[];
  /** Ekrandaki sırayla düz liste — klavye gezinmesi bunun üzerinden yürür. */
  flat: PaletteItem[];
}

/**
 * Eşleşenleri puanlar, gruplar ve kırpar.
 *
 * Sıralama kuralları (üstten alta):
 *   1. Satıştan kaldırılmış (gizli/pasif) kayıtlar en sona,
 *   2. eşleşme kalitesi (baştan > kelime başı > içinde),
 *   3. tür önceliği,
 *   4. daha kısa ad (uzun varyant adları kısa ana ürünü bastırmasın),
 *   5. alfabetik.
 *
 * Arama kutusu BOŞKEN yalnız sayfalar listelenir ve dizideki (kullanım) sırası korunur:
 * alfabetik sıralayıp kesmek en az kullanılan sayfaları öne çıkarıyordu.
 */
export function paletteResults(
  items: PaletteItem[],
  query: string,
  limit = 24,
  perKind = 6,
  emptyLimit = 8
): PaletteResults {
  const trimmed = query.trim();

  if (!trimmed) {
    const pages = items.filter((item) => item.kind === "sayfa").slice(0, emptyLimit);
    return {
      groups: pages.length
        ? [{ kind: "sayfa", items: pages, total: pages.length }]
        : [],
      flat: pages,
    };
  }

  const tokens = normalizeSearchText(trimmed).split(/\s+/).filter(Boolean);
  const scored: Array<{ item: PaletteItem; score: number }> = [];
  const totals = new Map<PaletteKind, number>();
  for (const item of items) {
    const score = scoreTokens(itemHaystacks(item), tokens);
    if (score <= 0) continue;
    scored.push({ item, score });
    totals.set(item.kind, (totals.get(item.kind) ?? 0) + 1);
  }

  scored.sort(
    (a, b) =>
      Number(Boolean(a.item.muted)) - Number(Boolean(b.item.muted)) ||
      b.score - a.score ||
      KIND_PRIORITY[b.item.kind] - KIND_PRIORITY[a.item.kind] ||
      a.item.title.length - b.item.title.length ||
      a.item.title.localeCompare(b.item.title, "tr")
  );

  const perKindCount = new Map<PaletteKind, number>();
  const cropped: PaletteItem[] = [];
  for (const { item } of scored) {
    const used = perKindCount.get(item.kind) ?? 0;
    if (used >= perKind) continue;
    perKindCount.set(item.kind, used + 1);
    cropped.push(item);
    if (cropped.length >= limit) break;
  }

  const groups = groupPaletteItems(cropped).map((group) => ({
    ...group,
    total: totals.get(group.kind) ?? group.items.length,
  }));
  return { groups, flat: groups.flatMap((group) => group.items) };
}

/** Geriye dönük kısa yol: yalnız kırpılmış düz liste. */
export function rankPaletteItems(
  items: PaletteItem[],
  query: string,
  limit = 24,
  perKind = 6
): PaletteItem[] {
  return paletteResults(items, query, limit, perKind).flat;
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

/**
 * Eşleşen bölümleri kalınlaştırmak için metni parçalara böler.
 * Aramanın TÜM kelimeleri işaretlenir ("mavi kutu" → iki kelime birden); çakışan
 * aralıklar birleştirilir.
 */
export function highlightParts(
  text: string,
  query: string
): Array<{ text: string; hit: boolean }> {
  const tokens = normalizeSearchText(query).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [{ text, hit: false }];
  const hay = normalizeSearchText(text);
  // Konum eşlemesi bozulduysa vurgulama yapma (yanlış harfi kalınlaştırmaktansa hiç yapma).
  if (hay.length !== text.length) return [{ text, hit: false }];

  const ranges: Array<[number, number]> = [];
  for (const token of tokens) {
    let from = 0;
    for (;;) {
      const at = hay.indexOf(token, from);
      if (at < 0) break;
      ranges.push([at, at + token.length]);
      from = at + token.length;
    }
  }
  if (ranges.length === 0) return [{ text, hit: false }];

  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  const parts: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) parts.push({ text: text.slice(cursor, start), hit: false });
    parts.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return parts;
}

/** Varyant adının başındaki/sonundaki ayraçları temizler ("- Sarı" → "Sarı"). */
function trimSeparators(value: string): string {
  return value.replace(/^[\s\-–—_/·,:|(]+/, "").replace(/[\s\-–—_/·,:|)]+$/, "");
}

/**
 * Varyant ürünlerinde başlık ile ayırt edici parçayı ayırır.
 *
 * Aynı grubun sekiz varyantı ilk 30 karakteri paylaştığı ve satır sondan kırpıldığı için
 * listede üst üste AYNI satır görünüyordu. Ortak grup adı başlıkta kalır, ayırt eden
 * parça ("Sarı") sağdaki çipe taşınır.
 */
export function splitVariantTitle(
  name: string,
  groupName?: string | null,
  variantLabel?: string | null
): { title: string; variant?: string } {
  const fullName = (name ?? "").trim();
  const label = variantLabel?.trim() ?? "";
  const group = groupName?.trim() ?? "";
  const hay = normalizeSearchText(fullName);
  // Sadeleştirme uzunluğu değiştirdiyse konumla kesmek metni bozar → dokunma.
  const safeToSlice = hay.length === fullName.length;

  if (group) {
    if (safeToSlice && hay.startsWith(normalizeSearchText(group))) {
      const rest = trimSeparators(fullName.slice(group.length));
      const variant = label || rest;
      return { title: group, variant: variant || undefined };
    }
    return { title: fullName, variant: label || undefined };
  }

  if (label) {
    const needle = normalizeSearchText(label);
    if (safeToSlice && hay.endsWith(needle) && fullName.length > label.length) {
      const head = trimSeparators(fullName.slice(0, fullName.length - label.length));
      if (head) return { title: head, variant: label };
    }
    return { title: fullName, variant: label };
  }

  return { title: fullName };
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
  variantLabel?: string | null;
  variantGroup?: { id: string; name: string } | null;
  isActive?: boolean;
  hidden?: boolean;
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
   SAYFA KAYITLARI — sıra = KULLANIM sıklığı (boş aramada ilk 8'i kısayol olur)
   ══════════════════════════════════════════════════════════════════════════ */

const HAZIRLIK_ID = "sayfa:hazirlik";
const TUM_URUNLER_ID = "eylem:tum-urunler";

const PAGE_ITEMS: PaletteItem[] = [
  { id: "sayfa:/", kind: "sayfa", title: "Panel", subtitle: "Günün özeti", href: "/", icon: LayoutDashboard, terms: ["ana sayfa", "gosterge", "ozet"] },
  { id: "sayfa:/products", kind: "sayfa", title: "Ürünler", subtitle: "Fiyat, stok ve maliyet", href: "/products", icon: Package, terms: ["urun listesi", "fiyat", "stok"] },
  { id: "sayfa:/orders", kind: "sayfa", title: "Siparişler", subtitle: "Tüm platformlardan gelen satışlar", href: "/orders", icon: ClipboardList, terms: ["satis", "musteri"] },
  { id: "sayfa:/reports", kind: "sayfa", title: "Raporlar", subtitle: "Ciro ve kâr grafikleri", href: "/reports", icon: BarChart3, terms: ["grafik", "aylik", "kazanc"] },
  { id: "sayfa:/printers", kind: "sayfa", title: "Yazıcılar", subtitle: "Baskı durumu ve kuyruk", href: "/printers", icon: Printer, terms: ["baski", "3d"] },
  { id: "sayfa:/planner", kind: "sayfa", title: "Üretim", subtitle: "Ne basılmalı planı", href: "/planner", icon: Factory, terms: ["plan", "uretim kuyrugu"] },
  { id: HAZIRLIK_ID, kind: "sayfa", title: "Hazırlık Listesi", subtitle: "Bugün gönderilecek ürünler, adetleriyle", href: "/orders", icon: PackageCheck, terms: ["paketleme", "toplama", "gonderilecek", "kargo hazirlik"] },
  { id: "sayfa:/spools", kind: "sayfa", title: "Filament", subtitle: "Makara stoğu ve renkler", href: "/spools", icon: Disc3, terms: ["makara", "renk", "gram"] },
  { id: "sayfa:/models", kind: "sayfa", title: "Modeller", subtitle: "Tasarım dosyaların", href: "/models", icon: Boxes, terms: ["tasarim", "dosya"] },
  { id: "sayfa:/cost-templates", kind: "sayfa", title: "Maliyet & Paketleme", subtitle: "Kutu, koli ve maliyet şablonları", href: "/cost-templates", icon: CalculatorIcon, terms: ["kutu", "koli", "sablon"] },
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
  const reducedMotion = usePrefersReducedMotion();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  // Klavyeyle gezerken farenin altında kalan satır da ışıklı görünüyordu → iki seçim.
  const [pointerNav, setPointerNav] = useState(true);
  const [moreBelow, setMoreBelow] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openPalette = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setClosing(false);
    setQuery("");
    setActiveIndex(0);
    setPointerNav(true);
    setOpen(true);
  }, []);

  // Kapanış animasyonu bitince gerçekten kaldır (hareket azaltma açıksa anında).
  const close = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (reducedMotion) {
      setClosing(false);
      setOpen(false);
      return;
    }
    setClosing(true);
    closeTimer.current = setTimeout(() => {
      setClosing(false);
      setOpen(false);
    }, 140);
  }, [reducedMotion]);

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  // Ctrl/Cmd + K her yerden açar-kapatır; kenar çubuğundaki düğme de aynı kapıyı kullanır.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open && !closing) close();
        else openPalette();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(PALETTE_OPEN_EVENT, openPalette);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(PALETTE_OPEN_EVENT, openPalette);
    };
  }, [open, closing, close, openPalette]);

  const trimmed = query.trim();

  // Aramanın TAMAMI bu tek listede yapılır: barkod ve stok kodu da geldiği için
  // tuş başına sunucuya gitmek gerekmiyor (13 haneli barkod eskiden ~8 sn sürüyordu).
  // Gizli/pasif ürünler de gelir; listede etiketlenir ve en alta sıralanır.
  const { data: products, isLoading: productsLoading } = useQuery<LiteProduct[]>({
    queryKey: ["products", "hizli-arama"],
    queryFn: () =>
      fetch("/api/products?filter=all&lite=1&includeHidden=1").then((response) =>
        response.json()
      ),
    enabled: open,
    staleTime: 5 * 60_000,
  });

  const { data: spools, isLoading: spoolsLoading } = useQuery<LiteSpool[]>({
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

  const loading = open && (productsLoading || spoolsLoading);

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [...PAGE_ITEMS];

    const seenProducts = new Set<string>();
    products?.forEach((product) => {
      if (!product?.id || seenProducts.has(product.id)) return;
      seenProducts.add(product.id);
      const { title, variant } = splitVariantTitle(
        product.name,
        product.variantGroup?.name,
        product.variantLabel
      );
      // Fiyatı girilmemiş ürün "₺0" ile bedava görünmesin: bilinmeyen tutar "—" yazılır.
      const price =
        typeof product.currentSalePrice === "number" && product.currentSalePrice > 0
          ? product.currentSalePrice
          : null;
      const tag = product.hidden
        ? "Gizli"
        : product.isActive === false
          ? "Pasif"
          : undefined;
      list.push({
        id: `urun:${product.id}`,
        kind: "urun",
        title,
        subtitle: product.alias ?? undefined,
        variant,
        tag,
        muted: Boolean(tag),
        // Tam ad da aranabilir kalsın: başlık grup adına indiğinde bile varyantın
        // tamamıyla eşleşme sürer.
        terms: [product.name, product.alias, product.barcode, product.sku].filter(
          (value): value is string => Boolean(value)
        ),
        href: `/products/${product.id}`,
        image: product.imageUrl ?? null,
        badge: formatCurrency(price, { decimals: 0 }),
      });
    });

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
  }, [products, ordersData, spools]);

  const results = useMemo(() => paletteResults(items, trimmed), [items, trimmed]);

  // Kırpılan sonuçlar sessizce kaybolmasın: altına "tümünü gör" satırı eklenir.
  const groups = useMemo(() => {
    if (!trimmed) return results.groups;
    return results.groups.map((group) => {
      if (group.kind !== "urun" || group.total <= group.items.length) return group;
      const showAll: PaletteItem = {
        id: TUM_URUNLER_ID,
        kind: "urun",
        action: "tum-urunler",
        title: "Tümünü Ürünler'de gör",
        badge: formatNumber(group.total),
        icon: ArrowRight,
      };
      return { ...group, items: [...group.items, showAll] };
    });
  }, [results, trimmed]);

  const flatItems = useMemo(
    () => groups.flatMap((group) => group.items),
    [groups]
  );

  // Her grubun düz listedeki başlangıç sırası — satırların klavye numarası buradan gelir.
  const groupOffsets = useMemo(() => {
    const offsets: number[] = [];
    let total = 0;
    for (const group of groups) {
      offsets.push(total);
      total += group.items.length;
    }
    return offsets;
  }, [groups]);

  // Sonuçlar kısalınca seçim listenin dışında kalmasın (veri sonradan gelebilir).
  const safeIndex = Math.min(activeIndex, Math.max(0, flatItems.length - 1));

  // Seçili satır her zaman görünür kalsın.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-secim="${safeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [safeIndex, flatItems.length]);

  // Aşağıda devamı var mı? (alt kenardaki solma bunun için)
  const syncFade = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 8);
  }, []);

  useEffect(() => {
    if (!open) return;
    syncFade();
  }, [syncFade, flatItems.length, loading, open]);

  const run = useCallback(
    (item: PaletteItem | undefined) => {
      if (!item) return;
      close();
      if (item.action === "tum-urunler") {
        // Arama Ürünler sayfasına taşınır; sayfa açılırken oturumdaki aramayı geri yükler.
        // Kaydırma sıfırlanır: yeni aramanın ilk satırı ekranda olsun.
        // Duyuran sürüm: kullanıcı ZATEN Ürünler sayfasındaysa da arama uygulanır.
        requestListState("products", {
          search: query.trim(),
          filterMode: "all",
          scrollTop: 0,
        });
        router.push("/products");
        return;
      }
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
    [close, query, router]
  );

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (closing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setPointerNav(false);
      setActiveIndex(
        moveActiveIndex(safeIndex, event.key === "ArrowDown" ? 1 : -1, flatItems.length)
      );
      return;
    }
    // Home/End metin imlecini oynatır — liste değil (kutuya dokunmadan geçiyoruz).
    if (event.key === "Enter") {
      event.preventDefault();
      const typed = inputRef.current?.value ?? query;
      if (typed.trim() !== trimmed) {
        // Barkod okuyucu tuşları çok hızlı basar: liste yazılanı henüz göstermiyorsa
        // ESKİ sonucu açmak yanlış ürüne gitmek demek → yazılanın sonucuna gidilir.
        setQuery(typed);
        setActiveIndex(0);
        run(paletteResults(items, typed).flat[0]);
        return;
      }
      run(flatItems[safeIndex]);
    }
  };

  const onListMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!pointerNav) setPointerNav(true);
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-secim]");
    if (!row) return;
    const index = Number(row.dataset.secim);
    if (Number.isFinite(index) && index !== activeIndex) setActiveIndex(index);
  };

  if (!open) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-[120] flex justify-center bg-background/70 px-4 pt-[10vh] backdrop-blur-sm",
        closing
          ? "animate-out fade-out duration-150 fill-mode-forwards"
          : "animate-in fade-in duration-150"
      )}
      onMouseDown={close}
      role="presentation"
    >
      <div
        className={cn(
          "flex max-h-[72vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl",
          closing
            ? "animate-out fade-out zoom-out-95 slide-out-to-top-2 duration-150 fill-mode-forwards"
            : "animate-in fade-in zoom-in-95 slide-in-from-top-2 duration-200"
        )}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onPanelKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="Arama"
      >
        {/* Arama kutusu */}
        <div className="flex items-center gap-2.5 px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            // Kutu açılır açılmaz yazmaya başlanabilsin.
            autoFocus
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            placeholder="Ürün, barkod, sipariş ya da sayfa ara…"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Arama"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="shrink-0 rounded border border-border/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            Esc
          </kbd>
        </div>

        {/* İnce yükleniyor çizgisi — yerini kaplar, liste zıplamaz */}
        <div className="relative h-px w-full overflow-hidden bg-border/70">
          {loading && (
            <span
              className="absolute inset-y-0 w-1/3 bg-primary"
              style={{ animation: "indeterminate-bar 1.1s ease-in-out infinite" }}
              aria-hidden="true"
            />
          )}
        </div>

        {/* Sonuçlar */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={listRef}
            onScroll={syncFade}
            onMouseMove={onListMouseMove}
            role="listbox"
            aria-label="Sonuçlar"
            aria-busy={loading}
            className="h-full overflow-y-auto p-2"
          >
            {flatItems.length === 0 && loading ? (
              <SkeletonRows count={5} />
            ) : flatItems.length === 0 ? (
              <div className="px-3 py-10 text-center animate-in fade-in duration-300">
                <Search
                  className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40"
                  strokeWidth={1.4}
                />
                <p className="text-sm font-medium">Sonuç bulunamadı</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Ürün adı, barkod, sipariş numarası ya da makara adı deneyebilirsin.
                </p>
              </div>
            ) : (
              <>
                {groups.map((group, groupIndex) => (
                  <div
                    key={group.kind}
                    role="group"
                    aria-label={KIND_LABEL[group.kind]}
                    className="mb-1.5 last:mb-0"
                  >
                    <p className="flex items-center gap-1 px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                      {KIND_LABEL[group.kind]}
                      {trimmed && (
                        <span className="font-normal tracking-normal text-muted-foreground/60">
                          · {formatNumber(group.total)}
                        </span>
                      )}
                    </p>
                    {group.items.map((item, itemIndex) => {
                      const index = (groupOffsets[groupIndex] ?? 0) + itemIndex;
                      return (
                        <PaletteRow
                          key={item.id}
                          item={item}
                          query={trimmed}
                          index={index}
                          active={index === safeIndex}
                          pointerNav={pointerNav}
                          onSelect={() => run(item)}
                        />
                      );
                    })}
                  </div>
                ))}
                {loading && <SkeletonRows count={3} />}
              </>
            )}
          </div>

          {/* Aşağıda devamı olduğunu belli eden solma */}
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card via-card/75 to-transparent transition-opacity duration-200",
              moreBelow ? "opacity-100" : "opacity-0"
            )}
            aria-hidden="true"
          />
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

/** Liste gelene kadar boş ekran değil, satır iskeletleri görünür. */
function SkeletonRows({ count }: { count: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className="flex items-center gap-2.5 rounded-lg px-2 py-2"
          style={{
            animation: `nav-slide-in 220ms ease ${index * 45}ms both`,
          }}
        >
          <Skeleton className="h-8 w-8 shrink-0 rounded-md" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton
              className="h-2.5 rounded"
              style={{ width: `${68 - index * 9}%` }}
            />
            <Skeleton className="h-2 w-1/4 rounded" />
          </div>
          <Skeleton className="h-4 w-10 shrink-0 rounded-md" />
        </div>
      ))}
    </div>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, index) =>
        part.hit ? (
          <mark key={index} className="rounded bg-primary/20 px-0.5 text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        )
      )}
    </>
  );
}

function PaletteRow({
  item,
  query,
  index,
  active,
  pointerNav,
  onSelect,
}: {
  item: PaletteItem;
  query: string;
  index: number;
  active: boolean;
  pointerNav: boolean;
  onSelect: () => void;
}) {
  const Icon = item.icon ?? KIND_ICON[item.kind];
  const thumb = thumbUrl(item.image, 64);
  // Giriş animasyonu satır başına BİR kez oynasın: gecikmeyi her render'da sıraya
  // bağlarsak stil değişir, animasyon baştan başlar ve liste her tuşta yanıp söner.
  const [enterDelay] = useState(() => Math.min(index, 8) * 18);
  const isAction = item.action != null;

  return (
    <button
      type="button"
      data-secim={index}
      role="option"
      aria-selected={active}
      onClick={onSelect}
      className={cn(
        "relative flex w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors",
        isAction ? "py-1.5" : "py-2",
        item.muted && !active && "opacity-75",
        active ? "bg-primary/10" : pointerNav && "hover:bg-muted/50"
      )}
      style={{ animation: `nav-slide-in 220ms ease ${enterDelay}ms both` }}
    >
      {active && (
        <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-r-full bg-primary" />
      )}

      <span
        className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden",
          isAction
            ? "h-8 w-8 text-muted-foreground"
            : "h-8 w-8 rounded-md border border-border/70 bg-muted/50"
        )}
      >
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumb}
            alt=""
            className="max-h-full max-w-full object-contain"
            loading="lazy"
          />
        ) : item.dot ? (
          <span
            className="h-4 w-4 rounded-full border border-border/60"
            style={{ backgroundColor: item.dot }}
          />
        ) : item.platform ? (
          <PlatformLogo
            platform={item.platform}
            className="h-3.5 w-3.5 text-muted-foreground"
          />
        ) : (
          <Icon className="h-4 w-4 text-muted-foreground" strokeWidth={1.8} />
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-sm",
            isAction && "text-[13px] text-muted-foreground"
          )}
        >
          {isAction ? item.title : <Highlighted text={item.title} query={query} />}
        </span>
        {item.subtitle && (
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {item.subtitle}
          </span>
        )}
      </span>

      <span className="flex shrink-0 items-center gap-1.5">
        {item.variant && (
          <span className="max-w-[7.5rem] truncate rounded-full border border-border/70 bg-muted/40 px-1.5 py-0.5 text-[10px] text-foreground/80">
            <Highlighted text={item.variant} query={query} />
          </span>
        )}
        {item.tag && (
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {item.tag}
          </span>
        )}
        {item.badge && (
          <span className="rounded-md border border-border/70 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
            {item.badge}
          </span>
        )}
      </span>
    </button>
  );
}
