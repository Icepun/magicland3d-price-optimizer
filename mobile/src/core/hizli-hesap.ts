/**
 * HIZLI HESAP — ürünü kaydetmeden "bu fiyattan satarsam ne kalır?" sorusu.
 *
 * Kendi hesabı YOK: ürün sayfasının canlı önizlemesi + Fiyat Lab'ı (`client-pricing`) SANAL bir
 * ürünle çağrılır. Böylece filament/fire/aşınma/paketleme, kargo tarifesi (desi + fiyat baremi),
 * platform hizmet bedeli, reklam payı, KDV ve iadesi, Trendyol min-adet bareni ürün ekranıyla
 * BİREBİR aynı kurallardan gelir — iki ekran farklı rakam söyleyemez.
 *
 * Komisyon: canlı veride kategori kuralı yok, her ilan kendi oranını taşıyor (10 Kas 2026) →
 * kullanıcı oranı kendisi girer; boş bırakılırsa platformun varsayılanı (Shopify: Ayarlar'daki oran,
 * pazaryerinde tanımlı kural varsa o) kullanılır.
 */
import { computePriceLab, computeProfitPreview, type ClientPricingInput } from "./client-pricing";
import type { CargoRuleInput, CommissionRuleInput, ExpenseRuleInput, SimulationResult } from "./types";
import { belowShopifyMinBasket } from "./platform-rules";

export type HizliPlatform = "trendyol" | "hepsiburada" | "shopify";

export interface HizliHesapGirdi {
  platform: HizliPlatform;
  filamentTypeId: string;
  gram: number;
  /** Baskı süresi (saat, ondalık). */
  saat: number;
  /** Boş = 1 desi sayılır (ürün ekranıyla aynı varsayım) ve uyarılır. */
  desi: number | null;
  /** Fire (yüzde, 0-100). */
  firePct: number;
  packagingOptionId: string;
  nylonLevel: string;
  tapeUsed: boolean;
  /** Komisyon (yüzde). Boş = platformun varsayılanı. */
  komisyonPct: number | null;
  /** KDV dahil satış fiyatı. Boş = yalnız maliyet + hedef fiyatlar. */
  fiyat: number | null;
}

export interface HizliHesapBaglam {
  filaments: Array<{ id: string; costPerGram: number }>;
  settings: Record<string, string | undefined>;
  commissionRules: CommissionRuleInput[];
  cargoRules: CargoRuleInput[];
  expenseRules: ExpenseRuleInput[];
  adRates?: Record<string, number>;
}

export interface HizliHesapSonuc {
  maliyet: { uretim: number; paketleme: number; toplam: number; biliniyor: boolean };
  /** Fiyat girilmemişse ya da maliyet bilinmiyorsa null. */
  sonuc: SimulationResult | null;
  /** Hedef marj → o marjı veren en düşük fiyat (bulunamazsa null). */
  hedefler: { marj: number; fiyat: number | null }[];
  desiVarsayildi: boolean;
  kargoFiyatiYok: boolean;
}

const SANAL_URUN = "hizli-hesap";

