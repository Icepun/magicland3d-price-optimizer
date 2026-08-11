/**
 * Sayı / para / tarih biçimlendirmesinin mobildeki TEK kaynağı (tr-TR).
 *
 * NEDEN: masaüstünde `src/lib/format.ts` aynı işi yapıyor; mobil kopya ise yüzdeyi
 * `toFixed(1)` ile üretiyordu → Türkçe'de VİRGÜL olması gereken ayraç NOKTA çıkıyordu
 * (%12.5 ↔ %12,5) ve iki cihaz aynı veriyi farklı yazıyordu. Kurallar artık birebir aynı:
 * ₺ önde, ondalık virgül, binlik nokta, yüzde işareti sayının önünde.
 *
 * Intl örnekleri PAHALI (özellikle Hermes'te ilk kurulum): uzun listelerde her satırda
 * yeniden kurulmasın diye örnekler burada bir kez kurulup paylaşılıyor.
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

/** Geçersiz/eksik sayıları 0 kabul et — ekranda "NaN ₺" ASLA görünmesin. */
function safe(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export interface CurrencyOptions {
  /** Ondalık basamak: 2 (varsayılan) veya 0 (özet kartları, grafik ekseni). */
  decimals?: 0 | 2;
  /** ISO para birimi kodu — varsayılan TRY. Desteklenmeyen kod gelirse TRY'ye düşer. */
  currency?: string;
}

export function formatCurrency(
  value: number | null | undefined,
  options: CurrencyOptions = {}
): string {
  const { decimals = 2, currency = "TRY" } = options;
  try {
    return currencyFormatter(currency, decimals).format(safe(value));
  } catch {
    // Tanınmayan para birimi kodu → tutarı kaybetmektense TRY ile göster.
    return currencyFormatter("TRY", decimals).format(safe(value));
  }
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
 * Dar alanlar için kısaltılmış tutar: ₺1,2m · ₺45b · ₺320.
 * Telefonda sütun genişlikleri masaüstünden çok daha dar; tam tutar sığmayan yerlerde bu kullanılır.
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

/**
 * Oranı yüzde olarak yazar: 0.125 → "%12,5".
 * Türkçe'de yüzde işareti sayının ÖNÜNDE ve ondalık ayracı VİRGÜL.
 */
export function formatPercent(ratio: number | null | undefined, decimals = 1): string {
  return `%${formatNumber(safe(ratio) * 100, decimals)}`;
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
const monthFmt = new Intl.DateTimeFormat("tr-TR", {
  month: "long",
  year: "numeric",
  timeZone: "Europe/Istanbul",
});

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(
  value: string | number | Date | null | undefined,
  fallback = "—"
): string {
  const d = toDate(value);
  return d ? dateFmt.format(d) : fallback;
}

export function formatDateTime(
  value: string | number | Date | null | undefined,
  fallback = "—"
): string {
  const d = toDate(value);
  return d ? dateTimeFmt.format(d) : fallback;
}

/** "Mart 2026" — aylık özet başlıkları için. */
export function formatMonthYear(
  value: string | number | Date | null | undefined,
  fallback = "—"
): string {
  const d = toDate(value);
  return d ? monthFmt.format(d) : fallback;
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

/**
 * Teknik hata metnini kullanıcıya gösterilebilir TEK SATIRA indirger.
 *
 * NEDEN: veri katmanı "Turso HTTP 503: …", "Turso SQL: no such column" gibi mesajlar fırlatıyor
 * ve bunlar ekrana ham basılıyordu. Kullanıcı bu metinle hiçbir şey yapamaz; sadece korkar.
 * Burada yalnızca kullanıcının EYLEME dönüştürebileceği birkaç durum ayrıştırılır, gerisi
 * tek genel cümleye düşer. Ayrıntı ekranda ASLA görünmez.
 */
export function friendlyError(
  error: unknown,
  fallback = "Bağlantı kurulamadı. İnternetini kontrol et."
): string {
  const raw = (error instanceof Error ? error.message : typeof error === "string" ? error : "")
    .trim()
    .toLowerCase();
  if (!raw) return fallback;
  if (raw.includes("zaman aşımı") || raw.includes("timeout") || raw.includes("abort")) {
    return "Sunucu yanıt vermedi. Birazdan tekrar dene.";
  }
  if (raw.includes("401") || raw.includes("403") || raw.includes("unauthorized")) {
    return "Giriş bilgileri geçersiz. Masaüstünden ayarları kontrol et.";
  }
  return fallback;
}
