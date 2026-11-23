/**
 * Türkçe TUTAR metni → sayı. Telefon ve masaüstü reklam bütçesi girişinde ortak.
 *  "1.500" → 1500 · "1.500,75" → 1500.75 · "1,5" → 1.5 · "800" → 800 · "0.65" → 0.65
 *  boş / geçersiz → null (BOŞ ≠ SIFIR: eskiden "abc" 0 sayılıp reklam sessizce duruyordu,
 *  "1.500" ise günde 1,5 ₺ oluyordu — denetim, 23 Kas 2026).
 */
export function trTutarOku(metin: string | number | null | undefined): number | null {
  if (typeof metin === "number") return Number.isFinite(metin) ? metin : null;
  let t = String(metin ?? "").replace(/[\s₺]/g, "");
  if (!t) return null;
  if (t.includes(".") && t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (t.includes(",")) t = t.replace(",", ".");
  else if (/^[1-9]\d{0,2}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
