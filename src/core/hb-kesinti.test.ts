/**
 * HEPSİBURADA KESİNTİLERİ — kurallar Hepsiburada'nın kendi muhasebe kayıtlarıyla doğrulanır.
 *
 * Buradaki her rakam canlı kayıtlardan alındı (22 Kas 2026): sipariş kaleminin API'deki hâli +
 * muhasebe servisinin aynı sipariş için döndürdüğü kesintiler. Test, kalemden hesaplanan tahminin
 * Hepsiburada'nın gerçekten kestiği tutarı KURUŞU KURUŞUNA verdiğini kilitler.
 */
import { describe, expect, it } from "vitest";
import { hbHizmetBedeli, hbKalemHesabi, HB_HIZMET_BEDELI } from "./hb-kesinti";
import { computeOrderProfit, type OrderProfitInput, type OrderProfitLine } from "./order-profit";

const tl = (amount: number) => ({ currency: "TRY", amount });

describe("hbKalemHesabi — canlı kayıtlarla birebir", () => {
  it("sipariş 4845254772: 199,99 TL, %10 → komisyon 24,00 · tahsilat 1,60 · stopaj 1,67", () => {
    const h = hbKalemHesabi(
      { commissionRate: 10, commission: tl(20), vatRate: 20, dispatchTime: 1, hbDiscount: { unitPrice: tl(0), totalPrice: tl(0) } },
      1,
      199.99
    );
    expect(h.unitPrice).toBe(199.99);
    expect(h.commissionRate).toBe(0.12); // panel "%12 (KDV dahil)"
    expect(h.unitPrice * h.commissionRate!).toBeCloseTo(24.0, 2);
    expect(h.paymentFee).toBe(1.6);
    expect(h.stoppage).toBe(1.67);
    expect(h.saleVatRate).toBe(20);
    expect(h.dispatchDays).toBe(1);
  });

  it("sipariş 4678496169: HB indirimi satıcıya geri ödenir → gelir 499,99, komisyon 132,00", () => {
    const h = hbKalemHesabi(
      { commissionRate: 22, commission: tl(110), vatRate: 20, hbDiscount: { unitPrice: tl(49.98999), totalPrice: tl(49.98999) } },
      1,
      450
    );
    expect(h.unitPrice).toBeCloseTo(499.99, 2); // net 367,99 = 450 − 132 + 49,99
    expect(h.hbDiscountUnit).toBeCloseTo(49.99, 2);
    expect(h.commissionRate).toBe(0.264); // %22 × 1,2
    expect(h.unitPrice * h.commissionRate!).toBeCloseTo(132.0, 2);
    // Tahsilat ve stopaj müşterinin ÖDEDİĞİ tutardan (450), indirim dahil değil.
    expect(h.paymentFee).toBe(3.6);
    expect(h.stoppage).toBe(3.75);
  });

  it("sipariş 4646588099: KDV'si %10 olan ürün (379,99) → komisyon 100,32 · tahsilat 3,32 · stopaj 3,45", () => {
    const h = hbKalemHesabi(
      { commissionRate: 22, commission: tl(83.59999), vatRate: 10, dispatchTime: 2 },
      1,
      379.99
    );
    expect(h.commissionRate).toBe(0.264);
    expect(h.unitPrice * h.commissionRate!).toBeCloseTo(100.32, 2);
    expect(h.saleVatRate).toBe(10);
    // Taban KDV hariç tutar: 379,99 / 1,10 = 345,45 → %0,96 ve %1.
    expect(h.paymentFee).toBe(3.32); // Hepsiburada kaydı 3,31 (kuruş yuvarlaması)
    expect(h.stoppage).toBe(3.45);
    expect(h.dispatchDays).toBe(2);
  });

  it("çok adetli kalemde tutarlar adetle çarpılır; komisyon tutarı adet başınadır", () => {
    // 2 adet × 199,99, %10: Hepsiburada `commission.amount`'u ADET BAŞINA (20) veriyor.
    const h = hbKalemHesabi({ commissionRate: 10, commission: tl(20), vatRate: 20 }, 2, 199.99);
    expect(h.commissionRate).toBe(0.12);
    expect(h.paymentFee).toBe(3.2); // 2 × 1,60
    expect(h.stoppage).toBe(3.33);
  });

  it("alanlar eksikse güvenli tarafta kalır: oran yok → null, KDV yok → %20 tabanı, süre yok → null", () => {
    const h = hbKalemHesabi({}, 1, 100);
    expect(h.unitPrice).toBe(100);
    expect(h.hbDiscountUnit).toBe(0);
    expect(h.commissionRate).toBeNull();
    expect(h.saleVatRate).toBeNull();
    expect(h.paymentFee).toBe(0.8);
    expect(h.stoppage).toBe(0.83);
    expect(h.dispatchDays).toBeNull();
  });

  it("bozuk indirim/fiyat değerleri hesabı bozmaz", () => {
    const h = hbKalemHesabi({ commissionRate: 10, hbDiscount: { unitPrice: "x", totalPrice: -5 } }, 0, Number.NaN);
    expect(h.unitPrice).toBe(0);
    expect(h.hbDiscountUnit).toBe(0);
    expect(h.paymentFee).toBe(0);
    expect(h.stoppage).toBe(0);
  });
});

