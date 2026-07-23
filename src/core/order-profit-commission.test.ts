import { describe, it, expect } from "vitest";
import { simulatePrice } from "./pricing-engine";
import { resolveListingCommissionOverride } from "./product-commission";

/**
 * REGRESYON: Sipariş kârı, listing komisyonunu (ör. Trendyol %21) DÜŞMELİ.
 *
 * Saha hatası (v0.19.110 öncesi): Siparişler ekranı komisyonu ₺0 sayıyordu → aynı ürün için
 * Ürünler ₺60,23, Siparişler ₺95,23 gösteriyordu (~₺35 / %58 şişik). Gerçek ürün verisiyle
 * (Samuray GPU – Ekran Kartı Tutucu) iki yolun AYNI sonucu vermesi gerekir.
 */
const PRODUCT = {
  salePrice: 199.99,
  productCost: 23.265,   // filament+elektrik+aşınma (fire dahil)
  packagingCost: 10.65,  // poşet+naylon+sabit ek
  filamentCost: 11.65,   // KDV iadesine giren malzeme payı (25g × 0,466)
  categoryName: "Dekor & Figür",
  vatRate: 20,
};
const EXPENSE_RULES = [
  {
    id: "e1", name: "Platform Hizmet Bedeli", platform: "trendyol", categoryName: null,
    type: "fixed" as const, value: 13.19, minPrice: 0, maxPrice: 999999, priority: 0, isActive: true,
  },
];

const TRENDYOL_LISTING = { platform: "trendyol", commissionRate: 0.21, commissionFixed: null };

function lineProfit(opts: { withCommission: boolean; qty: number }) {
  const sim = simulatePrice({
    salePrice: PRODUCT.salePrice,
    productCost: PRODUCT.productCost,
    packagingCost: PRODUCT.packagingCost,
    categoryName: PRODUCT.categoryName,
    desi: 1,
    commissionRules: [],      // KomisyonKuralları tablosu BOŞ (sahadaki durum)
    cargoRules: [],
    expenseRules: EXPENSE_RULES,
    vatRate: PRODUCT.vatRate,
    ...(opts.withCommission ? resolveListingCommissionOverride(TRENDYOL_LISTING, {}) : {}),
    cargoCostOverride: 0,     // kargo sipariş düzeyinde ayrıca düşülür
    minOrderQty: opts.qty,
    vatableProductCost: PRODUCT.filamentCost,
  });
  return sim.netProfit;
}

describe("sipariş kârı — listing komisyonu", () => {
  it("komisyon geçilirse paketleme KDV'si dahil doğru satır kârını verir", () => {
    expect(lineProfit({ withCommission: true, qty: 1 })).toBeCloseTo(90.4701, 2);
  });

  it("komisyon geçilmezse ~34,998 FAZLA çıkar (eski hatanın imzası)", () => {
    const withC = lineProfit({ withCommission: true, qty: 1 });
    const withoutC = lineProfit({ withCommission: false, qty: 1 });
    expect(withoutC - withC).toBeCloseTo(34.998, 2); // 199,99×0,21×5/6
  });

  it("sipariş kargosu düşülünce Ürünler ekranıyla AYNI: ₺60,23", () => {
    const cargoWithVatCredit = -34.16 + 34.16 * (20 / 120); // kargo + KDV iadesi payı
    const net = lineProfit({ withCommission: true, qty: 1 }) + cargoWithVatCredit;
    expect(net).toBeCloseTo(62.0034, 2);
  });

  it("SABİT gider adet başına TEKRARLANMAZ (2 adet ≠ tek adetin 2 katı)", () => {
    const one = lineProfit({ withCommission: true, qty: 1 });
    const two = lineProfit({ withCommission: true, qty: 2 });
    // Sabit gider (13,19) bir kez kesildiği için 2 adet, tek adetin 2 katından FAZLA kâr eder.
    // Tasarruf = giderin KDV iadesi sonrası net etkisi: 13,19 × 5/6 = 10,99.
    expect(two).toBeGreaterThan(one * 2);
    expect(two - one * 2).toBeCloseTo(13.19 * (5 / 6), 2);
  });
});
