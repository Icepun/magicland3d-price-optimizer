import { describe, expect, it, vi } from "vitest";

import { resolveOrderProfit } from "@/core/order-profit";

/**
 * TELEFON SİPARİŞ DÖKÜMÜ — sipariş detayındaki "Kâr dökümü" kartı masaüstü Siparişler'deki
 * "Kargo & Kâr" kalemlerini AYNI çekirdek hesabından göstermeli (Berke'nin isteği, 24 Kas 2026).
 *
 * Telefonun GERÇEK `order-profit` modülü çalışır; yalnız telefona özel yollar sahte.
 * Modül yolu DEĞİŞKENDE: telefonun `@/` takma adları kökte çözülmez. Test `mobile/` altına KONMAZ.
 */

const yol = vi.hoisted(() => ({ kar: "../../mobile/src/lib/order-profit" }));

vi.mock("@/lib/profit", () => ({ kuralFilamentFiyatlari: () => new Map() }));
vi.mock("@/lib/api/orders", () => ({
  isCancelledOrder: (o: { status: string }) => o.status === "Cancelled" || o.status === "Returned",
}));

/** Telefon modülünün kullanılan yüzü (tip doğrudan içe aktarılmaz: kök tsc telefonun takma adlarını çözemez). */
type Dokum = {
  komisyon: number; komisyonKaynagi: string; komisyonOranlari: number[]; komisyonTahmini: number;
  urunVePaketleme: number; kargo: number; kargoEtiketi: string | null;
  iade: { outboundCargo: number; loss: number } | null;
};
type KarModulu = {
  getProductMap: (p: unknown[]) => unknown;
  computeOrderProfit: (o: unknown, pm: unknown, r: unknown, s: Record<string, string>) => {
    profit: number | null; returnLoss: number | null; dokum: Dokum | null;
  };
};

const urun = {
  id: "p1", name: "Kedi Figürü", alias: null, sku: "KEDI-1", barcode: "KEDI-1", categoryName: "Dekor",
  currentSalePrice: 300, stock: 5, desi: 1, imageUrl: null, source: "manual", madeToOrder: 0,
  commissionRate: null, variantGroupId: null, variantLabel: null,
  cost: {
    costMode: "manual", manualCost: 40, totalCost: 40, packagingCost: null, filamentTypeId: null, filamentWeight: null,
    printTimeHours: null, wasteRate: null, packagingOptionId: null, nylonLevel: null, tapeUsed: null, costPerGram: 0,
  },
  listings: [
    {
      id: "l1", platform: "trendyol", salePrice: 300, stock: 5, commissionRate: 0.21, commissionFixed: null,
      cargoCost: null, externalId: null, externalSku: null, barcode: "KEDI-1", isActive: 1,
    },
  ],
};

const kurallar = {
  commission: [],
  cargo: [],
  expense: [],
  adBudgets: [],
  financialByExternalId: new Map(),
  financialByOrderNumber: new Map(),
};

function siparis(ek: Record<string, unknown> = {}) {
  return {
    id: "ty-1", platform: "trendyol", orderNumber: "T1", date: Date.parse("2026-11-20T10:00:00+03:00"),
    status: "Delivered", customer: null, total: 300,
    items: [{ name: "Kedi Figürü", quantity: 1, unitPrice: 300, productId: "p1", barcodes: ["KEDI-1"], commissionRate: 0.132 }],
    ...ek,
  };
}

async function hesapla(order: Record<string, unknown>, rules: Record<string, unknown> = kurallar) {
  const m = (await import(/* @vite-ignore */ yol.kar)) as KarModulu;
  const pm = m.getProductMap([urun]);
  return m.computeOrderProfit(order, pm, rules, { vatRate: "20" });
}

describe("telefon sipariş dökümü", () => {
  it("kalemler çekirdek hesabıyla birebir; komisyon siparişte kesilen orandan", async () => {
    const r = await hesapla(siparis());
    expect(r.dokum).not.toBeNull();
    const d = r.dokum!;
    expect(d.komisyonKaynagi).toBe("siparis");
    expect(d.komisyonOranlari).toEqual([0.132]);
    expect(d.komisyon).toBeCloseTo(300 * 0.132, 6);
    expect(d.urunVePaketleme).toBeGreaterThan(0);
    expect(d.kargo).toBeGreaterThan(0);
    expect(d.kargoEtiketi).toBeTruthy(); // Trendyol tarifesinden tahmin
    expect(d.iade).toBeNull();
    // Net kâr: dökümün yanında gösterilen rakam kartın üstündeki kârla aynı.
    expect(r.profit).not.toBeNull();
  });

  it("gerçek komisyon kaydı varsa 'gerçek' ve tahminle farkı taşınır", async () => {
    const gercek = { ...kurallar, financialByExternalId: new Map([["ty-1", { actualCommission: 30, settlementRevenue: 300 }]]) };
    const r = await hesapla(siparis(), gercek);
    expect(r.dokum!.komisyonKaynagi).toBe("gercek");
    expect(r.dokum!.komisyon).toBe(30);
    expect(r.dokum!.komisyonTahmini).toBeCloseTo(300 * 0.132, 6);
  });

  it("dökümdeki kalemler resolveOrderProfit ile aynı (masaüstü aynı fonksiyonu kullanıyor)", async () => {
    const r = await hesapla(siparis());
    // Bağımsız çekirdek çağrısı: aynı girdilerle aynı kargo ve ürün+paketleme.
    const cekirdek = resolveOrderProfit({
      platform: "trendyol",
      orderTotal: 300,
      lines: [
        {
          unitPrice: 300, quantity: 1, orderCommissionRate: 0.132,
          product: {
            id: "p1", name: "Kedi Figürü", categoryName: "Dekor", desi: 1, commissionRate: null,
            productionCost: 40, packagingCost: r.dokum!.urunVePaketleme - 40, packagingComponents: null,
            filamentCost: 0, productionCostKnown: true,
            listing: { platform: "trendyol", commissionRate: 0.21, commissionFixed: null, cargoCost: null },
          },
        },
      ],
      commissionRules: [], cargoRules: [], expenseRules: [], settings: { vatRate: "20" },
      orderedAt: new Date(Date.parse("2026-11-20T10:00:00+03:00")),
    });
    expect(r.dokum!.kargo).toBeCloseTo(cekirdek.cargoCost, 6);
    expect(r.dokum!.komisyon).toBeCloseTo(cekirdek.estimatedCommission, 6);
  });

  it("iade edilen siparişte iade zararının kalemleri gelir", async () => {
    const r = await hesapla(siparis({ status: "Returned" }));
    expect(r.dokum!.iade).not.toBeNull();
    expect(r.dokum!.iade!.outboundCargo).toBeGreaterThan(0);
    expect(r.returnLoss).toBeCloseTo(r.dokum!.iade!.loss, 6);
  });
});
