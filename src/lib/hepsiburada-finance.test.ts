/**
 * HEPSİBURADA GERÇEK KESİNTİLERİ — muhasebe kayıtlarının sipariş başına toplanması ve kâra
 * uygulanması. Kayıt örnekleri canlı servisten alınan biçimle birebir (22 Kas 2026); tutarlar
 * Hepsiburada panelinin "Sipariş kayıtları" ekranındaki NET TUTAR ile kuruşu kuruşuna tutmalı.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/runtime-schema", () => ({ ensureRuntimeSchema: vi.fn(async () => {}) }));
vi.mock("@/services/hepsiburada-settings", () => ({ getHepsiburadaCredentials: vi.fn() }));

const { hbKayitlariniTopla, hbGercekYazmaIfadeleri, sonHizmetBedeli, hbFinansKimligi } = await import(
  "./hepsiburada-finance"
);
const { hbHizmetBedeli, hbKalemHesabi } = await import("@/core/hb-kesinti");
const { resolveOrderProfit } = await import("@/core/order-profit");

let sira = 0;
function kayit(orderNumber: string, transactionType: string, value: number, ek: Record<string, unknown> = {}) {
  return {
    id: `k-${++sira}`,
    transactionType,
    orderNumber,
    amount: { value, currencyCode: "949" },
    invoiceDate: "2026-11-21T00:00:00",
    orderDate: "2026-11-19T00:00:00",
    ...ek,
  };
}

/** Sipariş 4845254772 — panel: tutar 199,99 · komisyon 24,00 · kargo 52,79 · tahsilat 1,60 · stopaj 1,67 · net 119,93. */
const SIPARIS_A = [
  kayit("4845254772", "PaymentServiceCostReflection", -1.6),
  kayit("4845254772", "Commission", -24),
  kayit("4845254772", "Stoppage", -1.67),
  kayit("4845254772", "Payment", 199.99),
  kayit("4845254772", "ShipmentCostSharingExpense", -52.79),
];
/** Sipariş 4646588099 — hizmet bedeli kesilen: 379,99 · 100,32 · 13,19 · 98,39 · 3,31 · 3,45 · net 161,33. */
const SIPARIS_B = [
  kayit("4646588099", "Payment", 379.99),
  kayit("4646588099", "Commission", -100.32),
  kayit("4646588099", "ProcessingFeeExpense", -13.19, { invoiceDate: "2026-11-18T00:00:00" }),
  kayit("4646588099", "ShipmentCostSharingExpense", -98.39),
  kayit("4646588099", "PaymentServiceCostReflection", -3.31),
  kayit("4646588099", "Stoppage", -3.45),
];
/** Sipariş 4678496169 — HB indirimi geri ödeniyor: 450 − 132 + 49,99 (kargo henüz yazılmamış). */
const SIPARIS_C = [
  kayit("4678496169", "Payment", 450),
  kayit("4678496169", "Commission", -132),
  kayit("4678496169", "CampaignDiscount", 49.99),
];

