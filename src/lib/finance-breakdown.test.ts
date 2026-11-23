import { describe, expect, it, vi } from "vitest";

// Saf toplama testi — veritabanı açılmaz.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/order-finance-snapshots", () => ({ recalculateFinanceMonths: async () => ({}) }));

const { karDokumuTopla } = await import("./finance-breakdown");
type Siparis = Parameters<typeof karDokumuTopla>[1][number];

const motor = (ek: Partial<NonNullable<Siparis["sonuc"]>> = {}): NonNullable<Siparis["sonuc"]> => ({
  profit: 100,
  unmatchedRevenue: 0,
  estimatedCommission: 60,
  actualCommission: null,
  cargoCost: 50,
  actualCargo: null,
  productAndPackagingCost: 120,
  fixedExpense: 10,
  actualOrderFee: null,
  paymentFee: 0,
  actualPaymentFee: null,
  internationalFee: 0,
  adCost: 0,
  penalty: 0,
  outputVat: 66.67,
  inputVatCredit: 26.67,
  ...ek,
});

const toplamKesinti = (d: ReturnType<typeof karDokumuTopla>) => d.lines.reduce((t, l) => t + l.amount, 0);

describe("kâr dökümü (Kâr nereye gitti)", () => {
  it("ciro − maliyeti bilinmeyen − kesintiler = kayıtlı sipariş kârı (her zaman kapanır)", () => {
    const d = karDokumuTopla("2026-10", [
      { statusKind: "delivered", currency: "TRY", revenueKurus: 40000, profitKurus: 10000, sonuc: motor() },
      // Gerçek komisyon ve kargo tahminin yerine geçer.
      {
        statusKind: "delivered",
        currency: "TRY",
        revenueKurus: 50000,
        profitKurus: 15000,
        sonuc: motor({ actualCommission: 80, actualCargo: 42.5, profit: 150 }),
      },
    ]);
    expect(d.revenue).toBe(900);
    expect(d.orderProfitBeforeReturns).toBe(250);
    expect(d.revenue - d.unknownCostRevenue - toplamKesinti(d)).toBeCloseTo(250, 2);
    expect(d.lines.find((l) => l.key === "komisyon")?.amount).toBe(140);
    expect(d.lines.find((l) => l.key === "kargo")?.amount).toBe(92.5);
    expect(d.orderCount).toBe(2);
  });

  it("iptal ve TL dışı siparişler hiçbir kaleme girmez", () => {
    const d = karDokumuTopla("2026-10", [
      { statusKind: "cancelled", currency: "TRY", revenueKurus: 99900, profitKurus: 5000, sonuc: motor() },
      { statusKind: "delivered", currency: "USD", revenueKurus: 99900, profitKurus: 5000, sonuc: motor() },
    ]);
    expect(d).toMatchObject({ revenue: 0, orderProfitBeforeReturns: 0, orderCount: 0, lines: [] });
  });

  it("kârı bilinmeyen sipariş ve kısmi siparişin maliyetsiz satırı 'maliyeti girilmemiş' sayılır", () => {
    const d = karDokumuTopla("2026-11", [
      { statusKind: "delivered", currency: "TRY", revenueKurus: 30000, profitKurus: null, sonuc: motor({ profit: null }) },
      { statusKind: "delivered", currency: "TRY", revenueKurus: 50000, profitKurus: 9000, sonuc: motor({ unmatchedRevenue: 100, profit: 90 }) },
    ]);
    expect(d.unknownCostRevenue).toBe(400);
    expect(d.revenue - d.unknownCostRevenue - toplamKesinti(d)).toBeCloseTo(90, 2);
  });

  it("kalem geçmişi olmayan sipariş tek satırda (dökümü olmayan)", () => {
    const d = karDokumuTopla("2026-06", [
      { statusKind: "delivered", currency: "TRY", revenueKurus: 20000, profitKurus: 6000, sonuc: null },
    ]);
    expect(d.lines).toEqual([{ key: "dokumsuz", label: "Dökümü olmayan siparişler", amount: 140 }]);
  });

  it("elle siparişin kayıtlı dökümü kalemlere dağılır", () => {
    const d = karDokumuTopla(
      "2026-10",
      [],
      [
        {
          statusKind: "delivered",
          currency: "TRY",
          revenueKurus: 120000,
          profitKurus: 50000,
          dokum: {
            productCost: 300,
            packagingCost: 20,
            commissionCost: 0,
            cargoCost: 100,
            expenseRulesCost: 0,
            customExpensesCost: 30,
            outputVat: 200,
            inputVatCredit: 50,
          },
        },
      ]
    );
    expect(d.lines.find((l) => l.key === "urun")?.amount).toBe(320);
    expect(d.lines.find((l) => l.key === "kdv")?.amount).toBe(150);
    expect(d.revenue - toplamKesinti(d)).toBeCloseTo(500, 2);
  });

  it("1 TL altı 'diğer' (yuvarlama) gösterilmez", () => {
    const d = karDokumuTopla("2026-11", [
      { statusKind: "delivered", currency: "TRY", revenueKurus: 40000, profitKurus: 10000, sonuc: motor({ productAndPackagingCost: 139.94 }) },
    ]);
    expect(d.lines.some((l) => l.key === "diger")).toBe(false);
  });

  it("satırlar büyükten küçüğe, sıfır olanlar yok", () => {
    const d = karDokumuTopla("2026-10", [
      { statusKind: "delivered", currency: "TRY", revenueKurus: 40000, profitKurus: 10000, sonuc: motor() },
    ]);
    const tutarlar = d.lines.map((l) => l.amount);
    expect(tutarlar).toEqual([...tutarlar].sort((a, b) => b - a));
    expect(d.lines.some((l) => l.key === "reklam" || l.key === "ceza")).toBe(false);
  });
});
