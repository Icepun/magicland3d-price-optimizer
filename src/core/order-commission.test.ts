/**
 * SİPARİŞTE KESİLEN KOMİSYON — sipariş kârı siparişin KENDİ oranıyla hesaplanır.
 *
 * Berke'nin kararı (22 Kas 2026): ilana elle girilen oran satış öncesi maliyet hesabının
 * varsayılanıdır; sipariş kârına ise o satışta gerçekten kesilen oran girer.
 *
 * EŞİTLİK İLKESİ: oran GELMEYEN satırda (Shopify, eski önbellek, eski kalem geçmişi) sonuç eski
 * hesapla BİREBİR aynı kalmalı — bu dosyanın ilk bölümü onu kilitler.
 */
import { describe, expect, it } from "vitest";
import { gecerliSiparisOrani, hbSiparisKomisyonOrani, siparisKomisyonKesri } from "./order-commission";
import {
  computeOrderProfit,
  resolveOrderProfit,
  type OrderProfitInput,
  type OrderProfitLine,
} from "./order-profit";
import type { CargoRuleInput, CommissionRuleInput, ExpenseRuleInput } from "./types";

const commissionRules: CommissionRuleInput[] = [];
const cargoRules: CargoRuleInput[] = [
  {
    id: "k1", name: "TEX", platform: "trendyol", categoryName: null, cargoProvider: "TEX",
    minPrice: 0, maxPrice: 1_000_000, minDesi: 0, maxDesi: 999, cargoCost: 60,
    validFrom: null, validTo: null, priority: 1, isActive: true,
  } as CargoRuleInput,
];
const expenseRules: ExpenseRuleInput[] = [
  {
    id: "e1", name: "Platform Hizmet Bedeli", platform: "trendyol", categoryName: null,
    type: "fixed", value: 13.19, minPrice: 0, maxPrice: 999999, priority: 0, isActive: true,
  } as ExpenseRuleInput,
];

/** İlana elle %21 girilmiş bir ürün (Berke'nin "varsayılan komisyon"u). */
function satir(overrides: Partial<OrderProfitLine> = {}): OrderProfitLine {
  return {
    unitPrice: 200,
    quantity: 1,
    product: {
      id: "p1", name: "Ürün", categoryName: "Dekor", desi: 1, commissionRate: null,
      productionCost: 40, packagingCost: 8, packagingComponents: null, filamentCost: 15,
      productionCostKnown: true,
      listing: { platform: "trendyol", commissionRate: 0.21, commissionFixed: null, cargoCost: null },
    },
    ...overrides,
  };
}

function girdi(lines: OrderProfitLine[], overrides: Partial<OrderProfitInput> = {}): OrderProfitInput {
  return {
    platform: "trendyol",
    orderTotal: lines.reduce((t, l) => t + l.unitPrice * l.quantity, 0),
    lines,
    commissionRules,
    cargoRules,
    expenseRules,
    settings: { vatRate: "20" },
    orderedAt: new Date("2026-11-20T10:00:00Z"),
    ...overrides,
  };
}

describe("siparisKomisyonKesri — pazaryeri yüzdesi → kesir", () => {
  it("yüzdeyi kesire çevirir (tam ve kesirli)", () => {
    expect(siparisKomisyonKesri(21)).toBe(0.21);
    expect(siparisKomisyonKesri(13.2)).toBe(0.132);
    expect(siparisKomisyonKesri(2.7)).toBe(0.027);
    expect(siparisKomisyonKesri("18")).toBe(0.18);
  });

  it("1'den küçük yüzdeyi KESİR sanmaz (%0,5 → 0,005; %50 değil)", () => {
    expect(siparisKomisyonKesri(0.5)).toBe(0.005);
  });

  it("boş, sıfır, negatif, %100+ ve sayı olmayan değer 'bilinmiyor' sayılır", () => {
    for (const v of [null, undefined, "", 0, -3, 100, 250, NaN, "abc", {}]) {
      expect(siparisKomisyonKesri(v)).toBeNull();
    }
  });

  it("gecerliSiparisOrani bozuk kesri eler", () => {
    expect(gecerliSiparisOrani(0.132)).toBe(0.132);
    for (const v of [null, undefined, 0, -0.1, 1, 21, NaN, "0.2"]) {
      expect(gecerliSiparisOrani(v)).toBeNull();
    }
  });
});