/** Metin girişini sayıya çevirir ("12,5" → 12.5). Boş / geçersiz → null. */
export function sayiOku(metin: string): number | null {
  const t = metin.trim().replace(/\s/g, "").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * `hedefler: false` → yalnız canlı kâr (ucuz, her tuşta). Hedef fiyatlar ikili arama yaptığı için
 * pahalı; arayüz onları fiyat DIŞINDAKİ girdiler değişince ayrıca hesaplar.
 */
export function hizliHesapla(
  g: HizliHesapGirdi,
  b: HizliHesapBaglam,
  secenek: { hedefler?: boolean } = {},
): HizliHesapSonuc {
  const fiyat = g.fiyat != null && g.fiyat > 0 ? g.fiyat : null;
  const komisyon = g.komisyonPct != null && g.komisyonPct >= 0 ? g.komisyonPct / 100 : null;
  const desi = g.desi != null && g.desi > 0 ? g.desi : null;
  const girdi: ClientPricingInput = {
    product: {
      id: SANAL_URUN,
      name: "Hızlı hesap",
      categoryName: "",
      desi,
      currentSalePrice: fiyat ?? 0,
      commissionRate: null,
      listings: [{
        id: SANAL_URUN,
        platform: g.platform,
        salePrice: fiyat ?? 0,
        commissionRate: komisyon,
        commissionFixed: null,
        cargoCost: null,
        isActive: true,
      }],
    },
    cost: {
      filamentTypeId: g.filamentTypeId,
      filamentWeight: Math.max(0, g.gram || 0),
      printTimeHours: Math.max(0, g.saat || 0),
      wasteRate: Math.min(1, Math.max(0, (g.firePct || 0) / 100)),
      packagingOptionId: g.packagingOptionId,
      nylonLevel: g.nylonLevel,
      tapeUsed: g.tapeUsed,
      desi,
    },
    filaments: b.filaments,
    settings: b.settings,
    commissionRules: b.commissionRules,
    cargoRules: b.cargoRules,
    expenseRules: b.expenseRules,
    adRates: b.adRates,
  };
  const preview = computeProfitPreview(girdi);
  const priceLab = secenek.hedefler === false ? null : computePriceLab(girdi);

  const sonuc = fiyat != null ? preview.platforms[0]?.result ?? null : null;
  const hedefler = (priceLab?.targets?.[0]?.rows ?? []).map((r) => ({ marj: r.margin, fiyat: r.price }));
  return {
    maliyet: {
      uretim: preview.productionCost,
      paketleme: preview.packagingCost,
      toplam: preview.totalCost,
      biliniyor: preview.hasCost,
    },
    sonuc,
    hedefler,
    desiVarsayildi: desi == null,
    // Ürün ekranıyla aynı kural: kargo kuralı eşleşmedi ve Shopify'ın ücretsiz kargo eşiği altı değil.
    kargoFiyatiYok: !!sonuc && !sonuc.appliedCargoRule && !belowShopifyMinBasket(g.platform, sonuc.effectiveSalePrice),
  };
}

/**
 * Fiyatın nereye gittiği (çubuk grafik için) — SİPARİŞ ölçeğinde, KDV dahil ciroya oranla.
 * Kalemler toplamı ciroya eşittir; zararda "kâr" 0, aşan kısım `zarar` olarak ayrıca döner.
 */
export function fiyatDagilimi(s: SimulationResult): {
  dilimler: { anahtar: "maliyet" | "komisyon" | "kargo" | "gider" | "kdv" | "kar"; tutar: number }[];
  ciro: number;
  zarar: number;
} {
  const ciro = s.effectiveSalePrice * s.minOrderQty;
  const kdvNet = Math.max(0, s.vatAmount * s.minOrderQty - s.inputVatCredit);
  const gider = s.fixedExpenses + s.variableExpenses + s.adCost;
  const dilimler = [
    { anahtar: "maliyet" as const, tutar: s.productCost + s.packagingCost },
    { anahtar: "komisyon" as const, tutar: s.commissionCost },
    { anahtar: "kargo" as const, tutar: s.cargoCost },
    { anahtar: "gider" as const, tutar: gider },
    { anahtar: "kdv" as const, tutar: kdvNet },
    { anahtar: "kar" as const, tutar: Math.max(0, s.netProfit) },
  ];
  return { dilimler, ciro, zarar: Math.max(0, -s.netProfit) };
}

/**
 * İlanlarda en sık kullanılan komisyon oranları (yüzde, sıklığa göre) — formda tek tıklık kısayol.
 * Ör. canlı veri: Trendyol %14 · %21 · %28 · %22 · %22,5; Hepsiburada %10 · %22 · %15 · %18.
 */
export function sikKomisyonlar(
  satirlar: Array<{ platform: string; commissionRate: number | null }>,
  adet = 5,
): Record<"trendyol" | "hepsiburada", number[]> {
  const out: Record<"trendyol" | "hepsiburada", number[]> = { trendyol: [], hepsiburada: [] };
  for (const pf of ["trendyol", "hepsiburada"] as const) {
    const sayac = new Map<number, number>();
    for (const s of satirlar) {
      if (s.platform !== pf || s.commissionRate == null || !(s.commissionRate > 0) || s.commissionRate >= 1) continue;
      const yuzde = Math.round(s.commissionRate * 1000) / 10;
      sayac.set(yuzde, (sayac.get(yuzde) ?? 0) + 1);
    }
    out[pf] = [...sayac.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, adet).map(([y]) => y);
  }
  return out;
}