describe("hbKayitlariniTopla", () => {
  it("kesintileri sipariş başına toplar; net tutar panelle aynı", () => {
    const { aggregates, skippedOrders } = hbKayitlariniTopla([...SIPARIS_A, ...SIPARIS_B]);
    expect(skippedOrders).toBe(0);
    const a = aggregates.find((x) => x.orderNumber === "4845254772")!;
    expect(a).toMatchObject({
      grossRevenue: 199.99, commission: 24, serviceFee: 0, paymentFee: 1.6, cargo: 52.79,
      stoppage: 1.67, platformDiscount: 0, sellerRevenue: 119.93, transactionCount: 5,
    });
    const b = aggregates.find((x) => x.orderNumber === "4646588099")!;
    expect(b).toMatchObject({ commission: 100.32, serviceFee: 13.19, cargo: 98.39, paymentFee: 3.31, stoppage: 3.45, sellerRevenue: 161.33 });
  });

  it("HB indirimi ciroya eklenir; kargo kaydı yoksa kargo 'bilinmiyor' (null) kalır", () => {
    const { aggregates } = hbKayitlariniTopla(SIPARIS_C);
    expect(aggregates[0]).toMatchObject({ grossRevenue: 499.99, platformDiscount: 49.99, commission: 132, cargo: null, sellerRevenue: 367.99 });
  });

  it("aynı kayıt iki pencerede gelirse bir kez sayılır", () => {
    const { aggregates } = hbKayitlariniTopla([...SIPARIS_A, ...SIPARIS_A]);
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0].sellerRevenue).toBe(119.93);
    expect(aggregates[0].transactionCount).toBe(5);
  });

  it("iade görmüş ya da ödemesi/komisyonu olmayan sipariş yazılmaz", () => {
    const iade = [...SIPARIS_A.map((k) => ({ ...k, id: `i-${k.id}`, orderNumber: "9" })), kayit("9", "Return", -199.99)];
    const yalnizKargo = [kayit("8", "ShipmentCostSharingExpense", -50)];
    const { aggregates, skippedOrders } = hbKayitlariniTopla([...iade, ...yalnizKargo]);
    expect(aggregates).toHaveLength(0);
    expect(skippedOrders).toBe(2);
  });

  it("iade faturaları ilgili kalemi netler (hizmet bedeli iadesi → 0)", () => {
    const { aggregates } = hbKayitlariniTopla([...SIPARIS_B, kayit("4646588099", "ProcessingFeeExpenseRefund", 13.19)]);
    expect(aggregates[0].serviceFee).toBe(0);
  });

  it("sonHizmetBedeli en son kesilen tutarı verir; hiç yoksa null", () => {
    expect(sonHizmetBedeli([...SIPARIS_A, ...SIPARIS_B, kayit("7", "ProcessingFeeExpense", -14.5, { invoiceDate: "2026-11-22T00:00:00" })])).toBe(14.5);
    expect(sonHizmetBedeli(SIPARIS_A)).toBeNull();
  });
});

describe("hbGercekYazmaIfadeleri — yalnız değişen yazılır", () => {
  const { aggregates } = hbKayitlariniTopla([...SIPARIS_A, ...SIPARIS_B]);
  it("kayıtlı olmayan her sipariş için bir ifade; kimlik uygulamanın sipariş kimliği", () => {
    const ifadeler = hbGercekYazmaIfadeleri(aggregates, new Map(), new Date("2026-11-22T12:00:00Z"));
    expect(ifadeler).toHaveLength(2);
    expect(ifadeler[0].args[1]).toBe(hbFinansKimligi(aggregates[0].orderNumber));
    expect(ifadeler[0].sql).toContain("'hepsiburada'");
    // Kuruş: ciro, komisyon, net, adet … hizmet, tahsilat, kargo, stopaj, indirim.
    const a = ifadeler.find((i) => i.args[1] === "hb-4845254772")!;
    expect(a.args.slice(3, 7)).toEqual([19999, 2400, 11993, 5]);
    expect(a.args.slice(9)).toEqual([0, 160, 5279, 167, 0]);
  });
  it("birebir aynı kayıt yeniden yazılmaz; bir alan değişince yazılır", () => {
    const kayitli = new Map(
      aggregates.map((r) => [
        hbFinansKimligi(r.orderNumber),
        {
          externalOrderId: hbFinansKimligi(r.orderNumber),
          grossRevenueKurus: Math.round(r.grossRevenue * 100), commissionKurus: Math.round(r.commission * 100),
          sellerRevenueKurus: Math.round(r.sellerRevenue * 100), transactionCount: r.transactionCount,
          serviceFeeKurus: Math.round(r.serviceFee * 100), paymentFeeKurus: Math.round(r.paymentFee * 100),
          cargoKurus: r.cargo == null ? null : Math.round(r.cargo * 100), stoppageKurus: Math.round(r.stoppage * 100),
          platformDiscountKurus: Math.round(r.platformDiscount * 100),
        },
      ])
    );
    expect(hbGercekYazmaIfadeleri(aggregates, kayitli, new Date())).toHaveLength(0);
    kayitli.get("hb-4845254772")!.cargoKurus = null; // kargo kaydı sonradan gelmiş
    expect(hbGercekYazmaIfadeleri(aggregates, kayitli, new Date())).toHaveLength(1);
  });
});

/**
 * UÇTAN UCA: kalem → tahmin → gerçek kayıt uygulanır → kesintiler ve net tutar panelle birebir.
 * (Ürün maliyeti 0 alınır ki karşılaştırma yalnız pazaryeri kesintilerini ölçsün.)
 */