describe("hbSiparisKomisyonOrani — Hepsiburada'da KESİLEN TUTAR esas", () => {
  // Aşağıdaki rakamlar canlı HB yanıtlarından (22 Kas 2026).
  it("indirimsiz kalemde bildirilen oranı aynen verir (tutar adet başına, yuvarlama gürültüsü yok)", () => {
    expect(hbSiparisKomisyonOrani({ commissionRate: 10, commission: { amount: 20 } }, 199.99)).toBe(0.1);
    expect(hbSiparisKomisyonOrani({ commissionRate: 18, commission: { amount: 90 } }, 499.99)).toBe(0.18);
    expect(hbSiparisKomisyonOrani({ commissionRate: 22, commission: { amount: 83.59999 } }, 379.99)).toBe(0.22);
  });

  it("HB indirimi varsa komisyon indirim öncesi fiyattan kesilir → satır fiyatına göre oran yükselir", () => {
    // Birim 450 (HB 50 TL indirim yapmış), oran %22, kesilen 110 = 500 × %22.
    const oran = hbSiparisKomisyonOrani({ commissionRate: 22, commission: { amount: 110 } }, 450)!;
    expect(450 * oran).toBeCloseTo(110, 3);
    // Birim 321,99, kesilen 77 = 350 × %22.
    expect(321.99 * hbSiparisKomisyonOrani({ commissionRate: 22, commission: { amount: 77 } }, 321.99)!).toBeCloseTo(77, 3);
  });

  it("tutar yoksa ya da fiyat bilinmiyorsa bildirilen orana düşer", () => {
    expect(hbSiparisKomisyonOrani({ commissionRate: 18 }, 500)).toBe(0.18);
    expect(hbSiparisKomisyonOrani({ commissionRate: 18, commission: { amount: 0 } }, 500)).toBe(0.18);
    expect(hbSiparisKomisyonOrani({ commissionRate: 18, commission: { amount: 90 } }, 0)).toBe(0.18);
    expect(hbSiparisKomisyonOrani({ commissionRate: 18, commission: "x" }, 500)).toBe(0.18);
  });

  it("akla yatmayan tutar (alan satır toplamına dönmüş olabilir) oranı BOZMAZ", () => {
    // 2 adet için toplam (180) gelseydi oran %36 çıkardı → bildirilen %18 korunur.
    expect(hbSiparisKomisyonOrani({ commissionRate: 18, commission: { amount: 180 } }, 499.99)).toBe(0.18);
    expect(hbSiparisKomisyonOrani({ commissionRate: 18, commission: { amount: 5 } }, 499.99)).toBe(0.18);
  });

  it("oran hiç gelmediyse kesilen tutardan türetir; ikisi de yoksa null", () => {
    expect(hbSiparisKomisyonOrani({ commission: { amount: 50 } }, 500)).toBe(0.1);
    expect(hbSiparisKomisyonOrani({}, 500)).toBeNull();
  });
});

describe("sipariş kârı — EŞİTLİK: oran gelmeyince eski hesap birebir", () => {
  const eski = computeOrderProfit(girdi([satir()]));

  it("alan hiç yokken, null iken ve geçersizken sonuç aynı", () => {
    for (const oran of [undefined, null, 0, -1, 1, 21, NaN]) {
      const r = computeOrderProfit(girdi([satir({ orderCommissionRate: oran as number | null })]));
      expect(r.profit).toBe(eski.profit);
      expect(r.estimatedCommission).toBe(eski.estimatedCommission);
      expect(r.inputVatCredit).toBe(eski.inputVatCredit);
      expect(r.orderRateLines).toBe(0);
    }
  });

  it("varsayılan oran ilandan gelir: 200 × %21 = 42", () => {
    expect(eski.estimatedCommission).toBeCloseTo(42, 6);
  });

  it("siparişteki oran ilandaki oranla AYNIYSA rakam değişmez", () => {
    const r = computeOrderProfit(girdi([satir({ orderCommissionRate: 0.21 })]));
    expect(r.profit).toBeCloseTo(eski.profit!, 9);
    expect(r.estimatedCommission).toBeCloseTo(eski.estimatedCommission, 9);
    expect(r.orderRateLines).toBe(1);
  });
});

