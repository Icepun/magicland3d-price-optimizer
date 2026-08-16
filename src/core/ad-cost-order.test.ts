/**
 * REKLAM PAYININ SİPARİŞ KÂRINA ETKİSİ — uçtan uca doğrulama.
 *
 * `ad-cost.test.ts` oran matematiğini test ediyor; bu dosya o oranın GERÇEK sipariş kârına
 * doğru uygulandığını kilitler. Kullanıcı "hesabın gerçekten sağlıklı çalıştığına emin ol"
 * dedi; doğrulanan şeyler:
 *   1. Kâr, tam olarak (maliyeti bilinen ciro × oran) kadar düşüyor — eksik ya da fazla değil.
 *   2. `adCost` alanı dökümde gösterilen rakamla aynı (döküm toplamı kârı vermeli).
 *   3. Reklam KDV iadesine girmiyor (yurt dışı fatura).
 *   4. Maliyeti BİLİNMEYEN satırın cirosu tabana girmiyor (kâra girmemiş satırın reklamı
 *      kârdan düşülemez).
 *   5. Oran 0 iken hesap birebir eski davranış.
 */
import { describe, expect, it } from "vitest";
import { computeOrderProfit, type OrderProfitInput, type OrderProfitProduct } from "./order-profit";

const AYARLAR = { vatRate: "20" };

function urun(over: Partial<OrderProfitProduct> = {}): OrderProfitProduct {
  return {
    id: "p1",
    name: "Test Ürün",
    categoryName: "Dekor",
    desi: 1,
    commissionRate: null,
    productionCost: 100,
    packagingCost: 10,
    packagingComponents: null,
    filamentCost: 40,
    productionCostKnown: true,
    listing: { platform: "shopify", commissionRate: 0.1, commissionFixed: 0, cargoCost: 0 },
    ...over,
  };
}

function girdi(adRate: number, over: Partial<OrderProfitInput> = {}): OrderProfitInput {
  return {
    platform: "shopify",
    orderTotal: 1000,
    lines: [{ unitPrice: 1000, quantity: 1, product: urun() }],
    commissionRules: [],
    cargoRules: [],
    expenseRules: [],
    settings: AYARLAR,
    orderedAt: new Date("2026-08-15T12:00:00+03:00"),
    adRate,
    ...over,
  };
}

describe("reklam payı sipariş kârına", () => {
  it("kâr TAM OLARAK (ciro × oran) kadar düşer", () => {
    const oransiz = computeOrderProfit(girdi(0));
    const oranli = computeOrderProfit(girdi(0.2));

    expect(oransiz.adCost).toBe(0);
    expect(oranli.adCost).toBeCloseTo(1000 * 0.2, 6);
    expect((oransiz.profit ?? 0) - (oranli.profit ?? 0)).toBeCloseTo(200, 6);
  });

  it("`adCost` dökümde gösterilecek rakamla aynı — döküm toplamı kârı verir", () => {
    const r = computeOrderProfit(girdi(0.15));
    const oransiz = computeOrderProfit(girdi(0));
    // Dökümde "Reklam payı −X" satırı gösteriliyor; X kadar düşmüş olmalı.
    expect((oransiz.profit ?? 0) - r.adCost).toBeCloseTo(r.profit ?? 0, 6);
  });

  it("reklam KDV İADESİNE girmez (yurt dışı fatura, Türk KDV'si yok)", () => {
    const oransiz = computeOrderProfit(girdi(0));
    const oranli = computeOrderProfit(girdi(0.3));
    expect(oranli.inputVatCredit).toBeCloseTo(oransiz.inputVatCredit, 6);
  });

  it("MALİYETİ BİLİNMEYEN satırın cirosu tabana girmez", () => {
    /**
     * Kâr yalnız maliyeti bilinen satırlardan hesaplanıyor. Reklam payını TÜM ciroya
     * uygulasaydık, kâra hiç girmemiş bir satırın reklam maliyeti kârdan düşülür ve rakam
     * kendi içinde tutarsız olurdu.
     */
    const karma = girdi(0.2, {
      orderTotal: 2000,
      lines: [
        { unitPrice: 1000, quantity: 1, product: urun() },
        { unitPrice: 1000, quantity: 1, product: null }, // maliyeti bilinmiyor
      ],
    });
    const r = computeOrderProfit(karma);
    // Taban yalnız eşleşen 1.000 ₺ → pay 200 ₺ (2.000 üzerinden 400 DEĞİL).
    expect(r.adCost).toBeCloseTo(200, 6);
    expect(r.partial).toBe(true);
  });

  it("oran 0 iken davranış birebir eskisi", () => {
    const a = computeOrderProfit(girdi(0));
    const b = computeOrderProfit({ ...girdi(0), adRate: undefined });
    expect(a.profit).toBeCloseTo(b.profit ?? 0, 10);
    expect(a.adCost).toBe(0);
    expect(b.adCost).toBe(0);
  });

  it("bozuk oran (NaN / negatif) hesabı patlatmaz", () => {
    expect(computeOrderProfit(girdi(Number.NaN)).adCost).toBe(0);
    expect(computeOrderProfit(girdi(-0.5)).adCost).toBe(0);
    expect(Number.isFinite(computeOrderProfit(girdi(Number.NaN)).profit ?? 0)).toBe(true);
  });

  it("İPTAL edilmiş satır (adet 0) reklam tabanına girmez", () => {
    const r = computeOrderProfit(
      girdi(0.2, {
        lines: [
          { unitPrice: 1000, quantity: 1, product: urun() },
          { unitPrice: 500, quantity: 0, product: urun({ id: "p2" }) }, // tamamen iade
        ],
      })
    );
    expect(r.adCost).toBeCloseTo(200, 6); // 1.500 değil, 1.000 üzerinden
  });

  it("çok adetli satırda taban adet × fiyat", () => {
    const r = computeOrderProfit(
      girdi(0.1, {
        orderTotal: 3000,
        lines: [{ unitPrice: 1000, quantity: 3, product: urun() }],
      })
    );
    expect(r.adCost).toBeCloseTo(300, 6);
  });
});