describe("hbHizmetBedeli — her siparişe değil", () => {
  it("kargoya verme süresi 1 gün → kesilmez", () => {
    expect(hbHizmetBedeli([{ dispatchDays: 1 }, { dispatchDays: 1 }])).toBe(0);
  });
  it("süresi 2+ gün olan kalem varsa bir kez kesilir", () => {
    expect(hbHizmetBedeli([{ dispatchDays: 1 }, { dispatchDays: 2 }])).toBe(HB_HIZMET_BEDELI);
    expect(hbHizmetBedeli([{ dispatchDays: 5 }])).toBe(13.19);
  });
  it("süre bilinmiyorsa kesilmez sayılır", () => {
    expect(hbHizmetBedeli([{ dispatchDays: null }, {}])).toBe(0);
    expect(hbHizmetBedeli([])).toBe(0);
  });
  it("ayarlarda güncel tutar varsa o kullanılır; bozuk ayar yok sayılır", () => {
    expect(hbHizmetBedeli([{ dispatchDays: 2 }], { hbServiceFee: "14.5" })).toBe(14.5);
    expect(hbHizmetBedeli([{ dispatchDays: 2 }], { hbServiceFee: "abc" })).toBe(13.19);
    expect(hbHizmetBedeli([{ dispatchDays: 1 }], { hbServiceFee: "14.5" })).toBe(0);
  });
});

/**
 * Uçtan uca: kalem → kâr motoru. Hepsiburada'nın NET TUTARI (kargo hariç) ile motorun brüt
 * kesintileri birebir aynı olmalı; KDV ayrıştırması da ilanın kendi oranıyla yapılmalı.
 */
