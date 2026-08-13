/**
 * FİLAMENT ENVANTERİ — kapalı makara gruplama ve uyarı mantığı (masaüstü + telefon ORTAK).
 *
 * Amaç kullanım oranı ölçmek DEĞİL: "hangi türden/renkten kaç KAPALI makaram var" ve
 * "azalınca uyar". Bu yüzden envanterin birimi tek tek makara değil, GRUP:
 *
 *     grup = tür ailesi + renk tonu        (marka gruba GİRMEZ)
 *
 * Kullanıcı kararları (2026-07-28):
 *  - PLA ailesi TEK grup: "PLA+", "PLA-CF", "Silk PLA" hepsi PLA sayılır (PETG-CF → PETG vb.).
 *  - Renk TONLARI AYRI grup: "fıstık yeşili" ile "koyu yeşil" ayrı kart. Ama ikisi de `colorFamily`
 *    = "yesil" taşır → arayüz bunları "Yeşil" başlığı altında toplayıp "toplam kaç yeşil" sorusunu
 *    da cevaplayabilir. Yani gruplama hassas, gösterim toplu.
 *  - Eşik: tek GENEL sayı (varsayılan 2) + istenirse renk/grup bazlı istisna.
 *
 * Bu dosya SAF'tır (DB/IO/tarih-üretimi yok) ve `npm run sync-core` ile telefona kopyalanır;
 * `npm run check-core` masaüstü ile telefon arasındaki farkı CI'da durdurur → uyarı metinleri ve
 * sayılar iki cihazda birebir aynı olur.
 */

// ─────────────────────────── Sabitler ───────────────────────────

/** Ekleme formundaki hazır marka listesi. "Diğer…" seçilirse kullanıcı elle yazar (serbest metin). */
export const FILAMENT_BRANDS = ["Polyture", "Porima", "Beta", "Esun"] as const;

/** Bir grubun kapalı makara sayısı bu değere veya altına inince uyarı çıkar. */
export const DEFAULT_LOW_SPOOL_COUNT = 2;

/**
 * Kapalı (açılmamış) sayılma toleransı, gram. `openedAt` alanı telefonun ESKİ sürümünde ve eski
 * kayıtlarda hiç yazılmadığı için "kalan ≈ toplam" ikinci bir kanıt olarak kullanılır; böylece
 * toplu veri dönüştürme (backfill) gerekmeden eski kayıtlar da doğru sayılır.
 */
export const SEALED_TOLERANCE_GRAMS = 1;

/** Tür aileleri — UZUN olan ÖNCE gelmeli (PETG, PET'ten önce eşleşsin). */
const MATERIAL_FAMILIES = [
  "PETG", "PLA", "ABS", "ASA", "TPU", "TPE", "PVA", "HIPS", "PACF", "PA", "PC", "PP", "PET", "RESIN",
] as const;

export interface FilamentColorDef {
  /** Kalıcı anahtar (slug). Gruplamanın çapası. */
  key: string;
  /** Görünen ad. */
  name: string;
  /** Varsayılan renk kodu. */
  hex: string;
  /** Üst renk ailesi — arayüzde başlık/toplama için (tonlar ayrı grup kalır). */
  family: string;
}

/**
 * Hazır renk paleti. Ekleme formunda TEK TIKLA seçilir ve seçim hem renk ADINI hem renk KODUNU
 * birlikte yazar — kullanıcının "hem isim hem renk giriyoruz" karışıklığı böyle ortadan kalkar.
 * Tonlar ayrı anahtar taşır (koyu-yesil ≠ fistik-yesili) ama aynı `family` altında toplanır.
 */
