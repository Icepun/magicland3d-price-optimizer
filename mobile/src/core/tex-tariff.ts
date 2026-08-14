/**
 * TRENDYOL EXPRESS (TEX) KARGO TARİFESİ — 1 Ağustos 2026'dan geçerli.
 *
 * Kaynak: kullanıcının ilettiği Trendyol tarife PDF'i (14 Ağu 2026). PDF'in yazı tipi gömülü
 * alt küme olduğu için sütun BAŞLIKLARI okunamadı; TEX sütunu iki adımda belirlendi:
 *   1. On taşıyıcı sütunundan yalnız biri eski TEX fiyatlarına göre TUTARLI bir artış
 *      gösteriyordu (+%6,3, kademeler arası yayılım 1,3 puan). Diğerlerinin eğrisi 8-17 puan
 *      sapıyordu — yani başka taşıyıcıların tarifeleri.
 *   2. Kullanıcı "desi 1 = 81,95" değerini PDF'ten teyit etti.
 *
 * ⚠️ TUTARLAR KDV HARİÇ — mevcut TEX kurallarıyla aynı temel (`vatIncluded: false`).
 * HepsiJet tarifesi KDV DAHİL saklanıyor; iki platform farklı yazıyor, motor ikisini de
 * `resolveVatableCost` ile normalize ediyor.
 *
 * ⚠️ ESKİ KURALLAR SİLİNMEZ. Yeni kurallar `validFrom` ile başlar, eskiler `validTo` ile
 * kapanır: geçmiş siparişler kendi dönemlerinin tarifesiyle hesaplanmaya devam etsin
 * (bkz. `order-profit.ts → orderedAt`).
 */

/** Yeni tarifenin yürürlük anı — Türkiye saatiyle 1 Ağustos 2026 00:00. */
export const TEX_YENI_TARIFE_BASLANGIC = "2026-08-01T00:00:00.000+03:00";
/** Eski tarifenin kapanış anı — bir saniye öncesi. */
export const TEX_ESKI_TARIFE_BITIS = "2026-07-31T23:59:59.000+03:00";

/**
 * 350 TL ve üzeri gönderilerde uygulanan desi tablosu (KDV hariç).
 * Aralıklar: minDesi hariç → maxDesi dahil (ilk satır 0'dan başlar).
 */
export const TEX_DESI_BRACKETS: readonly { fromDesi: number; toDesi: number; cost: number }[] = [
  { fromDesi: 0, toDesi: 2, cost: 81.95 },
  { fromDesi: 2.01, toDesi: 3, cost: 100.2 },
  { fromDesi: 3.01, toDesi: 4, cost: 107.2 },
  { fromDesi: 4.01, toDesi: 5, cost: 114.1 },
  { fromDesi: 5.01, toDesi: 6, cost: 125.6 },
  { fromDesi: 6.01, toDesi: 7, cost: 133.41 },
  { fromDesi: 7.01, toDesi: 8, cost: 142.32 },
  { fromDesi: 8.01, toDesi: 9, cost: 150.64 },
  { fromDesi: 9.01, toDesi: 10, cost: 164.18 },
  { fromDesi: 10.01, toDesi: 11, cost: 173.42 },
  { fromDesi: 11.01, toDesi: 12, cost: 182.2 },
  { fromDesi: 12.01, toDesi: 13, cost: 190.46 },
  { fromDesi: 13.01, toDesi: 14, cost: 198.1 },
  { fromDesi: 14.01, toDesi: 15, cost: 206.03 },
  { fromDesi: 15.01, toDesi: 20, cost: 252.77 },
  // Kullanıcının en büyük ürünü 6 desi; üst kademeler yine de tanımlı kalsın.
  { fromDesi: 20.01, toDesi: 999, cost: 252.77 },
];

/**
 * 350 TL altı gönderilerde desi bakılmaz, sabit ücret uygulanır.
 * Hangi setin geçerli olduğunu "barem desteği" düğmesi belirler ve düğme dönemsel değişiyor.
 */
export const TEX_FLAT_AVANTAJLI: readonly { minPrice: number; maxPrice: number; cost: number }[] = [
  { minPrice: 0, maxPrice: 199.99, cost: 38.74 },
  { minPrice: 200, maxPrice: 349.99, cost: 70.41 },
];

export const TEX_FLAT_STANDART: readonly { minPrice: number; maxPrice: number; cost: number }[] = [
  { minPrice: 0, maxPrice: 199.99, cost: 73.33 },
  { minPrice: 200, maxPrice: 349.99, cost: 78.74 },
];

export interface TexCargoRuleSeed {
  name: string;
  platform: "trendyol";
  cargoProvider: "TEX";
  categoryName: null;
  minPrice: number;
  maxPrice: number;
  minDesi: number;
  maxDesi: number;
  cargoCost: number;
  vatIncluded: false;
  validFrom: string;
  validTo: null;
  priority: number;
  isActive: boolean;
}

/**
 * Yeni tarifenin kural satırları.
 *
 * `aktifMod`: hangi düz baremin aktif olacağı. Diğeri kayıtlı ama pasif durur — barem
 * düğmesi ikisi arasında geçiş yapıyor.
 */
export function buildTexCargoRules(aktifMod: "standart" | "avantajli"): TexCargoRuleSeed[] {
  const ortak = {
    platform: "trendyol" as const,
    cargoProvider: "TEX" as const,
    categoryName: null,
    vatIncluded: false as const,
    validFrom: TEX_YENI_TARIFE_BASLANGIC,
    validTo: null,
  };

  const duz: TexCargoRuleSeed[] = [
    ...TEX_FLAT_AVANTAJLI.map((t) => ({
      ...ortak,
      name: `TEX • Avantajlı Barem • ${t.minPrice}-${Math.ceil(t.maxPrice)} TL`,
      minPrice: t.minPrice,
      maxPrice: t.maxPrice,
      minDesi: 0,
      maxDesi: 999,
      cargoCost: t.cost,
      // Düz barem desi tablosunu EZMELİ: 350 TL altı gönderide desi bakılmıyor.
      priority: 20,
      isActive: aktifMod === "avantajli",
    })),
    ...TEX_FLAT_STANDART.map((t) => ({
      ...ortak,
      name: `TEX • Standart Barem • ${t.minPrice}-${Math.ceil(t.maxPrice)} TL`,
      minPrice: t.minPrice,
      maxPrice: t.maxPrice,
      minDesi: 0,
      maxDesi: 999,
      cargoCost: t.cost,
      priority: 20,
      isActive: aktifMod === "standart",
    })),
  ];

  const desi: TexCargoRuleSeed[] = TEX_DESI_BRACKETS.map((b) => ({
    ...ortak,
    name: `TEX • 350+ TL • ${b.toDesi} desi`,
    minPrice: 350,
    maxPrice: 999999,
    minDesi: b.fromDesi,
    maxDesi: b.toDesi,
    cargoCost: b.cost,
    priority: 10,
    // Desi tablosu her iki modda da aktiftir (yalnız 350 TL üstünde eşleşir).
    isActive: true,
  }));

  return [...duz, ...desi];
}