describe("kâr motoru — Hepsiburada kalemiyle", () => {
  function girdi(lines: OrderProfitLine[], ek: Partial<OrderProfitInput> = {}): OrderProfitInput {
    return {
      platform: "hepsiburada",
      orderTotal: lines.reduce((t, l) => t + l.unitPrice * l.quantity, 0),
      lines,
      commissionRules: [],
      cargoRules: [],
      // Kuralda "her siparişe 11,40" yazıyor — orderFee verilince bu kural devre dışı kalmalı.
      expenseRules: [
        { id: "e", name: "Platform Hizmet Bedeli", platform: "hepsiburada", categoryName: null, type: "fixed", value: 11.4, minPrice: 0, maxPrice: 999999, priority: 0, isActive: true } as never,
      ],
      settings: { vatRate: "20" },
      orderedAt: new Date("2026-11-19T10:00:00Z"),
      ...ek,
    };
  }
  function satir(h: ReturnType<typeof hbKalemHesabi>, adet = 1): OrderProfitLine {
    return {
      unitPrice: h.unitPrice,
      quantity: adet,
      orderCommissionRate: h.commissionRate,
      saleVatRate: h.saleVatRate,
      paymentFee: h.paymentFee,
      stoppage: h.stoppage,
      product: {
        id: "p", name: "Ürün", categoryName: "Genel", desi: 1, commissionRate: null,
        productionCost: 20, packagingCost: 0, packagingComponents: null, filamentCost: 0,
        productionCostKnown: true,
        listing: { platform: "hepsiburada", commissionRate: 0.1, commissionFixed: null, cargoCost: 0 },
      },
    };
  }

  it("4845254772: komisyon 24,00 + tahsilat 1,60 düşülür; hizmet bedeli KESİLMEZ; stopaj kâra girmez", () => {
    const h = hbKalemHesabi({ commissionRate: 10, commission: tl(20), vatRate: 20, dispatchTime: 1 }, 1, 199.99);
    const r = computeOrderProfit(girdi([satir(h)], { orderFee: hbHizmetBedeli([h]) }));
    expect(r.estimatedCommission).toBeCloseTo(24.0, 2);
    expect(r.paymentFee).toBe(1.6);
    expect(r.fixedExpense).toBe(0);
    expect(r.stoppage).toBe(1.67);
    // Kâr = KDV hariç gelir − ürün − (komisyon + tahsilat)'ın KDV'siz hâli. Kargo bu testte 0.
    const beklenen = 199.99 / 1.2 - 20 - (24.0 + 1.6) * (5 / 6);
    expect(r.profit).toBeCloseTo(beklenen, 2);
  });

  it("orderFee verilmezse gider kuralı eskisi gibi çalışır (11,40)", () => {
    const h = hbKalemHesabi({ commissionRate: 10, commission: tl(20), vatRate: 20, dispatchTime: 1 }, 1, 199.99);
    expect(computeOrderProfit(girdi([satir(h)])).fixedExpense).toBe(11.4);
  });

  it("kargoya verme süresi 2 gün → hizmet bedeli 13,19 bir kez düşülür", () => {
    const h = hbKalemHesabi({ commissionRate: 22, commission: tl(83.59999), vatRate: 10, dispatchTime: 2 }, 1, 379.99);
    const r = computeOrderProfit(girdi([satir(h)], { orderFee: hbHizmetBedeli([h]) }));
    expect(r.fixedExpense).toBe(13.19);
  });

  it("KDV'si %10 olan üründe satış KDV'si %10 ayrılır (eskiden %20 ayrılıyordu)", () => {
    const h = hbKalemHesabi({ commissionRate: 22, commission: tl(83.59999), vatRate: 10, dispatchTime: 2 }, 1, 379.99);
    const yeni = computeOrderProfit(girdi([satir(h)], { orderFee: 13.19 }));
    const eski = computeOrderProfit(girdi([{ ...satir(h), saleVatRate: null }], { orderFee: 13.19 }));
    expect(yeni.outputVat).toBeCloseTo(379.99 - 379.99 / 1.1, 2); // 34,54 — Hepsiburada kaydıyla aynı
    expect(eski.outputVat).toBeCloseTo(379.99 - 379.99 / 1.2, 2); // 63,33
    // Kâr farkı tam olarak KDV farkı kadar.
    expect(yeni.profit! - eski.profit!).toBeCloseTo(379.99 / 1.1 - 379.99 / 1.2, 2);
  });

  it("HB indirimli siparişte ciro satıcının gerçek geliridir (499,99) ve komisyon 132,00", () => {
    const h = hbKalemHesabi(
      { commissionRate: 22, commission: tl(110), vatRate: 20, hbDiscount: { unitPrice: tl(49.99), totalPrice: tl(49.99) } },
      1,
      450
    );
    const r = computeOrderProfit(girdi([satir(h)], { orderFee: 0 }));
    expect(r.estimatedCommission).toBeCloseTo(132.0, 2);
    expect(r.outputVat).toBeCloseTo(499.99 - 499.99 / 1.2, 2);
  });

  it("karışık KDV'li iki satırda satış KDV'si satır satır ayrılır", () => {
    const a = hbKalemHesabi({ commissionRate: 10, vatRate: 20 }, 1, 120);
    const b = hbKalemHesabi({ commissionRate: 10, vatRate: 10 }, 1, 110);
    const r = computeOrderProfit(girdi([satir(a), satir(b)], { orderFee: 0 }));
    expect(r.outputVat).toBeCloseTo(20 + 10, 6);
  });
});

/**
 * İlana ELLE girilen oran (satış öncesi maliyet hesabının varsayılanı) Hepsiburada'da KDV hariçtir.
 * Ürünler ekranı, fiyat hesabı ve oranı kayıtlı olmayan eski siparişler bu yoldan geçer.
 */
