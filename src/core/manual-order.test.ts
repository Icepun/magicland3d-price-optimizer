import { describe, expect, it } from "vitest";
import {
  calculateManualOrder,
  type ManualOrderCalculationInput,
} from "./manual-order";

function base(
  over: Partial<ManualOrderCalculationInput> = {}
): ManualOrderCalculationInput {
  return {
    saleTotal: 1_200,
    vatRate: 20,
    mode: "catalog",
    includeProductCost: true,
    includePackaging: true,
    items: [
      {
        id: "line-1",
        productId: "product-1",
        name: "Ürün",
        imageUrl: null,
        quantity: 2,
        costKnown: true,
        productionCost: 100,
        packagingCost: 30,
        filamentCost: 40,
        packagingComponents: [
          { key: "option", scope: "per_shipment", cost: 20 },
          { key: "card", scope: "per_order", cost: 10 },
        ],
      },
    ],
    commission: { amount: 120, hasVatInvoice: true },
    cargo: { amount: 60, hasVatInvoice: false },
    expenseRules: [],
    customExpenses: [],
    ...over,
  };
}

describe("manual order calculation", () => {
  it("ürün, paketleme kapsamı ve seçili dış gider KDV'sini hesaplar", () => {
    const result = calculateManualOrder(base());
    expect(result).toMatchObject({
      grossRevenue: 1_200,
      netRevenue: 1_000,
      outputVat: 200,
      productCost: 200,
      packagingCost: 30,
      commissionCost: 120,
      cargoCost: 60,
      totalCost: 410,
      profitPartial: false,
      missingCostItems: 0,
    });
    // Filament 80 + paket 30 + faturalı komisyon 120 = 230; iç KDV = 230 / 6.
    expect(result.inputVatCredit).toBeCloseTo(230 / 6, 8);
    expect(result.netProfit).toBeCloseTo(1_000 - 410 + 230 / 6, 8);
  });

  it("aynı ortak paketleme bileşenini siparişte bir kez ve pahalı değeriyle uygular", () => {
    const first = base().items[0];
    const result = calculateManualOrder(
      base({
        items: [
          first,
          {
            ...first,
            id: "line-2",
            productId: "product-2",
            quantity: 3,
            packagingComponents: [
              { key: "option", scope: "per_shipment", cost: 25 },
              { key: "card", scope: "per_order", cost: 8 },
              { key: "nylon", scope: "per_unit", cost: 2 },
            ],
          },
        ],
      })
    );
    // option max 25 + card max 10 + nylon 2*3
    expect(result.packagingCost).toBeCloseTo(41, 8);
  });

  it("freeform maliyet eksikse kârı null ve kısmi döndürür", () => {
    const result = calculateManualOrder(
      base({
        mode: "freeform",
        includePackaging: false,
        items: [
          {
            id: "free-1",
            productId: null,
            name: "Özel baskı",
            imageUrl: null,
            quantity: 2,
            costKnown: false,
            productionCost: 0,
            packagingCost: 0,
            filamentCost: 0,
            manualUnitCost: null,
          },
        ],
      })
    );
    expect(result.netProfit).toBeNull();
    expect(result.profitPartial).toBe(true);
    expect(result.missingCostItems).toBe(1);
  });

  it("maliyet bilinçli hariç tutulduysa gerçek sıfır kabul edip tam hesaplar", () => {
    const result = calculateManualOrder(
      base({
        mode: "freeform",
        includeProductCost: false,
        includePackaging: false,
        items: [
          {
            id: "free-1",
            productId: null,
            name: "Hizmet",
            imageUrl: null,
            quantity: 1,
            costKnown: false,
            productionCost: 0,
            packagingCost: 0,
            filamentCost: 0,
            manualUnitCost: null,
          },
        ],
        commission: { amount: 0, hasVatInvoice: false },
        cargo: { amount: 0, hasVatInvoice: false },
      })
    );
    expect(result.netProfit).toBe(1_000);
    expect(result.profitPartial).toBe(false);
  });

  it("freeform maliyet faturası seçildiyse iç KDV'yi indirir", () => {
    const result = calculateManualOrder(
      base({
        mode: "freeform",
        includePackaging: false,
        items: [
          {
            id: "free-1",
            productId: null,
            name: "Özel baskı",
            imageUrl: null,
            quantity: 2,
            costKnown: true,
            productionCost: 0,
            packagingCost: 0,
            filamentCost: 0,
            manualUnitCost: 120,
            manualCostHasVatInvoice: true,
          },
        ],
        commission: { amount: 0, hasVatInvoice: false },
        cargo: { amount: 0, hasVatInvoice: false },
      })
    );
    expect(result.productCost).toBe(240);
    expect(result.inputVatCredit).toBe(40);
    expect(result.netProfit).toBe(800);
  });

  it("seçili yüzde kuralını cirodan, sabit ve özel giderleri bir kez hesaplar", () => {
    const result = calculateManualOrder(
      base({
        expenseRules: [
          {
            id: "percentage",
            name: "Tahsilat",
            type: "percentage",
            value: 0.1,
            hasVatInvoice: true,
          },
          {
            id: "fixed",
            name: "Sabit",
            type: "per_order",
            value: 15,
            hasVatInvoice: false,
          },
        ],
        customExpenses: [
          {
            id: "custom",
            name: "Ek gider",
            amount: 25,
            hasVatInvoice: true,
          },
        ],
      })
    );
    expect(result.expenseRulesCost).toBe(135);
    expect(result.customExpensesCost).toBe(25);
    // Ek faturalı gider KDV tabanı: yüzde 120 + custom 25.
    expect(result.inputVatCredit).toBeCloseTo((230 + 145) / 6, 8);
  });
});