describe("sipariş kârı — siparişte kesilen oran öne geçer", () => {
  it("kampanya oranı (%13,2) ilana elle girilen %21'in yerine geçer", () => {
    const eski = computeOrderProfit(girdi([satir()]));
    const yeni = computeOrderProfit(girdi([satir({ orderCommissionRate: 0.132 })]));
    expect(yeni.estimatedCommission).toBeCloseTo(200 * 0.132, 6); // 26,40
    // Kâr farkı = komisyon farkının KDV'si indirildikten sonraki kısmı: (42 − 26,40) × 5/6.
    expect(yeni.profit! - eski.profit!).toBeCloseTo((42 - 26.4) * (5 / 6), 6);
    // İndirilecek KDV de aynı komisyon farkıyla azalır.
    expect(eski.inputVatCredit - yeni.inputVatCredit).toBeCloseTo((42 - 26.4) / 6, 6);
  });

  it("siparişteki oran ürün oranının ve kategori kuralının da önündedir", () => {
    const kural: CommissionRuleInput = {
      id: "c1", name: "Kategori %30", categoryName: null, minPrice: 0, maxPrice: 1_000_000,
      commissionRate: 0.3, fixedCommission: 0, validFrom: null, validTo: null, priority: 1, isActive: true,
    };
    const temel = satir();
    const ilanYok = satir({
      orderCommissionRate: 0.19,
      product: { ...temel.product!, commissionRate: 0.25, listing: null },
    });
    const r = computeOrderProfit(girdi([ilanYok], { commissionRules: [kural] }));
    expect(r.estimatedCommission).toBeCloseTo(200 * 0.19, 6);
  });

  it("adet ve çok satırda her satır KENDİ oranını kullanır; oransız satır varsayılanda kalır", () => {
    const r = computeOrderProfit(
      girdi([
        satir({ quantity: 2, orderCommissionRate: 0.13 }), // 400 × %13 = 52
        satir({ unitPrice: 100, orderCommissionRate: 0.099 }), // 100 × %9,9 = 9,9
        satir({ unitPrice: 50 }), // oran yok → ilan %21 = 10,5
      ])
    );
    expect(r.estimatedCommission).toBeCloseTo(52 + 9.9 + 10.5, 6);
    expect(r.orderRateLines).toBe(2);
    expect(r.matchedLines).toBe(3);
  });

  it("maliyeti bilinmeyen satır kâra girmez; oranı sayılmaz", () => {
    const temel = satir();
    const r = computeOrderProfit(
      girdi([
        satir({ orderCommissionRate: 0.13 }),
        satir({ orderCommissionRate: 0.13, product: { ...temel.product!, productionCostKnown: false } }),
      ])
    );
    expect(r.orderRateLines).toBe(1);
    expect(r.partial).toBe(true);
    expect(r.estimatedCommission).toBeCloseTo(200 * 0.13, 6);
  });

  it("sipariş toplamı satırlardan farklıysa fark da siparişin oranıyla komisyonlanır", () => {
    // Satır 200, sipariş toplamı 180 (sipariş geneli 20 TL indirim) → komisyon 180 × %13.
    const r = computeOrderProfit(girdi([satir({ orderCommissionRate: 0.13 })], { orderTotal: 180 }));
    expect(r.estimatedCommission).toBeCloseTo(180 * 0.13, 6);
  });
});

describe("resolveOrderProfit — ödeme kaydındaki gerçek komisyon yine en güçlüsü", () => {
  it("ödeme kaydı gelince sonuç, başlangıç oranı ne olursa olsun AYNI kâra iner", () => {
    const financial = { actualCommission: 26.4, settlementRevenue: 200 };
    const varsayilan = resolveOrderProfit(girdi([satir()]), { financial });
    const sipariseGore = resolveOrderProfit(girdi([satir({ orderCommissionRate: 0.132 })]), { financial });
    expect(varsayilan.profitSource).toBe("platform");
    expect(sipariseGore.profitSource).toBe("platform");
    expect(sipariseGore.profit).toBeCloseTo(varsayilan.profit!, 6);
    expect(sipariseGore.actualCommission).toBe(26.4);
  });

  it("ödeme kaydı yokken siparişin oranı, ödeme gelince çıkacak kârı ÖNCEDEN verir", () => {
    const once = resolveOrderProfit(girdi([satir({ orderCommissionRate: 0.132 })]));
    const sonra = resolveOrderProfit(girdi([satir({ orderCommissionRate: 0.132 })]), {
      financial: { actualCommission: 26.4, settlementRevenue: 200 },
    });
    expect(once.profitSource).toBe("calculated");
    expect(once.profit).toBeCloseTo(sonra.profit!, 6);
  });

  it("iptal siparişte de siparişin oranı kural-tabanlı hesaba girer, gerçek komisyon uygulanmaz", () => {
    const r = resolveOrderProfit(girdi([satir({ orderCommissionRate: 0.132 })]), {
      statusKind: "cancelled",
      financial: { actualCommission: 99, settlementRevenue: 200 },
    });
    expect(r.profitSource).toBe("calculated");
    expect(r.estimatedCommission).toBeCloseTo(26.4, 6);
  });
});