describe("ilana girilen Hepsiburada oranı KDV hariçtir", () => {
  it("Hepsiburada'da oran × 1,2 uygulanır; Trendyol ve Shopify'da aynen kalır", async () => {
    const { resolveListingCommissionOverride } = await import("./product-commission");
    const hb = resolveListingCommissionOverride({ platform: "hepsiburada", commissionRate: 0.1, commissionFixed: null }, {});
    expect(hb.commissionRateOverride).toBeCloseTo(0.12, 9);
    const ty = resolveListingCommissionOverride({ platform: "trendyol", commissionRate: 0.21, commissionFixed: null }, {});
    expect(ty.commissionRateOverride).toBe(0.21);
    const sh = resolveListingCommissionOverride({ platform: "shopify", commissionRate: 0.03, commissionFixed: null }, {});
    expect(sh.commissionRateOverride).toBe(0.03);
  });

  it("yalnız komisyon (sipariş kârı yolu): oran girilmemişse kural yoluna düşer; sabit komisyon çevrilmez", async () => {
    const { resolveListingCommissionOnly } = await import("./product-commission");
    expect(resolveListingCommissionOnly({ platform: "hepsiburada", commissionRate: null, commissionFixed: null }, {})).toEqual({});
    expect(resolveListingCommissionOnly({ platform: "hepsiburada", commissionRate: null, commissionFixed: 5 }, {})).toEqual({
      commissionRateOverride: undefined,
      commissionFixedOverride: 5,
    });
  });
});

/**
 * SATIŞ ÖNCESİ (Ürünler ekranı, Panel, fiyat hesabı): ilanın fiyat motoruna taşıdığı kesintiler
 * sipariş kârıyla AYNI kurallardan gelir — yoksa ürün ekranındaki kâr ile satış gerçekleşince
 * görülen kâr birbirini tutmaz.
 */
describe("satış öncesi Hepsiburada kârı", () => {
  const KURALLAR = [
    { id: "e", name: "Platform Hizmet Bedeli", platform: "hepsiburada", categoryName: null, type: "fixed", value: 11.4, minPrice: 0, maxPrice: 999999, priority: 0, isActive: true },
  ] as never;
  async function kar(ilan: Record<string, unknown>, platform = "hepsiburada") {
    const { resolveListingCommissionOverride } = await import("./product-commission");
    const { simulatePrice } = await import("./pricing-engine");
    return simulatePrice({
      salePrice: 199.99, productCost: 20, packagingCost: 0, categoryName: "Genel", desi: 1,
      commissionRules: [], cargoRules: [], expenseRules: KURALLAR, vatRate: 20, cargoCostOverride: 0,
      ...resolveListingCommissionOverride({ platform, commissionRate: 0.1, commissionFixed: null, ...ilan }, {}),
    });
  }

  it("tahsilat bedeli her ilanda; hizmet bedeli süre bilinmiyorsa/1 günse DÜŞÜLMEZ (kural 11,40 devre dışı)", async () => {
    const r = await kar({});
    expect(r.commissionCost).toBeCloseTo(24.0, 2); // %10 × 1,2
    expect(r.fixedExpenses).toBe(0);
    expect(r.variableExpenses).toBeCloseTo(1.6, 2); // tahsilat: 199,99 / 1,2 × %0,96
    // Sipariş kârıyla aynı sonuç (kargo hariç): 199,99/1,2 − 20 − (24 + 1,60) × 5/6.
    expect(r.netProfit).toBeCloseTo(199.99 / 1.2 - 20 - (24 + 1.6) * (5 / 6), 2);
    expect((await kar({ dispatchDays: 1 })).fixedExpenses).toBe(0);
  });

  it("kargoya verme süresi 2+ gün olan ilanda hizmet bedeli 13,19", async () => {
    expect((await kar({ dispatchDays: 2 })).fixedExpenses).toBe(13.19);
  });

  it("ilanın KDV oranı %10 ise satış KDV'si %10 ayrılır; tahsilat tabanı da ona göre", async () => {
    const r = await kar({ vatRate: 10 });
    expect(r.salePriceExVat).toBeCloseTo(199.99 / 1.1, 4);
    expect(r.variableExpenses).toBeCloseTo((199.99 / 1.1) * 0.0096, 4);
  });

  it("Trendyol ilanı ETKİLENMEZ: tahsilat yok, sabit bedel kuraldan", async () => {
    const { resolveListingCommissionOverride } = await import("./product-commission");
    expect(resolveListingCommissionOverride({ platform: "trendyol", commissionRate: 0.21, commissionFixed: null, dispatchDays: 3, vatRate: 10 }, {})).toEqual({
      commissionRateOverride: 0.21,
      commissionFixedOverride: undefined,
    });
  });
});
