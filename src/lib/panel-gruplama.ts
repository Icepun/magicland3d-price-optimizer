import { adParcala } from "./urun-adi";

/**
 * PANEL "ACİL MÜDAHALE" — aynı ürünün renkleri tek satır.
 *
 * 9 Eki 2026 denetimi: Balerin Takı Standı'nın 16 rengi Trendyol'da aynı fiyatla (₺74,99)
 * zararda ve her biri ayrı satırdı; liste 157 satıra, sayfa 4.400 px'e uzuyordu. Aynı platform +
 * aynı taban ad (" — " öncesi) tek satıra toplanır; kâr ve marj aralık olarak gösterilir.
 * Sıra korunur (ilk görülen satırın yeri).
 */
export interface ZararSatiri {
  id: string;
  name: string;
  platform?: string | null;
  salePrice: number;
  profit: number | null;
  margin: number | null;
}

export interface ZararGrubu<T extends ZararSatiri = ZararSatiri> {
  anahtar: string;
  /** Grupta tek satır varsa ürünün tam adı, birden çoksa taban ad. */
  ad: string;
  satirlar: T[];
  /** En kötü (en düşük) ve en iyi kâr — null olanlar hariç. */
  karAralik: [number, number] | null;
  marjAralik: [number, number] | null;
  fiyatAralik: [number, number];
}

function aralik(degerler: (number | null)[]): [number, number] | null {
  const v = degerler.filter((x): x is number => x != null && Number.isFinite(x));
  return v.length ? [Math.min(...v), Math.max(...v)] : null;
}

export function zararGruplari<T extends ZararSatiri>(satirlar: readonly T[]): ZararGrubu<T>[] {
  const gruplar = new Map<string, T[]>();
  for (const s of satirlar) {
    const { taban, varyant } = adParcala(s.name);
    const anahtar = varyant ? `${s.platform ?? "urun"}\u0000${taban.toLocaleLowerCase("tr-TR")}` : `tek\u0000${s.id}\u0000${s.platform ?? ""}`;
    const g = gruplar.get(anahtar);
    if (g) g.push(s);
    else gruplar.set(anahtar, [s]);
  }
  return [...gruplar.entries()].map(([anahtar, liste]) => ({
    anahtar,
    ad: liste.length > 1 ? adParcala(liste[0].name).taban : liste[0].name,
    satirlar: liste,
    karAralik: aralik(liste.map((s) => s.profit)),
    marjAralik: aralik(liste.map((s) => s.margin)),
    fiyatAralik: aralik(liste.map((s) => s.salePrice)) ?? [0, 0],
  }));
}
