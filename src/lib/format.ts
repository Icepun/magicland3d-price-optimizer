/**
 * Sayı / para / tarih biçimlendirmesinin TEK kaynağı (tr-TR).
 *
 * NEDEN: kod tabanında beş ayrı para biçimlendiricisi vardı — Panel, Siparişler ve Raporlar
 * kendi `Intl.NumberFormat` örneklerini kuruyordu, bazıları 0 bazıları 2 ondalık gösteriyordu ve
 * yüzdeler `toFixed(1)` ile üretildiği için Türkçe'de olması gereken VİRGÜL yerine NOKTA çıkıyordu
 * (%12.5 ↔ %12,5). Aynı ekranda bile farklı biçimler görünüyordu.
 *
 * Intl örnekleri PAHALI: her satırda yeniden kurulursa uzun listelerde hissedilir. Bu yüzden
 * örnekler burada bir kez kurulup paylaşılıyor.
 */

const currencyCache = new Map<string, Intl.NumberFormat>();

function currencyFormatter(currency: string, decimals: 0 | 2): Intl.NumberFormat {
  const key = `${currency}:${decimals}`;
  let fmt = currencyCache.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat("tr-TR", {
      style: "currency",
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    currencyCache.set(key, fmt);
  }
  return fmt;
}

/** Bilinmeyen değer için ekranda gösterilen işaret. */
export const UNKNOWN_DASH = "—";

/**
 * Değer gerçekten bir sayı mı?
 *
 * ⚠️ BİLİNMEYEN ≠ SIFIR. Eksik/bozuk bir tutarı 0 göstermek, "maliyet eksik" kuralının
 * (productionCostKnown) tüm amacını biçimlendirme katmanında geri alır: kullanıcı hesaplanamamış
 * bir rakamı gerçek sıfır sanır. Bu yüzden null/undefined/NaN artık "—" olarak yazılır.
 * Gerçek 0 normal biçimlenir.
 */
function isNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Sayı olmayan girdileri 0'a indirger — YALNIZ sıfırın anlamlı olduğu yerlerde kullanılır. */
function safe(value: number | null | undefined): number {
  return isNumber(value) ? value : 0;
}

export interface CurrencyOptions {
  /** Ondalık basamak: 2 (varsayılan) veya 0 (özet kartları, grafik ekseni). */
  decimals?: 0 | 2;
  /** ISO para birimi kodu — varsayılan TRY. Desteklenmeyen kod gelirse TRY'ye düşer. */
  currency?: string;
}

export function formatCurrency(value: number | null | undefined, options: CurrencyOptions = {}): string {
  const { decimals = 2, currency = "TRY" } = options;
  if (!isNumber(value)) return UNKNOWN_DASH;
  try {
    return currencyFormatter(currency, decimals).format(safe(value));
  } catch {
    // Tanınmayan para birimi kodu → tutarı kaybetmektense TRY ile göster.
    return currencyFormatter("TRY", decimals).format(safe(value));
  }
}

/**
 * Dar alanlar için kısaltılmış tutar: ₺1,2m · ₺45b · ₺320.
 * Grafik ekseni ve özet kartlarında kullanılır; tam tutar gerektiğinde formatCurrency kullan.
 */
export function formatCompactCurrency(value: number | null | undefined, currency = "TRY"): string {
  const n = safe(value);
  const absolute = Math.abs(n);
  const symbol = currency === "TRY" ? "₺" : "";
  const sign = n < 0 ? "-" : "";
  if (absolute >= 1_000_000) {
    return `${sign}${symbol}${formatNumber(absolute / 1_000_000, 1)}m`;
  }
  if (absolute >= 1_000) {
    return `${sign}${symbol}${formatNumber(Math.round(absolute / 1_000), 0)}b`;
  }
  if (!symbol) return formatCurrency(n, { decimals: 0, currency });
  return `${sign}${symbol}${formatNumber(Math.round(absolute), 0)}`;
}

const numberCache = new Map<number, Intl.NumberFormat>();

export function formatNumber(value: number | null | undefined, decimals = 0): string {
  let fmt = numberCache.get(decimals);
  if (!fmt) {
    fmt = new Intl.NumberFormat("tr-TR", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    numberCache.set(decimals, fmt);
  }
  return fmt.format(safe(value));
}

/**
 * Oranı yüzde olarak yazar: 0.125 → "%12,5".
 * Türkçe'de yüzde işareti sayının ÖNÜNDE ve ondalık ayracı VİRGÜL.
 */
export function formatPercent(ratio: number | null | undefined, decimals = 1): string {
  if (!isNumber(ratio)) return UNKNOWN_DASH;
  return `%${formatNumber(ratio * 100, decimals)}`;
}

/** Zaten yüzde cinsinden gelen değer için (18 → "%18"). */
export function formatPercentValue(value: number | null | undefined, decimals = 0): string {
  return `%${formatNumber(value, decimals)}`;
}

const dateFmt = new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("tr-TR", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(value: string | number | Date | null | undefined, fallback = "—"): string {
  const d = toDate(value);
  return d ? dateFmt.format(d) : fallback;
}

export function formatDateTime(value: string | number | Date | null | undefined, fallback = "—"): string {
  const d = toDate(value);
  return d ? dateTimeFmt.format(d) : fallback;
}

/** "3 dakika önce" / "dün" gibi kısa bağıl zaman — tazelik göstergeleri için. */
export function formatRelativeTime(
  value: string | number | Date | null | undefined,
  now: number = Date.now()
): string {
  const d = toDate(value);
  if (!d) return "—";
  const diffSec = Math.round((now - d.getTime()) / 1000);
  if (diffSec < 45) return "az önce";
  const minutes = Math.round(diffSec / 60);
  if (minutes < 60) return `${minutes} dakika önce`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} saat önce`;
  const days = Math.round(hours / 24);
  if (days === 1) return "dün";
  if (days < 30) return `${days} gün önce`;
  return formatDate(d);
}
