import { monthPeriodLabel, monthProgress } from "@/app/reports/reports-view";

/**
 * Sipariş özetinin dönem etiketi — Raporlar'daki ile AYNI biçim ("1–23 Kasım").
 *
 * Panel, Siparişler ve Raporlar aynı dönemi (bu ay) gösterir; etiketler de aynı olsun ki
 * kullanıcı rakamları yan yana koyabilsin. `period` gelmeyen eski gövde (30 günlük özet)
 * null döner → çağıran eski başlığı gösterir.
 */
export function ozetDonemEtiketi(
  summary: { from?: string; period?: string } | null | undefined,
  nowMs: number,
  timeZone = "Europe/Istanbul"
): string | null {
  if (!summary || summary.period !== "month" || !summary.from || !nowMs) return null;
  const bas = Date.parse(summary.from);
  if (!Number.isFinite(bas)) return null;
  // Ayın 1'i 00:00 Türkiye = önceki günün 21:00 UTC'si → ay anahtarı bölge saatinden.
  const ay = new Date(bas).toLocaleString("sv-SE", { timeZone }).slice(0, 7);
  return monthPeriodLabel(ay, monthProgress(ay, nowMs, timeZone));
}
