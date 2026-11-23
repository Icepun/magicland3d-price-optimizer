import { describe, expect, it } from "vitest";
import {
  ayAdi,
  ayOzeti,
  aylikTrend,
  giderSatirlari,
  platformSatirlari,
  secilebilirAylar,
  selaleSatirlari,
} from "./rapor-gorunum";
import type { FinanceBucket } from "./reports-view";

const TZ = "Europe/Istanbul";
const ay = (month: string, ek: Partial<FinanceBucket> = {}): FinanceBucket => ({
  month,
  label: month,
  revenue: 0,
  orderProfit: 0,
  expenses: 0,
  netProfit: 0,
  orderCount: 0,
  incompleteOrders: 0,
  partialProfitOrders: 0,
  missingProfitOrders: 0,
  excludedOrders: 0,
  unsupportedCurrencyOrders: 0,
  byPlatform: {},
  ...ek,
});

const aylar = [
  ay("2026-04"),
  ay("2026-05"),
  ay("2026-06", { revenue: 28070.5, orderProfit: 8694.08, expenses: 6630, netProfit: 2064.08, orderCount: 64 }),
  ay("2026-07"),
  ay("2026-10", { revenue: 142224.75, orderProfit: 55067.33, expenses: 24510, netProfit: 30557.33, orderCount: 216 }),
  ay("2026-11", {
    revenue: 143348.05,
    orderProfit: 50099.72,
    expenses: 16900,
    netProfit: 33199.72,
    orderCount: 252,
    returnLoss: 876.8,
    byPlatform: {
      trendyol: { revenue: 45000, orderProfit: 14000, orderCount: 80 },
      hepsiburada: { revenue: 60000, orderProfit: 20000, orderCount: 100 },
      shopify: { revenue: 38348.05, orderProfit: 16099.72, orderCount: 72 },
      manual: { revenue: 0, orderProfit: 0, orderCount: 0 },
    },
    expensesByCategory: [
      { category: "Muhasebe", amount: 12000, count: 1 },
      { category: "Diğer", amount: 4900, count: 3 },
    ],
  }),
];
const simdi = Date.parse("2026-11-23T10:00:00+03:00");

describe("Raporlar görünüm mantığı", () => {
  it("seçilebilir aylar ilk dolu aydan başlar; aradaki boş ay atlanmaz", () => {
    expect(secilebilirAylar(aylar).map((a) => a.month)).toEqual(["2026-06", "2026-07", "2026-10", "2026-11"]);
  });

  it("ay adı", () => {
    expect(ayAdi("2026-11")).toBe("Kasım 2026");
    expect(ayAdi("2026-08", false)).toBe("Ağustos");
  });

  it("süren ay geçen ayın AYNI GÜNÜNE kadarki kısmıyla kıyaslanır, tahmin üretir", () => {
    const o = ayOzeti(
      aylar,
      "2026-11",
      { month: "2026-10", revenue: 115366.45, netProfit: 25361.25, expenses: 19260, orderCount: 171, until: "2026-10-23T07:00:00.000Z" },
      simdi,
      TZ
    )!;
    expect(o.kiyas.etiket).toBe("1–23 Ekim");
    expect(o.kiyas.ciro?.diff).toBeCloseTo(27981.6, 1);
    // Önceki dönemin sipariş kârı = net + gider.
    expect(o.kiyas.siparisKari?.diff).toBeCloseTo(50099.72 - (25361.25 + 19260), 2);
    expect(o.marj).toBeCloseTo(50099.72 / 143348.05, 6);
    expect(o.ortalamaSepet).toBeCloseTo(143348.05 / 252, 6);
    expect(o.tahmin.ciro).toBeGreaterThan(143348.05);
    expect(o.ilerleme?.ongoing).toBe(true);
  });

  it("bitmiş ay önceki ayın tamamıyla kıyaslanır; önceki ay boşsa kıyas yok", () => {
    const ekim = ayOzeti(aylar, "2026-10", null, simdi, TZ)!;
    // Eylül listede yok → önceki eleman Temmuz (boş) → kıyas üretilmez.
    expect(ekim.kiyas.ciro).toBeNull();
    expect(ekim.tahmin.ciro).toBeNull();
    expect(ekim.kiyas.etiket).toBeNull();
  });

  it("şelale: ciro → kesintiler → sipariş kârı → iade → gider → net kâr; tutarlıysa eskimiş değil", () => {
    const kasim = aylar[5];
    const s = selaleSatirlari(
      {
        month: "2026-11",
        revenue: 143348.05,
        unknownCostRevenue: 1000,
        lines: [
          { key: "urun", label: "Ürün ve paketleme", amount: 50000 },
          { key: "komisyon", label: "Pazaryeri komisyonu", amount: 20000 },
          { key: "kargo", label: "Kargo", amount: 21371.53 },
        ],
        orderProfitBeforeReturns: 50976.52,
        orderCount: 252,
      },
      kasim
    );
    expect(s.satirlar.map((x) => x.key)).toEqual(["ciro", "bilinmeyen", "urun", "komisyon", "kargo", "siparisKari", "iade", "gider", "net"]);
    expect(s.satirlar.at(-1)).toMatchObject({ amount: 33199.72, tur: "sonuc" });
    expect(s.eskimis).toBe(false);
    // Arada sipariş geldiyse (döküm başka anın kârı) yenilenmeli.
    expect(selaleSatirlari({ month: "2026-11", revenue: 140000, unknownCostRevenue: 0, lines: [], orderProfitBeforeReturns: 49000, orderCount: 240 }, kasim).eskimis).toBe(true);
  });

  it("platformlar ciroya göre sıralı, payları toplamı 1, boş platform yok", () => {
    const p = platformSatirlari(aylar[5]);
    expect(p.map((x) => x.platform)).toEqual(["hepsiburada", "trendyol", "shopify"]);
    expect(p.reduce((t, x) => t + x.pay, 0)).toBeCloseTo(1, 6);
    expect(p[0].marj).toBeCloseTo(20000 / 60000, 6);
  });

  it("giderler: kategori rengi seçilmişse o, değilse paletten (turuncu yok)", () => {
    const g = giderSatirlari(aylar[5], [{ name: "Muhasebe", color: "#123456" }]);
    expect(g[0]).toMatchObject({ kategori: "Muhasebe", renk: "#123456" });
    expect(g[1].renk).toMatch(/^#/);
    expect(g.reduce((t, x) => t + x.pay, 0)).toBeCloseTo(1, 6);
  });

  it("trend: süren ay işaretli, kısaltılmış ay adıyla", () => {
    const t = aylikTrend(aylar, simdi, TZ);
    expect(t.at(-1)).toMatchObject({ anahtar: "2026-11", etiket: "Kas", suruyor: true });
    expect(t[0]).toMatchObject({ anahtar: "2026-06", suruyor: false });
  });
});
