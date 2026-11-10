/**
 * HIZLI HESAP — ürün ekranıyla AYNI rakamı söylemeli (kendi hesabı yok, sanal ürünle çekirdek).
 *
 * Ayarlar canlı veriden (10 Kas 2026): aşınma 4,6 ₺/sa, elektrik dahil değil, KDV %20,
 * Shopify komisyonu %6,29, Trendyol/HB "Platform Hizmet Bedeli" sabit gideri.
 */
import { describe, expect, it } from "vitest";
import { fiyatDagilimi, hizliHesapla, sayiOku, sikKomisyonlar, type HizliHesapBaglam, type HizliHesapGirdi } from "./hizli-hesap";
import { simulatePrice } from "../core/pricing-engine";
import { resolveProductCost, packagingScopeInput } from "../core/product-cost";

const settings = {
  costMachineWearPerHour: "4.6",
  costElectricityIncluded: "false",
  costElectricityPerHour: "0.50",
  costLaborPerHour: "0",
  vatRate: "20",
  shopifyCommissionRate: "6.29",
  packagingOptions: JSON.stringify([{ id: "poset-kucuk", name: "Küçük kargo poşeti", price: 1.5 }]),
  nylonRollPrice: "100", nylonRollGrams: "1000", nylonLowGrams: "10",
};

const kargo = (id: string, platform: string, minDesi: number, maxDesi: number, cargoCost: number, minPrice = 0, maxPrice = 999999) => ({
  id, name: id, platform, minPrice, maxPrice, minDesi, maxDesi, cargoCost, priority: 0, isActive: true,
});

const baglam: HizliHesapBaglam = {
  filaments: [{ id: "eco", costPerGram: 0.648 }],
  settings,
  commissionRules: [],
  cargoRules: [
    kargo("ty-1", "trendyol", 0, 1, 52.5),
    kargo("ty-2", "trendyol", 1.01, 2, 61),
    kargo("sh-1", "shopify", 0, 30, 70, 150),
  ],
  expenseRules: [
    { id: "ty-hb", name: "Platform Hizmet Bedeli", platform: "trendyol", type: "fixed", value: 13.19, minPrice: 0, maxPrice: 999999, priority: 0, isActive: true },
  ],
};

const girdi = (o: Partial<HizliHesapGirdi> = {}): HizliHesapGirdi => ({
  platform: "trendyol", filamentTypeId: "eco", gram: 85, saat: 3.5, desi: 1, firePct: 0,
  packagingOptionId: "poset-kucuk", nylonLevel: "low", tapeUsed: false, komisyonPct: 21, fiyat: 349.9, ...o,
});

