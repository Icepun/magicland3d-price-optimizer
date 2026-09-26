/**
 * ÇOKLU FİLAMENT — bir ürünün baskısında ana filamente EK olarak kullanılan filamentler.
 *
 * Çoğu ürün tek filamentle basılır; bazıları iki türle (ör. Piston Kupası: Porima X PLA +
 * Porima Silk PLA). Ana filament `ProductCost.filamentTypeId/filamentWeight`'te kalır; ekler
 * `ProductCost.ekFilamentlerJson` kolonunda `[{ filamentTypeId, gram }]` olarak durur.
 * Böylece ek filamenti olmayan ürünlerde (ve bunu bilmeyen eski sürümlerde) hiçbir şey değişmez.
 *
 * Fiyatlar kayıtta TUTULMAZ: gram fiyatı Maliyet Ayarları'ndan her hesapta güncel okunur —
 * ana filamentle aynı kural (zam yapılınca bütün ürünler kendiliğinden güncellenir).
 *
 * Bu dosya telefona da kopyalanır (`npm run sync-core`).
 */

export interface EkFilament {
  filamentTypeId: string;
  /** Adet başına gram (fire hariç — fire ortak orandan uygulanır). */
  gram: number;
}

/** Filament türü kimliği → gram fiyatı (TL). */
export type FilamentFiyatlari = ReadonlyMap<string, number>;

/** Tek bir listeye en fazla bu kadar ek filament yazılır (kötü girdiye karşı tavan). */
export const EK_FILAMENT_AZAMI = 8;

function gecerliSatir(x: unknown): EkFilament | null {
  if (!x || typeof x !== "object") return null;
  const r = x as { filamentTypeId?: unknown; gram?: unknown };
  const id = typeof r.filamentTypeId === "string" ? r.filamentTypeId.trim() : "";
  const gram = typeof r.gram === "number" ? r.gram : Number(r.gram);
  if (!id || !Number.isFinite(gram) || gram <= 0) return null;
  return { filamentTypeId: id, gram };
}

/**
 * Kayıtlı değeri oku. Metin (kolon), dizi (istek gövdesi) ya da boş kabul edilir; bozuk/boş
 * satırlar atlanır — bozuk kayıt hesabı düşürmez, yalnız o satır yok sayılır.
 */
export function ekFilamentleriOku(deger: unknown): EkFilament[] {
  let ham: unknown = deger;
  if (typeof deger === "string") {
    if (!deger.trim()) return [];
    try {
      ham = JSON.parse(deger);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(ham)) return [];
  const out: EkFilament[] = [];
  for (const x of ham) {
    const s = gecerliSatir(x);
    if (s) out.push(s);
    if (out.length >= EK_FILAMENT_AZAMI) break;
  }
  return out;
}

/** Saklanacak metin — boş liste `null` (kolon boş kalır, eski davranış). */
export function ekFilamentleriYaz(liste: unknown): string | null {
  const temiz = ekFilamentleriOku(Array.isArray(liste) ? liste : []);
  return temiz.length ? JSON.stringify(temiz) : null;
}

/**
 * Ek filamentlerin malzeme tutarı (fire hariç).
 * `eksik`: fiyatı bilinmeyen (silinmiş/fiyatsız tür) bir ek var → maliyet TAM değildir.
 */
export function ekFilamentMaliyeti(
  liste: readonly EkFilament[],
  fiyatlar: FilamentFiyatlari
): { tutar: number; gram: number; eksik: boolean } {
  let tutar = 0;
  let gram = 0;
  let eksik = false;
  for (const s of liste) {
    gram += s.gram;
    const fiyat = fiyatlar.get(s.filamentTypeId);
    if (fiyat == null || !Number.isFinite(fiyat) || fiyat <= 0) {
      eksik = true;
      continue;
    }
    tutar += s.gram * fiyat;
  }
  return { tutar, gram, eksik };
}

/** Adet başına toplam gram (ana + ekler) — planlayıcı ve baskı kuyruğu bunu kullanır. */
export function toplamFilamentGrami(cost: {
  filamentWeight?: number | null;
  ekFilamentlerJson?: string | null;
} | null | undefined): number {
  if (!cost) return 0;
  const ana = cost.filamentWeight != null && cost.filamentWeight > 0 ? cost.filamentWeight : 0;
  return ana + ekFilamentleriOku(cost.ekFilamentlerJson).reduce((t, s) => t + s.gram, 0);
}

/** Filament türü listesinden fiyat haritası. */
export function filamentFiyatHaritasi(
  turler: readonly { id: string; costPerGram: number | null | undefined }[]
): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of turler) {
    if (t && typeof t.id === "string" && typeof t.costPerGram === "number") m.set(t.id, t.costPerGram);
  }
  return m;
}