export const FILAMENT_COLORS: FilamentColorDef[] = [
  { key: "siyah", name: "Siyah", hex: "#111827", family: "siyah" },
  { key: "beyaz", name: "Beyaz", hex: "#f9fafb", family: "beyaz" },
  { key: "gri", name: "Gri", hex: "#9ca3af", family: "gri" },
  { key: "koyu-gri", name: "Koyu Gri", hex: "#4b5563", family: "gri" },
  { key: "gumus", name: "Gümüş", hex: "#c0c5ce", family: "gri" },
  { key: "kirmizi", name: "Kırmızı", hex: "#dc2626", family: "kirmizi" },
  { key: "bordo", name: "Bordo", hex: "#7f1d1d", family: "kirmizi" },
  { key: "turuncu", name: "Turuncu", hex: "#f97316", family: "turuncu" },
  { key: "sari", name: "Sarı", hex: "#facc15", family: "sari" },
  { key: "altin", name: "Altın", hex: "#d4af37", family: "sari" },
  { key: "yesil", name: "Yeşil", hex: "#16a34a", family: "yesil" },
  { key: "koyu-yesil", name: "Koyu Yeşil", hex: "#14532d", family: "yesil" },
  { key: "fistik-yesili", name: "Fıstık Yeşili", hex: "#84cc16", family: "yesil" },
  { key: "mavi", name: "Mavi", hex: "#2563eb", family: "mavi" },
  { key: "acik-mavi", name: "Açık Mavi", hex: "#38bdf8", family: "mavi" },
  { key: "lacivert", name: "Lacivert", hex: "#1e3a8a", family: "mavi" },
  { key: "turkuaz", name: "Turkuaz", hex: "#06b6d4", family: "mavi" },
  { key: "mor", name: "Mor", hex: "#7c3aed", family: "mor" },
  { key: "lila", name: "Lila", hex: "#c4b5fd", family: "mor" },
  { key: "pembe", name: "Pembe", hex: "#ec4899", family: "pembe" },
  { key: "kahverengi", name: "Kahverengi", hex: "#78350f", family: "kahverengi" },
  { key: "bej", name: "Bej", hex: "#e7d7c1", family: "kahverengi" },
  { key: "seffaf", name: "Şeffaf", hex: "#e5e7eb", family: "seffaf" },
  { key: "fosforlu-yesil", name: "Fosforlu Yeşil", hex: "#39ff14", family: "yesil" },
];

/** Renk ailesi tespiti için anahtar kelimeler (slug halinde aranır). UZUN olan ÖNCE. */
const COLOR_FAMILY_KEYWORDS: Array<[string, string]> = [
  ["kahverengi", "kahverengi"], ["kahve", "kahverengi"], ["bej", "kahverengi"], ["krem", "kahverengi"],
  ["lacivert", "mavi"], ["turkuaz", "mavi"], ["mavi", "mavi"], ["petrol", "mavi"],
  ["fistik", "yesil"], ["yesil", "yesil"], ["haki", "yesil"], ["mint", "yesil"],
  ["bordo", "kirmizi"], ["kirmizi", "kirmizi"], ["kizil", "kirmizi"],
  ["turuncu", "turuncu"],
  ["altin", "sari"], ["sari", "sari"], ["hardal", "sari"],
  ["lila", "mor"], ["eflatun", "mor"], ["mor", "mor"], ["menekse", "mor"],
  ["pembe", "pembe"], ["fusya", "pembe"],
  ["gumus", "gri"], ["gri", "gri"], ["antrasit", "gri"],
  ["siyah", "siyah"],
  ["beyaz", "beyaz"],
  ["seffaf", "seffaf"], ["transparan", "seffaf"], ["natural", "seffaf"],
];

// ─────────────────────────── Metin yardımcıları ───────────────────────────

/**
 * Türkçe duyarlı slug. `toLowerCase()`'e GÜVENİLMEZ: Node ile telefonun JS motoru "İ"/"I" için
 * farklı davranabilir ve AYNI renk iki ayrı gruba bölünür (envanter sessizce yanlış sayar).
 * Bu yüzden dönüşüm açık bir karakter haritasıyla yapılır.
 */
