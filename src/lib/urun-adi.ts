/** "Ahtapot Şarap Tutacağı — Bebek Mavisi" → { taban, varyant }. Ayraç yoksa varyant boş. */
export function adParcala(ad: string): { taban: string; varyant: string } {
  const i = ad.lastIndexOf(" — ");
  return i > 0 ? { taban: ad.slice(0, i).trim(), varyant: ad.slice(i + 3).trim() } : { taban: ad.trim(), varyant: "" };
}