describe("hızlı hesap", () => {
  it("ürün ekranıyla birebir: aynı girdiler çekirdeğe doğrudan verilince aynı kâr", () => {
    const { sonuc, maliyet } = hizliHesapla(girdi(), baglam);
    const cozulen = resolveProductCost(
      {
        costMode: "detailed", manualCost: null, totalCost: null, filamentWeight: 85, printTimeHours: 3.5,
        wasteRate: 0, packagingOptionId: "poset-kucuk", nylonLevel: "low", tapeUsed: false,
      },
      settings, 0.648, new Map([["eco", 0.648]]),
    )!;
    const beklenen = simulatePrice({
      salePrice: 349.9, productCost: cozulen.productionCost, packagingCost: cozulen.packagingCost,
      ...packagingScopeInput(cozulen), categoryName: "", desi: 1,
      commissionRules: [], cargoRules: baglam.cargoRules.filter((r) => r.platform === "trendyol"),
      expenseRules: baglam.expenseRules, vatRate: 20, commissionRateOverride: 0.21,
      minOrderQty: 1, vatableProductCost: cozulen.filamentCost,
    });
    expect(maliyet.toplam).toBeCloseTo(cozulen.totalCost, 6);
    expect(sonuc?.netProfit).toBeCloseTo(beklenen.netProfit, 6);
    expect(sonuc?.profitMargin).toBeCloseTo(beklenen.profitMargin, 6);
    expect(sonuc?.cargoCost).toBe(52.5);
    expect(sonuc?.commissionCost).toBeCloseTo(349.9 * 0.21, 6);
    expect(sonuc?.fixedExpenses).toBe(13.19);
  });

  it("fiyat yokken kâr yok ama maliyet ve hedef fiyatlar var; hedef fiyat gerçekten o marjı verir", () => {
    const r = hizliHesapla(girdi({ fiyat: null }), baglam);
    expect(r.sonuc).toBeNull();
    expect(r.maliyet.biliniyor).toBe(true);
    expect(r.hedefler.map((h) => h.marj)).toEqual([20, 30, 40, 50]);
    const otuz = r.hedefler.find((h) => h.marj === 30)!.fiyat!;
    expect(otuz).toBeGreaterThan(0);
    const dogrulama = hizliHesapla(girdi({ fiyat: otuz }), baglam).sonuc!;
    expect(dogrulama.profitMargin).toBeGreaterThanOrEqual(0.3 - 1e-3);
    // Fiyat arttıkça hedef de artar.
    const fiyatlar = r.hedefler.map((h) => h.fiyat!);
    expect([...fiyatlar].sort((a, b) => a - b)).toEqual(fiyatlar);
  });

  it("Trendyol bareni: ucuz üründe kâr en az N adetlik sipariş üzerinden", () => {
    const r = hizliHesapla(girdi({ fiyat: 49.9, gram: 10, saat: 0.5 }), baglam);
    expect(r.sonuc?.minOrderQty).toBe(3);
  });

  it("Shopify: komisyon boşsa Ayarlar'daki oran; sepet minimumu altında kargo satıcıda değil", () => {
    const r = hizliHesapla(girdi({ platform: "shopify", komisyonPct: null, fiyat: 120 }), baglam);
    expect(r.sonuc?.commissionCost).toBeCloseTo(120 * 0.0629, 6);
    expect(r.sonuc?.cargoCost).toBe(0);
    expect(r.kargoFiyatiYok).toBe(false);
  });

  it("filament / gramaj yoksa maliyet bilinmiyor → kâr gösterilmez; desi boşsa uyarı", () => {
    const r = hizliHesapla(girdi({ filamentTypeId: "", desi: null }), baglam);
    expect(r.maliyet.biliniyor).toBe(false);
    expect(r.sonuc).toBeNull();
    expect(r.desiVarsayildi).toBe(true);
  });

  it("uyan kargo fiyatı yoksa söylenir (5 desi, tarifede yok)", () => {
    expect(hizliHesapla(girdi({ desi: 5 }), baglam).kargoFiyatiYok).toBe(true);
  });

  it("fiyat dağılımı ciroyu tam böler; zararda kâr 0, zarar ayrı", () => {
    const s = hizliHesapla(girdi(), baglam).sonuc!;
    const d = fiyatDagilimi(s);
    const toplam = d.dilimler.reduce((a, x) => a + x.tutar, 0);
    expect(toplam).toBeCloseTo(d.ciro, 6);
    const zararda = fiyatDagilimi(hizliHesapla(girdi({ fiyat: 60, gram: 300, saat: 10 }), baglam).sonuc!);
    expect(zararda.dilimler.find((x) => x.anahtar === "kar")!.tutar).toBe(0);
    expect(zararda.zarar).toBeGreaterThan(0);
  });

  it("sayı girişi: virgül, boşluk, boş", () => {
    expect(sayiOku("12,5")).toBe(12.5);
    expect(sayiOku(" 1 250 ")).toBe(1250);
    expect(sayiOku("")).toBeNull();
    expect(sayiOku("abc")).toBeNull();
  });

  it("sık komisyonlar: sıklığa göre, yüzde, geçersizler atlanır", () => {
    const r = sikKomisyonlar([
      { platform: "trendyol", commissionRate: 0.21 }, { platform: "trendyol", commissionRate: 0.14 },
      { platform: "trendyol", commissionRate: 0.14 }, { platform: "trendyol", commissionRate: 0.225 },
      { platform: "trendyol", commissionRate: null }, { platform: "trendyol", commissionRate: 1.5 },
      { platform: "hepsiburada", commissionRate: 0.1 }, { platform: "shopify", commissionRate: 0.03 },
    ]);
    expect(r.trendyol).toEqual([14, 21, 22.5]);
    expect(r.hepsiburada).toEqual([10]);
  });
});
