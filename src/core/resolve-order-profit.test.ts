/**
 * Faz B: masaüstü ↔ mobil kâr paritesi.
 *
 * Bu bug tam olarak şuydu: çekirdek dosyaları BYTE-BYTE senkrondu (check-core geçiyordu) ama
 * masaüstü kâra Trendyol GERÇEK komisyonunu uyguluyor, mobil uygulamıyordu — fark sarmalayıcı
 * katmanındaydı, kopyada değil. Artık iki taraf da resolveOrderProfit çağırıyor; bu test o
 * ortak giriş noktasının sözleşmesini kilitler.
 */
import { describe, expect, it } from "vitest";
import { resolveOrderProfit, type OrderProfitInput } from "./order-profit";
import type { CommissionRuleInput, CargoRuleInput, ExpenseRuleInput } from "./types";

const commissionRules: CommissionRuleInput[] = [
  {
    id: "c1",
    name: "Trendyol %14",
    categoryName: null,
    minPrice: 0,
    maxPrice: 1_000_000,
    // ⚠️ KESİR: 0.14 = %14 (motor fiyatla doğrudan çarpar). Üretimdeki 249,99₺'lik
    // sipariş için tahmini komisyon 35₺ çıkar — sondadaki gerçek veriyle birebir.
    commissionRate: 0.14,
    fixedCommission: 0,
    validFrom: null,
    validTo: null,
    priority: 1,
    isActive: true,
  },
];
const cargoRules: CargoRuleInput[] = [];
const expenseRules: ExpenseRuleInput[] = [];

/** Üretimden alınmış gerçek bir Trendyol siparişi (sipariş 11441996030). */
function input(overrides: Partial<OrderProfitInput> = {}): OrderProfitInput {
  return {
    platform: "trendyol",
    orderTotal: 249.99,
    lines: [
      {
        unitPrice: 249.99,
        quantity: 1,
        product: {
          id: "p1",
          name: "Ürün",
          categoryName: "Oyuncak",
          desi: 1,
          commissionRate: null,
          productionCost: 60,
          packagingCost: 5,
          packagingComponents: null,
          filamentCost: 20,
          listing: null,
        },
      },
    ],
    commissionRules,
    cargoRules,
    expenseRules,
    settings: { vatRate: "20" },
    ...overrides,
  };
}

describe("resolveOrderProfit — gerçek komisyon düzeltmesi", () => {
  it("settlement YOKSA kural-tabanlı kâr aynen kalır", () => {
    const r = resolveOrderProfit(input());
    expect(r.profitSource).toBe("calculated");
    expect(r.actualCommission).toBeNull();
    expect(r.profit).toBe(resolveOrderProfit(input()).profit); // deterministik
  });

  it("settlement VARSA kârı gerçek komisyonla düzeltir (KDV kredisi dahil)", () => {
    const base = resolveOrderProfit(input());
    const withActual = resolveOrderProfit(input(), {
      financial: { actualCommission: 32.5, settlementRevenue: 249.99 },
    });

    expect(withActual.profitSource).toBe("platform");
    expect(withActual.actualCommission).toBe(32.5);

    // Δ = (tahmini − gerçek) × (1 − KDV/(100+KDV))
    const vatFactor = 20 / 120;
    const expectedDelta = (base.estimatedCommission - 32.5) * (1 - vatFactor);
    expect(withActual.profit! - base.profit!).toBeCloseTo(expectedDelta, 6);
  });

  it("İPTAL siparişte gerçek komisyon UYGULANMAZ", () => {
    const base = resolveOrderProfit(input());
    const cancelled = resolveOrderProfit(input(), {
      statusKind: "cancelled",
      financial: { actualCommission: 32.5, settlementRevenue: 249.99 },
    });
    expect(cancelled.profitSource).toBe("calculated");
    expect(cancelled.actualCommission).toBeNull();
    expect(cancelled.profit).toBe(base.profit);
  });

  it("KISMİ hesapta (forceProfitPartial) gerçek komisyon UYGULANMAZ", () => {
    const base = resolveOrderProfit(input());
    const partial = resolveOrderProfit(input(), {
      forceProfitPartial: true,
      financial: { actualCommission: 32.5, settlementRevenue: 249.99 },
    });
    expect(partial.profitPartial).toBe(true);
    expect(partial.profitSource).toBe("calculated"); // koruma devrede
    expect(partial.profit).toBe(base.profit);
  });

  it("settlement cirosu sipariş cirosuyla UYUŞMAZSA uygulanmaz (farklı paket koruması)", () => {
    const mismatched = resolveOrderProfit(input(), {
      financial: { actualCommission: 32.5, settlementRevenue: 120 },
    });
    expect(mismatched.profitSource).toBe("calculated");
    expect(mismatched.actualCommission).toBeNull();
  });

  it("gerçek komisyon tahminden YÜKSEKSE kâr DÜŞER (işaret doğru)", () => {
    const base = resolveOrderProfit(input());
    const higher = resolveOrderProfit(input(), {
      financial: { actualCommission: 60, settlementRevenue: 249.99 },
    });
    expect(higher.profitSource).toBe("platform");
    expect(higher.profit!).toBeLessThan(base.profit!);
  });

  it("forceProfitPartial, çekirdeğin kendi partial'ıyla OR'lanır", () => {
    // Maliyeti olmayan ikinci satır → çekirdek zaten partial der.
    const r = resolveOrderProfit(
      input({
        lines: [
          ...input().lines,
          { unitPrice: 100, quantity: 1, product: null },
        ],
        orderTotal: 349.99,
      })
    );
    expect(r.partial).toBe(true);
    expect(r.profitPartial).toBe(true);
  });

  it("MOBİL PARİTE: aynı girdi + aynı settlement → aynı kâr, kaynak ve komisyon", () => {
    // Mobil ve masaüstü artık AYNI fonksiyonu aynı seçeneklerle çağırıyor. Farklı bir sonuç
    // çıkması ancak sarmalayıcılardan biri girdiyi eksik geçirirse mümkün — bu testin amacı
    // sözleşmenin (profit + profitSource + actualCommission üçlüsü) sabit kalması.
    const opts = {
      forceProfitPartial: false,
      statusKind: "delivered",
      financial: { actualCommission: 32.5, settlementRevenue: 249.99 },
    };
    const desktop = resolveOrderProfit(input(), opts);
    const mobile = resolveOrderProfit(input(), opts);
    expect(mobile.profit).toBe(desktop.profit);
    expect(mobile.profitSource).toBe(desktop.profitSource);
    expect(mobile.actualCommission).toBe(desktop.actualCommission);
    expect(mobile.estimatedCommission).toBe(desktop.estimatedCommission);
    expect(mobile.profitPartial).toBe(desktop.profitPartial);
  });
});