describe("gerçek kesintiler kâra uygulanır", () => {
  const tl = (amount: number) => ({ currency: "TRY", amount });
  function hesapla(kalem: Record<string, unknown>, odenen: number, kayitlar: ReturnType<typeof kayit>[], kargoKurali = 94.2) {
    const h = hbKalemHesabi(kalem, 1, odenen);
    const g = hbKayitlariniTopla(kayitlar).aggregates[0];
    return {
      h,
      g,
      r: resolveOrderProfit(
        {
          platform: "hepsiburada",
          orderTotal: h.unitPrice,
          lines: [
            {
              unitPrice: h.unitPrice, quantity: 1, orderCommissionRate: h.commissionRate, saleVatRate: h.saleVatRate,
              paymentFee: h.paymentFee, stoppage: h.stoppage,
              product: {
                id: "p", name: "Ürün", categoryName: "Genel", desi: 1, commissionRate: null, productionCost: 0,
                packagingCost: 0, packagingComponents: null, filamentCost: 0, productionCostKnown: true,
                listing: { platform: "hepsiburada", commissionRate: null, commissionFixed: null, cargoCost: null },
              },
            },
          ],
          commissionRules: [],
          cargoRules: [
            { id: "k", name: "HB", platform: "hepsiburada", categoryName: null, cargoProvider: null, minPrice: 0, maxPrice: 1e6, minDesi: 0, maxDesi: 999, cargoCost: kargoKurali, validFrom: null, validTo: null, priority: 1, isActive: true } as never,
          ],
          expenseRules: [],
          settings: { vatRate: "20" },
          orderedAt: new Date("2026-11-19T10:00:00Z"),
          orderFee: hbHizmetBedeli([h]),
        },
        {
          statusKind: "delivered",
          financial: {
            actualCommission: g.commission, settlementRevenue: g.grossRevenue,
            actualOrderFee: g.serviceFee, actualPaymentFee: g.paymentFee, actualCargo: g.cargo,
          },
        }
      ),
    };
  }

  it("4845254772: tahmini kargo 94,20 yerine gerçek 52,79; kesintiler + stopaj düşülünce net 119,93", () => {
    const { r, g } = hesapla({ commissionRate: 10, commission: tl(20), vatRate: 20, dispatchTime: 1 }, 199.99, SIPARIS_A);
    expect(r.profitSource).toBe("platform");
    expect(r.actualCargo).toBe(52.79);
    expect(r.cargoCost).toBe(52.79);
    expect(r.actualPaymentFee).toBe(1.6);
    expect(r.actualOrderFee).toBe(0);
    const net = 199.99 - r.actualCommission! - r.fixedExpense - r.paymentFee - r.cargoCost - g.stoppage;
    expect(net).toBeCloseTo(119.93, 2);
    // Kâr (ürün maliyeti 0): KDV hariç gelir − kesintilerin KDV'siz hâli. Stopaj kâra girmez.
    expect(r.profit).toBeCloseTo(199.99 / 1.2 - (24 + 1.6 + 52.79) * (5 / 6), 2);
  });

  it("4646588099: hizmet bedeli tahmini (13,19) ile gerçeği aynı; KDV %10; net 161,33", () => {
    const { r, g } = hesapla({ commissionRate: 22, commission: tl(83.59999), vatRate: 10, dispatchTime: 2 }, 379.99, SIPARIS_B);
    expect(r.fixedExpense).toBe(13.19);
    expect(r.actualOrderFee).toBe(13.19);
    const net = 379.99 - r.actualCommission! - r.fixedExpense - r.paymentFee - r.cargoCost - g.stoppage;
    expect(net).toBeCloseTo(161.33, 2);
    expect(r.profit).toBeCloseTo(379.99 / 1.1 - (100.32 + 13.19 + 3.31 + 98.39) * (5 / 6), 2);
  });

  it("kargo kaydı henüz yoksa kargo TAHMİNDE kalır, diğer kalemler gerçek olur", () => {
    const { r } = hesapla(
      { commissionRate: 22, commission: tl(110), vatRate: 20, hbDiscount: { unitPrice: tl(49.99), totalPrice: tl(49.99) } },
      450,
      SIPARIS_C
    );
    expect(r.profitSource).toBe("platform");
    expect(r.actualCargo).toBeNull();
    expect(r.cargoCost).toBe(94.2);
    expect(r.actualCommission).toBe(132);
  });

  it("ciro tutmuyorsa (kısmi teslim) gerçek kayıt UYGULANMAZ, tahmin aynen kalır", () => {
    const yarim = SIPARIS_A.map((k) => (k.transactionType === "Payment" ? { ...k, amount: { value: 99.99, currencyCode: "949" } } : k));
    const { r } = hesapla({ commissionRate: 10, commission: tl(20), vatRate: 20, dispatchTime: 1 }, 199.99, yarim);
    expect(r.profitSource).toBe("calculated");
    expect(r.actualCargo).toBeNull();
    expect(r.cargoCost).toBe(94.2);
  });

  it("gerçek kalem verilmeyince (Trendyol gibi) eski davranış birebir: yalnız komisyon değişir", () => {
    const h = hbKalemHesabi({ commissionRate: 10, vatRate: 20 }, 1, 199.99);
    const girdi = {
      platform: "trendyol", orderTotal: 199.99,
      lines: [{ unitPrice: 199.99, quantity: 1, product: { id: "p", name: "Ü", categoryName: "G", desi: 1, commissionRate: 0.2, productionCost: 10, packagingCost: 0, packagingComponents: null, filamentCost: 0, productionCostKnown: true, listing: null } }],
      commissionRules: [], cargoRules: [], expenseRules: [], settings: { vatRate: "20" },
    };
    const r = resolveOrderProfit(girdi, { financial: { actualCommission: 30, settlementRevenue: 199.99 } });
    expect(r.actualOrderFee).toBeNull();
    expect(r.actualPaymentFee).toBeNull();
    expect(r.actualCargo).toBeNull();
    expect(r.profit).toBeCloseTo(199.99 / 1.2 - 10 - 30 * (5 / 6), 6);
    expect(h.unitPrice).toBe(199.99);
  });
});

