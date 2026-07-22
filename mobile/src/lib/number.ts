/**
 * Mobil sayısal giriş ayrıştırıcısı.
 *
 * Türkçe klavyeler `decimal-pad` üzerinde ondalık ayıracı olarak virgül üretir;
 * JavaScript `Number`/`parseFloat` ise nokta bekler. Boş veya bütünüyle geçersiz
 * girişleri 0'a çevirmek yerine `null` döndürerek formun veri yazmasını engeller.
 */
export function parseTrNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}