export function slugifyTr(input: string): string {
  const map: Record<string, string> = {
    ç: "c", Ç: "c", ğ: "g", Ğ: "g", ı: "i", I: "i", İ: "i", i: "i",
    ö: "o", Ö: "o", ş: "s", Ş: "s", ü: "u", Ü: "u",
  };
  let out = "";
  for (const ch of String(input ?? "")) {
    const mapped = map[ch];
    if (mapped !== undefined) { out += mapped; continue; }
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) { out += String.fromCharCode(code + 32); continue; } // A-Z → a-z
    if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) { out += ch; continue; } // a-z 0-9
    out += "-";
  }
  return out.replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** Slug'ı okunur başlığa çevir ("koyu-yesil" → "Koyu Yesil"). Palet dışı renkler için yedek ad. */
export function titleFromKey(key: string): string {
  return String(key ?? "")
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ─────────────────────────── Tür (material) ───────────────────────────

/**
 * Tür ailesi: "PLA+" / "pla plus" / "Silk PLA" / "PLA-CF" → "PLA".
 * Kullanıcı kararı gereği alt türler AYRI GRUP OLUŞTURMAZ.
 * Tanınmayan tür kendi adıyla (büyük harfe çevrilmiş) döner — veri kaybolmaz.
 */
export function materialFamily(material: string | null | undefined): string {
  const slug = slugifyTr(material ?? "").replace(/-/g, "");
  if (!slug) return "PLA";
  for (const fam of MATERIAL_FAMILIES) {
    if (slug.includes(fam.toLowerCase())) return fam;
  }
  return String(material ?? "").trim().toUpperCase() || "PLA";
}

// ─────────────────────────── Renk ───────────────────────────

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const s = /^#?([0-9a-f]{3})$/i.exec(String(hex ?? "").trim());
  if (s) {
    const [r, g, b] = s[1].split("");
    return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)];
  }
  return null;
}

/** Renk koduna en yakın palet rengi (renk adı hiç girilmemiş eski kayıtlar için). */
export function nearestColor(hex: string | null | undefined): FilamentColorDef {
  const rgb = hexToRgb(hex ?? "");
  const fallback = FILAMENT_COLORS.find((c) => c.key === "gri") as FilamentColorDef;
  if (!rgb) return fallback;
  let best = fallback;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of FILAMENT_COLORS) {
    const crgb = hexToRgb(c.hex);
    if (!crgb) continue;
    const d =
      (rgb[0] - crgb[0]) * (rgb[0] - crgb[0]) +
      (rgb[1] - crgb[1]) * (rgb[1] - crgb[1]) +
      (rgb[2] - crgb[2]) * (rgb[2] - crgb[2]);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  return best;
}

/** Renk tonundan üst aile ("fistik-yesili" → "yesil"). Arayüzde başlık/toplama için. */
export function colorFamilyOf(colorKey: string, colorHex?: string | null): string {
  const known = FILAMENT_COLORS.find((c) => c.key === colorKey);
  if (known) return known.family;
  const slug = slugifyTr(colorKey);
  for (const [needle, family] of COLOR_FAMILY_KEYWORDS) {
    if (slug.includes(needle)) return family;
  }
  if (colorHex) return nearestColor(colorHex).family;
  return "diger";
}

// ─────────────────────────── Makara → grup ───────────────────────────

/** Gruplama için gereken en küçük makara şekli (hem Prisma hem telefon satırı uyar). */
export interface SpoolLike {
  id: string;
  name?: string | null;
  material: string;
  colorName?: string | null;
  colorHex?: string | null;
  brand?: string | null;
  totalGrams: number;
  remainingGrams: number;
  /** Normalize renk anahtarı (v37 kolonu). Boşsa colorName/colorHex'ten türetilir. */
  colorKey?: string | null;
  /** Makara ne zaman açıldı. Boş = KAPALI. (v37 kolonu; eski kayıtlarda yok.) */
  openedAt?: Date | string | null;
}

/**
 * Makaranın renk anahtarı. Öncelik: kayıtlı colorKey → renk adı slug'ı → renk koduna en yakın palet.
 * TON KORUNUR (koyu yeşil, yeşile indirgenmez) — kullanıcı kararı.
 */
