import { describe, it, expect } from "vitest";
import { computeOrderProfit, type OrderProfitProduct, type OrderProfitLine } from "./order-profit";
import type { CargoRuleInput, ExpenseRuleInput } from "./types";

/**
 * SİPARİŞ KÂRI regresyon + düzeltme testleri (gerçek ürün verisi: Samuray GPU tutucu).
 *
 * ASIL DÜZELTME: SABİT gider (Platform Hizmet Bedeli) siparişe BİR KEZ — eskiden her FARKLI
 * üründe tekrar kesiliyordu (aynı üründen N adet ise bir kez → tutarsız).
 */
const SETTINGS = { vatRate: "20" };

const BASE: Omit<OrderProfitProduct, "id" | "name"> = {
  categoryName: "Dekor & Figür",
  desi: 1,
  commissionRate: null,
  productionCost: 23.265,
  packagingCost: 10.65,
  filamentCost: 11.65,
  listing: { platform: "trendyol", commissionRate: 0.21, commissionFixed: null, cargoCost: null },
};
const prod = (id: string, over: Partial<OrderProfitProduct> = {}): OrderProfitProduct =>
  ({ ...BASE, id, name: id, ...over });

const FIXED_13_19: ExpenseRuleInput[] = [
  { id: "e1", name: "Platform Hizmet Bedeli", platform: "trendyol", type: "fixed", value: 13.19,
    categoryName: null, minPrice: 0, maxPrice: 999999, priority: 10, isActive: true },
];
const CARGO_34: CargoRuleInput[] = [
  { id: "c1", name: "TEX", platform: "trendyol", cargoProvider: null, categoryName: null,
    minPrice: 0, maxPrice: 999999, minDesi: 0, maxDesi: 2, cargoCost: 34.16, priority: 10, isActive: true } as CargoRuleInput,
];

const P = 199.99;
const LINE = 101.46175;             // paketleme KDV iadesi dahil satır kârı (qty 1, kargosuz)
const FIX_NET = 13.19 * (5 / 6);    // 10,9917 — sabit giderin KDV sonrası net etkisi
const CARGO_NET = 34.16 * (5 / 6);  // 28,4667

function run(lines: OrderProfitLine[], opts: { cargo?: CargoRuleInput[]; expense?: ExpenseRuleInput[]; total?: number } = {}) {
  return computeOrderProfit({
    platform: "trendyol",
    orderTotal: opts.total ?? lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0),
    lines,
    commissionRules: [],
    cargoRules: opts.cargo ?? [],
    expenseRules: opts.expense ?? FIXED_13_19,
    settings: SETTINGS,
  });
}

