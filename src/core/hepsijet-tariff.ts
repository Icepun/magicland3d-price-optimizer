/**
 * HepsiJet kargo tarifesi (21 Mayıs 2026). Hepsiburada siparişlerinin kargosu bununla hesaplanır.
 * Kaynak fiyatlar KDV HARİÇ verilmişti → burada %20 KDV eklenmiş (KDV DAHİL) değerler tutulur.
 *
 * İki barem (Kargo sayfasındaki "Kargo desteğinden yararlanıyor musun?" flag'i seçer):
 *   • STANDART  → her zaman desi tablosu (aşağıdaki HEPSIJET_DESI_BRACKETS).
 *   • AVANTAJLI → 0-199,99₺ ve 200-399,99₺ için sabit ücret; >400₺ için desi tablosu.
 *
 * Desi yukarı yuvarlanır (Trendyol/HB standardı): desi 2,3 → 3 desi bareminden.
 */
export type HepsiburadaCargoMode = "standart" | "avantajli";

const VAT = 1.2; // %20 KDV

/** HepsiJet desi tarifesi — KDV DAHİL (ham fiyat × 1.20). Aralıklar: minDesi (dahil) → maxDesi (dahil). */
export const HEPSIJET_DESI_BRACKETS: readonly { fromDesi: number; toDesi: number; cost: number }[] = [
  { fromDesi: 0, toDesi: 2, cost: 94.2 }, // 78,50
  { fromDesi: 2.01, toDesi: 3, cost: 112.8 }, // 94,00
  { fromDesi: 3.01, toDesi: 4, cost: 122.21 }, // 101,84
  { fromDesi: 4.01, toDesi: 5, cost: 130.39 }, // 108,66
  { fromDesi: 5.01, toDesi: 6, cost: 141.26 }, // 117,72
  { fromDesi: 6.01, toDesi: 7, cost: 150.72 }, // 125,60
  { fromDesi: 7.01, toDesi: 8, cost: 159.25 }, // 132,71
  { fromDesi: 8.01, toDesi: 9, cost: 169.67 }, // 141,39
  { fromDesi: 9.01, toDesi: 10, cost: 178.94 }, // 149,12
  { fromDesi: 10.01, toDesi: 11, cost: 186.9 }, // 155,75
  { fromDesi: 11.01, toDesi: 12, cost: 194.98 }, // 162,48
  { fromDesi: 12.01, toDesi: 13, cost: 212.4 }, // 177,00
  { fromDesi: 13.01, toDesi: 14, cost: 217.2 }, // 181,00
  { fromDesi: 14.01, toDesi: 15, cost: 229.8 }, // 191,50
  { fromDesi: 15.01, toDesi: 16, cost: 241.8 }, // 201,50
  { fromDesi: 16.01, toDesi: 17, cost: 250.2 }, // 208,50
  { fromDesi: 17.01, toDesi: 18, cost: 264.18 }, // 220,15
  { fromDesi: 18.01, toDesi: 19, cost: 282.36 }, // 235,30
  { fromDesi: 19.01, toDesi: 999, cost: 290.6 }, // 242,17 (desi 20+; daha büyük ürün yok)
];

/** Avantajlı barem sabit kademeleri (sipariş tutarına göre) — KDV DAHİL. */
export const HEPSIJET_FLAT_TIERS: readonly { minPrice: number; maxPrice: number; cost: number }[] = [
  { minPrice: 0, maxPrice: 199.99, cost: 42 * VAT }, // 50,40
  { minPrice: 200, maxPrice: 399.99, cost: 72 * VAT }, // 86,40
];

export interface HepsiburadaCargoRuleSeed {
  name: string;
  platform: "hepsiburada";
  cargoProvider: "HepsiJet";
  categoryName: null;
  minPrice: number;
  maxPrice: number;
  minDesi: number;
  maxDesi: number;
  cargoCost: number;
  priority: number;
  isActive: boolean;
}

const desiLabel = (from: number, to: number) => `${Math.ceil(from)}-${to === 999 ? "∞" : to} desi`;

/** Seçilen moda göre Hepsiburada (HepsiJet) kargo kurallarını üretir. */
export function buildHepsiburadaCargoRules(mode: HepsiburadaCargoMode): HepsiburadaCargoRuleSeed[] {
  const base = {
    platform: "hepsiburada" as const,
    cargoProvider: "HepsiJet" as const,
    categoryName: null,
    isActive: true,
  };

  if (mode === "avantajli") {
    return [
      ...HEPSIJET_FLAT_TIERS.map((t) => ({
        ...base,
        name: `HepsiJet Avantajlı • ${t.minPrice}-${Math.ceil(t.maxPrice)}₺`,
        minPrice: t.minPrice,
        maxPrice: t.maxPrice,
        minDesi: 0,
        maxDesi: 999,
        cargoCost: round2(t.cost),
        priority: 30,
      })),
      ...HEPSIJET_DESI_BRACKETS.map((b) => ({
        ...base,
        name: `HepsiJet Avantajlı • >400₺ • ${desiLabel(b.fromDesi, b.toDesi)}`,
        minPrice: 400,
        maxPrice: 999999,
        minDesi: b.fromDesi,
        maxDesi: b.toDesi,
        cargoCost: b.cost,
        priority: 25,
      })),
    ];
  }

  // standart: her fiyatta desi tablosu
  return HEPSIJET_DESI_BRACKETS.map((b) => ({
    ...base,
    name: `HepsiJet Standart • ${desiLabel(b.fromDesi, b.toDesi)}`,
    minPrice: 0,
    maxPrice: 999999,
    minDesi: b.fromDesi,
    maxDesi: b.toDesi,
    cargoCost: b.cost,
    priority: 20,
  }));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