export function spoolColorKey(spool: SpoolLike): string {
  const stored = slugifyTr(spool.colorKey ?? "");
  if (stored) return stored;
  const fromName = slugifyTr(spool.colorName ?? "");
  if (fromName) return fromName;
  return nearestColor(spool.colorHex).key;
}

/** Grup anahtarı: "PLA__koyu-yesil". Marka GİRMEZ (farklı markalar aynı kartta toplanır). */
export function spoolGroupKey(spool: SpoolLike): string {
  return `${materialFamily(spool.material)}__${spoolColorKey(spool)}`;
}

/** Anahtardan tür + renk ayrıştır (izlenen gruplar canlı satırsız kaldığında gerekir). */
export function parseGroupKey(key: string): { material: string; colorKey: string } {
  const idx = String(key ?? "").indexOf("__");
  if (idx < 0) return { material: String(key ?? ""), colorKey: "" };
  return { material: key.slice(0, idx), colorKey: key.slice(idx + 2) };
}

/**
 * KAPALI (açılmamış) makara mı?
 *
 * İKİ koşul bilinçli: `openedAt`'i telefonun eski sürümü hiç yazmıyor ve eski kayıtlarda yok;
 * ikinci koşul (kalan ≈ toplam) bu boşluğu kapatır → hiçbir toplu veri dönüştürme gerekmez ve
 * sahadaki eski telefon sürümü doğru saymaya devam eder.
 */
export function isSealed(spool: SpoolLike): boolean {
  if (spool.openedAt) return false;
  const total = Number(spool.totalGrams) || 0;
  const remaining = Number(spool.remainingGrams) || 0;
  if (total <= 0) return false;
  return remaining >= total - SEALED_TOLERANCE_GRAMS;
}

/** Makara bitmiş mi (kalan yok)? Bitmiş makara ne kapalı ne açık sayılır. */
export function isEmptySpool(spool: SpoolLike): boolean {
  return (Number(spool.remainingGrams) || 0) <= 0;
}

export interface FilamentGroup {
  /** "PLA__koyu-yesil" */
  key: string;
  /** Tür ailesi: PLA, PETG… */
  material: string;
  /** Renk tonu anahtarı */
  colorKey: string;
  /** Görünen renk adı */
  colorName: string;
  /** Görünen renk kodu */
  colorHex: string;
  /** Üst renk ailesi (arayüz başlığı: "Yeşil") */
  colorFamily: string;
  /** Kart başlığı: "Koyu Yeşil PLA" */
  label: string;
  sealedCount: number;
  openCount: number;
  emptyCount: number;
  /** Bitmişler hariç eldeki makara sayısı (kapalı + açık) */
  activeCount: number;
  remainingGrams: number;
  totalGrams: number;
  /** Gruptaki markalar (tekil, alfabetik) */
  brands: string[];
  spools: SpoolLike[];
}

/**
 * Makaraları gruplara böl. Sıralama: önce KAPALI SAYISI AZ olan (kullanıcının önce görmesi gereken),
 * eşitse ada göre — böylece "neyim bitiyor" listenin başında olur.
 */
export function groupSpools(spools: SpoolLike[]): FilamentGroup[] {
  const map = new Map<string, FilamentGroup>();

  for (const s of spools ?? []) {
    const key = spoolGroupKey(s);
    const colorKey = spoolColorKey(s);
    let g = map.get(key);
    if (!g) {
      const known = FILAMENT_COLORS.find((c) => c.key === colorKey);
      const material = materialFamily(s.material);
      const colorName = (s.colorName ?? "").trim() || known?.name || titleFromKey(colorKey);
      g = {
        key,
        material,
        colorKey,
        colorName,
        colorHex: (s.colorHex ?? "").trim() || known?.hex || "#9ca3af",
        colorFamily: colorFamilyOf(colorKey, s.colorHex),
        label: `${colorName} ${material}`,
        sealedCount: 0, openCount: 0, emptyCount: 0, activeCount: 0,
        remainingGrams: 0, totalGrams: 0,
        brands: [], spools: [],
      };
      map.set(key, g);
    }

    g.spools.push(s);
    g.remainingGrams += Number(s.remainingGrams) || 0;
    g.totalGrams += Number(s.totalGrams) || 0;
    if (isEmptySpool(s)) g.emptyCount += 1;
    else if (isSealed(s)) g.sealedCount += 1;
    else g.openCount += 1;

    const brand = (s.brand ?? "").trim();
    if (brand && !g.brands.includes(brand)) g.brands.push(brand);
  }

  const groups = Array.from(map.values());
  for (const g of groups) {
    g.activeCount = g.sealedCount + g.openCount;
    g.brands.sort((a, b) => a.localeCompare(b, "tr"));
  }
  groups.sort((a, b) => a.sealedCount - b.sealedCount || a.label.localeCompare(b.label, "tr"));
  return groups;
}

