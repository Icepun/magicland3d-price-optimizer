/**
 * Toplu ürün düzenlemesinin saf yardımcıları.
 *
 * NEDEN AYRI DOSYA: Next 16 rota dosyaları YALNIZ istek işleyicilerini dışa açabilir; buradan
 * dışa açılan bir yardımcı `next build` tip denetiminde patlar ve bunu `tsc --noEmit` YAKALAMAZ.
 */

/** Tek UPDATE'in taşıyabileceği kimlik sayısı — SQLite parametre sınırının güvenli altı. */
export const ID_CHUNK = 400;

/** Kimlikleri dilimlere böl — tek UPDATE bin kimlik taşıyamaz. Tekrarlı kimlikler elenir. */
export function chunkIds(ids: string[], size: number = ID_CHUNK): string[][] {
  const unique = [...new Set(ids)];
  const chunks: string[][] = [];
  for (let offset = 0; offset < unique.length; offset += size) {
    chunks.push(unique.slice(offset, offset + size));
  }
  return chunks;
}

/**
 * Bu düzenleme kâr rakamını etkiler mi?
 * Desi kargoyu, kategori komisyon/paketleme kuralını seçer → ikisi de kâra girer.
 * "Sipariş üzerine üretilir" yalnız listeleri ve stok uyarısını etkiler.
 */
export function affectsProfitInputs(input: {
  desi?: number;
  categoryName?: string;
}): boolean {
  return input.desi !== undefined || input.categoryName !== undefined;
}