describe("sipariş kârı — kapsam kuralları", () => {
  it("T1 · 1 ürün × 1 adet (kargosuz) — REGRESYON: bugünkü değer", () => {
    expect(run([{ unitPrice: P, quantity: 1, product: prod("a") }]).profit).toBeCloseTo(90.4701, 2);
  });

  it("T1b · + kargo 34,16 → Ürünler ekranıyla PARİTE (₺60,23)", () => {
    const r = run([{ unitPrice: P, quantity: 1, product: prod("a") }], { cargo: CARGO_34 });
    expect(r.profit).toBeCloseTo(62.0034, 2);
  });

  it("T2 · 1 ürün × 3 adet — hizmet bedeli BİR KEZ (değer değişmedi)", () => {
    const r = run([{ unitPrice: P, quantity: 3, product: prod("a") }]);
    expect(r.profit).toBeCloseTo(3 * LINE - FIX_NET, 2); // 288,069
  });

  it("T3 · 3 FARKLI ürün × 1 adet — ASIL DÜZELTME: hizmet bedeli BİR KEZ", () => {
    const r = run([
      { unitPrice: P, quantity: 1, product: prod("a") },
      { unitPrice: P, quantity: 1, product: prod("b") },
      { unitPrice: P, quantity: 1, product: prod("c") },
    ]);
    expect(r.profit).toBeCloseTo(3 * LINE - FIX_NET, 2); // 288,069
  });

  it("T3b · eski davranışa göre fark = +2×sabit gider (hatanın imzası)", () => {
    const yeni = run([
      { unitPrice: P, quantity: 1, product: prod("a") },
      { unitPrice: P, quantity: 1, product: prod("b") },
      { unitPrice: P, quantity: 1, product: prod("c") },
    ]).profit!;
    const eski = 3 * (LINE - FIX_NET); // her satırda tekrar kesilen hali
    expect(yeni - eski).toBeCloseTo(2 * FIX_NET, 2); // +21,983
  });

  it("T4 · '3 adet' ile '3 farklı ürün' artık TUTARLI", () => {
    const cok = run([{ unitPrice: P, quantity: 3, product: prod("a") }]).profit!;
    const farkli = run([
      { unitPrice: P, quantity: 1, product: prod("a") },
      { unitPrice: P, quantity: 1, product: prod("b") },
      { unitPrice: P, quantity: 1, product: prod("c") },
    ]).profit!;
    expect(cok).toBeCloseTo(farkli, 6);
  });

  it("T5 · eşleşmeyen satır: kısmi kâr + desi TAHMİN edilir (kargo ucuz seçilmez)", () => {
    const cargo2: CargoRuleInput[] = [
      { ...CARGO_34[0], id: "c1", minDesi: 0, maxDesi: 2, cargoCost: 34.16 } as CargoRuleInput,
      { ...CARGO_34[0], id: "c2", minDesi: 3, maxDesi: 5, cargoCost: 60 } as CargoRuleInput,
    ];
    const r = run(
      [
        { unitPrice: P, quantity: 1, product: prod("a") },
        { unitPrice: 150, quantity: 2, product: null }, // maliyeti girilmemiş
      ],
      { cargo: cargo2 }
    );
    expect(r.partial).toBe(true);
    expect(r.unmatchedLines).toBe(1);
    expect(r.unmatchedRevenue).toBeCloseTo(300, 2);
    expect(r.desiEstimated).toBe(true);
    // desi 1 (eşleşen) + tahmin 2 = 3 → PAHALI barem (60) seçilmeli
    expect(r.profit).toBeCloseTo(LINE - FIX_NET - 60 * (1 / 6) * 5, 1);
  });

  it("T5b · desi eksikse 1 desiyle hesaplar ve sonucu açıkça işaretler", () => {
    const r = run([
      { unitPrice: P, quantity: 2, product: prod("a", { desi: null }) },
    ]);
    expect(r.profit).not.toBeNull();
    expect(r.desiEstimated).toBe(true);
    expect(r.missingDesiLines).toBe(1);
    expect(r.missingDesiQty).toBe(2);
  });

  it("T6 · hiç eşleşme yok → kâr null, sabit gider UYGULANMAZ", () => {
    const r = run([{ unitPrice: 100, quantity: 1, product: null }]);
    expect(r.profit).toBeNull();
    expect(r.partial).toBe(false);
    expect(r.matchedLines).toBe(0);
  });

  it("T6b · ücretsiz promosyon satırı eşleşmişse maliyeti kârdan düşülür", () => {
    const paidOnly = run(
      [{ unitPrice: P, quantity: 2, product: prod("a") }],
      { expense: [], total: P * 2 }
    );
    const withFreeItem = run(
      [
        { unitPrice: P, quantity: 2, product: prod("a") },
        { unitPrice: 0, quantity: 1, product: prod("a") },
      ],
      { expense: [], total: P * 2 }
    );

    expect(withFreeItem.partial).toBe(false);
    expect(withFreeItem.matchedLines).toBe(2);
    expect(withFreeItem.unmatchedLines).toBe(0);
    expect(withFreeItem.unmatchedQty).toBe(0);
    // Ücretsiz ürün: 0 gelir, fakat ürün + paketleme maliyeti ve filament KDV iadesi hesaba girer.
    const freeItemNetCost =
      BASE.productionCost +
      BASE.packagingCost -
      (BASE.filamentCost + BASE.packagingCost) *
        (SETTINGS.vatRate === "20" ? 1 / 6 : 0);
    expect(withFreeItem.profit).toBeCloseTo(paidOnly.profit! - freeItemNetCost, 6);
  });

  it("T6c · ücretli + ücretsiz satır aynı paketteyse ortak paketleme bir kez düşülür", () => {
    const scoped = prod("a", {
      packagingComponents: [
        { key: "option", scope: "per_shipment", cost: 2 },
        { key: "nylon", scope: "per_shipment", cost: 5 },
        { key: "tape", scope: "per_shipment", cost: 0 },
        { key: "card", scope: "per_order", cost: 1 },
        { key: "sticker", scope: "per_order", cost: 1 },
        { key: "sakiz", scope: "per_order", cost: 1.65 },
      ],
    });
    const paidOnly = run(
      [{ unitPrice: P, quantity: 2, product: scoped }],
      { expense: [], total: P * 2 }
    );
    const withFreeItem = run(
      [
        { unitPrice: P, quantity: 2, product: scoped },
        { unitPrice: 0, quantity: 1, product: scoped },
      ],
      { expense: [], total: P * 2 }
    );

    // Ortak paket aynı kaldığı için ücretsiz ürün yalnız üretim maliyeti kadar fark yaratır
    // (filamentin iç KDV iadesi yine eklenir).
    const freeProductionNet =
      BASE.productionCost - BASE.filamentCost * (1 / 6);
    expect(withFreeItem.profit).toBeCloseTo(
      paidOnly.profit! - freeProductionNet,
      6
    );
  });

  it("T7 · tek ürünlü siparişte ELLE girilen listing kargosu kazanır", () => {
    const r = run(
      [{ unitPrice: P, quantity: 1, product: prod("a", { listing: { platform: "trendyol", commissionRate: 0.21, commissionFixed: null, cargoCost: 20 } }) }],
      { cargo: CARGO_34 }
    );
    expect(r.profit).toBeCloseTo(LINE - FIX_NET - 20 * (5 / 6), 2);
  });

  it("T7b · çok kalemli siparişte elle kargo DEĞİL, kural kazanır", () => {
    const withManual = prod("a", { listing: { platform: "trendyol", commissionRate: 0.21, commissionFixed: null, cargoCost: 20 } });
    const r = run(
      [
        { unitPrice: P, quantity: 1, product: withManual },
        { unitPrice: P, quantity: 1, product: prod("b") },
      ],
      { cargo: CARGO_34 }
    );
    expect(r.profit).toBeCloseTo(2 * LINE - FIX_NET - CARGO_NET, 2);
  });

  it("T9 · YÜZDESEL gider satır bazında kalır (her satırdan ayrı kesilir)", () => {
    const pct: ExpenseRuleInput[] = [
      { id: "p1", name: "Yüzdesel", platform: "trendyol", type: "percentage", value: 0.01,
        categoryName: null, minPrice: 0, maxPrice: 999999, priority: 10, isActive: true },
    ];
    const bir = run([{ unitPrice: P, quantity: 1, product: prod("a") }], { expense: pct }).profit!;
    const uc = run(
      [
        { unitPrice: P, quantity: 1, product: prod("a") },
        { unitPrice: P, quantity: 1, product: prod("b") },
        { unitPrice: P, quantity: 1, product: prod("c") },
      ],
      { expense: pct }
    ).profit!;
    expect(uc).toBeCloseTo(3 * bir, 4); // sabit gider yok → tam 3 katı
  });

  it("T10 · çok kategorili sipariş satır sırasından bağımsız, pahalı kargoyu seçer", () => {
    const categoryCargo: CargoRuleInput[] = [
      {
        ...CARGO_34[0],
        id: "cat-a",
        categoryName: "Kategori A",
        maxDesi: 999,
        cargoCost: 20,
      } as CargoRuleInput,
      {
        ...CARGO_34[0],
        id: "cat-b",
        categoryName: "Kategori B",
        maxDesi: 999,
        cargoCost: 50,
      } as CargoRuleInput,
    ];
    const a = { unitPrice: P, quantity: 1, product: prod("a", { categoryName: "Kategori A" }) };
    const b = { unitPrice: P, quantity: 1, product: prod("b", { categoryName: "Kategori B" }) };
    const forward = run([a, b], { cargo: categoryCargo, expense: [] }).profit!;
    const reverse = run([b, a], { cargo: categoryCargo, expense: [] }).profit!;

    expect(forward).toBeCloseTo(reverse, 8);
    expect(forward).toBeCloseTo(2 * LINE - 50 * (5 / 6), 2);
  });

  it("T11 · tek satırda çok adet varsa manuel tek-kargo yerine birleşik desi kuralı çalışır", () => {
    const withManual = prod("a", {
      listing: {
        platform: "trendyol",
        commissionRate: 0.21,
        commissionFixed: null,
        cargoCost: 20,
      },
    });
    const r = run(
      [{ unitPrice: P, quantity: 2, product: withManual }],
      { cargo: CARGO_34 }
    );

    expect(r.profit).toBeCloseTo(2 * LINE - FIX_NET - CARGO_NET, 2);
  });

  it("T12 · sipariş toplamındaki müşteri kargosu gelire ve komisyona girer", () => {
    const withoutShipping = run(
      [{ unitPrice: P, quantity: 1, product: prod("a") }],
      { expense: [], total: P }
    );
    const withShipping = run(
      [{ unitPrice: P, quantity: 1, product: prod("a") }],
      { expense: [], total: P + 90 }
    );

    // 90 TL KDV dahil kargo geliri:
    // 75 TL KDV hariç gelir - 18,90 TL komisyon + 3,15 TL komisyon KDV iadesi.
    expect(withShipping.orderRevenueAdjustment).toBeCloseTo(90, 6);
    expect(withShipping.orderRevenueAdjustmentNet).toBeCloseTo(59.25, 6);
    expect(withShipping.profit! - withoutShipping.profit!).toBeCloseTo(59.25, 6);
  });

  it("T13 · Shopify #1003: 2 ücretli + 1 ücretsiz ürün ve 90 TL müşteri kargosu", () => {
    const actualProduct = prod("dunya-kupasi", {
      categoryName: "Anahtarlık",
      desi: null,
      productionCost: 5.19,
      packagingCost: 10.65,
      filamentCost: 5.19,
      packagingComponents: [
        { key: "option", scope: "per_shipment", cost: 2 },
        { key: "nylon", scope: "per_shipment", cost: 5 },
        { key: "tape", scope: "per_shipment", cost: 0 },
        { key: "card", scope: "per_order", cost: 2 },
        { key: "sticker", scope: "per_order", cost: 0.4 },
        { key: "sakiz", scope: "per_order", cost: 1.25 },
      ],
      listing: {
        platform: "shopify",
        commissionRate: null,
        commissionFixed: null,
        cargoCost: null,
      },
    });
    const result = computeOrderProfit({
      platform: "shopify",
      orderTotal: 344.98,
      lines: [
        { unitPrice: 127.49, quantity: 2, product: actualProduct },
        { unitPrice: 0, quantity: 1, product: actualProduct },
      ],
      commissionRules: [],
      cargoRules: [
        {
          id: "shopify-cargo",
          name: "Shopify 0-4 desi",
          platform: "shopify",
          cargoProvider: null,
          categoryName: null,
          minPrice: 0,
          maxPrice: 999999,
          minDesi: 0,
          maxDesi: 4,
          cargoCost: 115,
          vatIncluded: true,
          priority: 10,
          isActive: true,
        },
      ],
      expenseRules: [],
      settings: { vatRate: "20", shopifyCommissionRate: "6.29" },
    });

    expect(result.partial).toBe(false);
    expect(result.orderRevenueAdjustment).toBeCloseTo(90, 6);
    expect(result.desiEstimated).toBe(true);
    expect(result.profit).toBeCloseTo(151.717298, 6);
  });
});