// ─────────────────────────── Uyarılar ───────────────────────────

export type FilamentAlertLevel = "critical" | "warning";

export interface FilamentAlert {
  /** "filament-PLA__siyah" — grup bazlı, makara bazlı DEĞİL. */
  id: string;
  type: "filament";
  severity: FilamentAlertLevel;
  title: string;
  body: string;
  href: string;
  groupKey: string;
}

/**
 * Uyarı için izlenen grup. Canlı makara satırı KALMASA BİLE uyarı üretilebilsin diye ayrı tutulur:
 * son makara silinince grup yok oluyordu ve tam da istenen "siyah bitti" uyarısı HİÇ çıkmıyordu.
 */
export interface WatchedGroup {
  key: string;
  /** Görünen ad ("Siyah PLA"). Boşsa anahtardan türetilir. */
  label?: string;
}

export interface FilamentAlertOptions {
  /** Genel eşik (varsayılan 2). */
  threshold?: number;
  /** Grup bazlı istisna: { "PLA__siyah": 3 } */
  groupThresholds?: Record<string, number>;
  /** Kalıcı izlenen grup listesi (satırı kalmayanlar için). */
  watchedGroups?: WatchedGroup[];
  /** Susturulan gruplar (veri silmeden uyarıyı kapat). */
  mutedGroups?: string[];
}

function thresholdFor(groupKey: string, opts: FilamentAlertOptions): number {
  // Renge özel eşikler de en az 1'dir; gerekçe `parseThreshold` üstünde.
  const per = opts.groupThresholds?.[groupKey];
  if (typeof per === "number" && isFinite(per) && per >= 0) return Math.max(MIN_LOW_SPOOL_COUNT, per);
  const general = opts.threshold;
  if (typeof general === "number" && isFinite(general) && general >= 0)
    return Math.max(MIN_LOW_SPOOL_COUNT, general);
  return DEFAULT_LOW_SPOOL_COUNT;
}

/**
 * Grup bazlı uyarılar. ÜÇ KADEME (tek kademe yanlış alarm üretiyordu — yazıcıda 900 g dolu makara
 * varken "bitti" diyordu):
 *   kapalı 0 + açık 0        → KIRMIZI "Filament bitti"
 *   kapalı 0 + açık var      → SARI    "Son makara açık"
 *   0 < kapalı ≤ eşik        → SARI    "Filament azaldı"
 * Açık makaranın KALAN GRAMI uyarıya girmez (sadece kartta bilgi olarak görünür).
 */