/**
 * SATIŞ ÖNCESİ kâr için ilan bilgileri: kargoya verme süresi ilan servisinden, satış KDV oranı
 * muhasebe kayıtlarından öğrenilir ve `Listing`'e yalnız DEĞİŞEN satır yazılır.
 */
describe("ilan bilgileri (kargoya verme süresi + KDV oranı)", () => {
  it("hbUrunKdvOranlari ödeme kaydından oranı çıkarır; aynı üründe en son kayıt kazanır", async () => {
    const { hbUrunKdvOranlari } = await import("./hepsiburada-finance");
    const oranlar = hbUrunKdvOranlari([
      kayit("1", "Payment", 199.99, { sku: "HB-A", taxAmount: { value: 33.33 } }),
      kayit("2", "Payment", 379.99, { sku: "HB-B", taxAmount: { value: 34.54 } }),
      // Aynı ürün daha sonra %20 ile faturalanmış → güncel oran o.
      kayit("3", "Payment", 379.99, { sku: "HB-B", taxAmount: { value: 63.33 }, invoiceDate: "2026-11-22T00:00:00" }),
      kayit("4", "Commission", -24, { sku: "HB-A", taxAmount: { value: -4 } }),
      kayit("5", "Payment", 100, { sku: "", taxAmount: { value: 10 } }),
    ]);
    expect(Object.fromEntries(oranlar)).toEqual({ "HB-A": 20, "HB-B": 20 });
    expect(hbUrunKdvOranlari([kayit("2", "Payment", 379.99, { sku: "HB-B", taxAmount: { value: 34.54 } })]).get("HB-B")).toBe(10);
  });

  it("hbIlanGuncellemeIfadeleri yalnız değişen ilanı yazar; bilinmeyen bilineni silmez", async () => {
    const { hbIlanGuncellemeIfadeleri } = await import("./hepsiburada-finance");
    const ilanlar = [
      { id: "l1", externalId: "HB-A", externalSku: "SKU-A", dispatchDays: null, vatRate: null },
      { id: "l2", externalId: "HB-B", externalSku: "SKU-B", dispatchDays: 2, vatRate: 10 },
      { id: "l3", externalId: "HB-C", externalSku: "SKU-C", dispatchDays: 1, vatRate: 20 },
      { id: "l4", externalId: null, externalSku: "SKU-D", dispatchDays: null, vatRate: null },
    ];
    const ifadeler = hbIlanGuncellemeIfadeleri(
      ilanlar,
      { bySku: new Map([["HB-A", 1], ["HB-B", 2]]), byMerchantSku: new Map([["SKU-D", 3]]) },
      new Map([["HB-A", 20]])
    );
    // l1: iki alan da ilk kez doluyor · l2: aynı → yazılmaz · l3: yeni bilgi yok → korunur, yazılmaz
    // l4: ürün numarası yok, satıcı stok koduyla eşleşir.
    expect(ifadeler.map((i) => i.args)).toEqual([
      [1, 20, "l1"],
      [3, null, "l4"],
    ]);
    expect(ifadeler[0].sql).not.toContain("updatedAt");
  });
});
