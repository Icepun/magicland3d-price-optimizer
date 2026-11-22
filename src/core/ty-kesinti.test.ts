/**
 * TRENDYOL KESİNTİLERİ — kurallar Trendyol panelinin "Sipariş Kayıtları" ekranıyla doğrulanır.
 * Rakamlar canlı kayıtlardan (22 Kas 2026).
 */
import { describe, expect, it } from "vitest";
import { tyKalemHesabi } from "./ty-kesinti";
import { computeOrderProfit, type OrderProfitLine } from "./order-profit";

describe("tyKalemHesabi", () => {
  it("mikro ihracat: uluslararası hizmet bedeli satış tutarının %6'sı (panelle birebir)", () => {
    // 11838044076: 199,99 − 46,88 indirim = 153,11 → 9,19 · 11794979561: 160,29 → 9,61 · 11782207380: 749,97 → 45,00
    expect(tyKalemHesabi({ vatRate: 20 }, 153.11, { mikroIhracat: true }).internationalFee).toBe(9.19);
    expect(tyKalemHesabi({ vatRate: 20 }, 160.29, { mikroIhracat: true }).internationalFee).toBe(9.62); // panel 9,61 (kuruş)
    expect(tyKalemHesabi({ vatRate: 20 }, 749.97, { mikroIhracat: true }).internationalFee).toBe(45.0);
  });

  it("yurt içinde uluslararası bedel yok; KDV satırdan, stopaj KDV hariç tutarın %1'i", () => {
    const h = tyKalemHesabi({ vatRate: 20 }, 721.99);
    expect(h.internationalFee).toBe(0);
    expect(h.saleVatRate).toBe(20);
    expect(h.stoppage).toBe(6.02); // 721,99 / 1,2 × %1
  });

  it("mikro ihracatta satış KDV'si 0 (satır %20 dese de); stopaj tabanı KDV'siz tutar", () => {
    const h = tyKalemHesabi({ vatRate: 20 }, 153.11, { mikroIhracat: true });
    expect(h.saleVatRate).toBe(0);
    expect(h.stoppage).toBe(1.53);
  });

  it("KDV oranı bilinmiyorsa (null, kayıtlı eski kalem) %0 SAYILMAZ — genel orana bırakılır", () => {
    expect(tyKalemHesabi({ vatRate: null }, 120).saleVatRate).toBeNull();
    expect(tyKalemHesabi({}, 120).saleVatRate).toBeNull();
    expect(tyKalemHesabi({ vatRate: "" }, 120).saleVatRate).toBeNull();
    expect(tyKalemHesabi({ vatRate: 0 }, 120).saleVatRate).toBe(0);
  });

  it("bozuk değerler hesabı bozmaz", () => {
    expect(tyKalemHesabi({ vatRate: "x" }, Number.NaN)).toEqual({ saleVatRate: null, stoppage: 0, internationalFee: 0 });
  });
});

describe("kâr motoru — uluslararası hizmet bedeli düşülür, KDV'si indirilir", () => {
  const satir = (internationalFee: number | null): OrderProfitLine => ({
    unitPrice: 749.97, quantity: 1, orderCommissionRate: 0.21, saleVatRate: 0, internationalFee,
    product: {
      id: "p", name: "Ü", categoryName: "G", desi: 1, commissionRate: null, productionCost: 100, packagingCost: 0,
      packagingComponents: null, filamentCost: 0, productionCostKnown: true, listing: null,
    },
  });
  const girdi = (fee: number | null) => ({
    platform: "trendyol", orderTotal: 749.97, lines: [satir(fee)], commissionRules: [], cargoRules: [],
    expenseRules: [], settings: { vatRate: "20" }, saleVatExempt: true,
  });
  it("45,00 TL bedel kârı 45 × 5/6 = 37,50 düşürür; bedel yoksa eski hesap birebir", () => {
    const yok = computeOrderProfit(girdi(null));
    const var_ = computeOrderProfit(girdi(45));
    expect(var_.internationalFee).toBe(45);
    expect(yok.internationalFee).toBe(0);
    expect(yok.profit! - var_.profit!).toBeCloseTo(37.5, 6);
    expect(var_.inputVatCredit - yok.inputVatCredit).toBeCloseTo(7.5, 6);
  });
});