export function buildFilamentAlerts(
  groups: FilamentGroup[],
  opts: FilamentAlertOptions = {}
): FilamentAlert[] {
  const muted = new Set(opts.mutedGroups ?? []);
  const alerts: FilamentAlert[] = [];
  const seen = new Set<string>();

  const push = (key: string, label: string, sealed: number, open: number) => {
    if (muted.has(key) || seen.has(key)) return;
    const limit = thresholdFor(key, opts);
    let severity: FilamentAlertLevel;
    let title: string;
    let body: string;

    if (sealed === 0 && open === 0) {
      severity = "critical";
      title = "Filament bitti";
      body = `${label} — hiç makara kalmadı`;
    } else if (sealed === 0) {
      severity = "warning";
      title = "Son makara açık";
      body = `${label} — sadece açık makara kaldı`;
    } else if (sealed <= limit) {
      severity = "warning";
      title = "Filament azaldı";
      body = `${label} — ${sealed} kapalı makara kaldı`;
    } else {
      return; // yeterli stok
    }

    seen.add(key);
    alerts.push({
      id: `filament-${key}`,
      type: "filament",
      severity,
      title,
      body,
      href: `/spools?g=${encodeURIComponent(key)}`,
      groupKey: key,
    });
  };

  for (const g of groups ?? []) push(g.key, g.label, g.sealedCount, g.openCount);

  // Canlı satırı kalmayan izlenen gruplar → "bitti" uyarısı (asıl istenen davranış).
  const live = new Set((groups ?? []).map((g) => g.key));
  for (const w of opts.watchedGroups ?? []) {
    if (!w || !w.key || live.has(w.key)) continue;
    const parsed = parseGroupKey(w.key);
    const known = FILAMENT_COLORS.find((c) => c.key === parsed.colorKey);
    const label =
      (w.label ?? "").trim() ||
      `${known?.name || titleFromKey(parsed.colorKey)} ${parsed.material}`.trim();
    push(w.key, label, 0, 0);
  }

  // Kırmızılar önce, sonra ada göre — zil ve sayfa aynı sırayı gösterir.
  alerts.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
    return a.body.localeCompare(b.body, "tr");
  });
  return alerts;
}

// ─────────────────────────── Ayar ayrıştırma ───────────────────────────

/**
 * AppSetting metninden güvenli eşik. BOŞ değer varsayılana düşer — `Number("")` 0 döndüğü için
 * naif bir dönüşüm eşiği sessizce 0 yapar ve "azaldı" uyarıları hiç çıkmazdı (testle yakalandı).
 *
 * EN DÜŞÜK EŞİK 1'dir. Eşik 0 iken "azaldı" diye bir durum kalmaz: bir renk ya vardır ya
 * bitmiştir. Kullanıcı bunu bilerek yapıyordu — yalnız bitenleri görmek için eşiği 0'a
 * çekiyordu — ama bunun bedeli, son makaraya düştüğünde hiç uyarı almamaktı. Artık "yalnız
 * bitenler" filtreyle seçiliyor, eşik de asıl işine döndü. Kayıtlı 0 değerleri sessizce 1
 * sayılır; kimsenin ayarı elle düzeltmesi gerekmez.
 */
export const MIN_LOW_SPOOL_COUNT = 1;

export function parseThreshold(raw: string | null | undefined, fallback = DEFAULT_LOW_SPOOL_COUNT): number {
  const text = String(raw ?? "").trim();
  if (!text) return fallback;
  const n = Number(text);
  return isFinite(n) && n >= 0 ? Math.max(MIN_LOW_SPOOL_COUNT, Math.floor(n)) : fallback;
}

/** AppSetting JSON dizisi → string[] (bozuksa boş dizi; uyarı sistemi çökmez). */
export function parseKeyList(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** AppSetting JSON → izlenen gruplar. Hem ["PLA__siyah"] hem [{key,label}] biçimini kabul eder. */
export function parseWatchedGroups(raw: string | null | undefined): WatchedGroup[] {
  try {
    const v = JSON.parse(String(raw ?? "[]"));
    if (!Array.isArray(v)) return [];
    const out: WatchedGroup[] = [];
    for (const item of v) {
      if (typeof item === "string" && item) out.push({ key: item });
      else if (item && typeof item === "object" && typeof (item as WatchedGroup).key === "string") {
        out.push({ key: (item as WatchedGroup).key, label: (item as WatchedGroup).label });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** AppSetting JSON → grup bazlı eşik haritası (bozuk/negatif değerler atlanır). */
export function parseGroupThresholds(raw: string | null | undefined): Record<string, number> {
  try {
    const v = JSON.parse(String(raw ?? "{}"));
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const n = Number(val);
      if (isFinite(n) && n >= 0) out[k] = Math.floor(n);
    }
    return out;
  } catch {
    return {};
  }
}
