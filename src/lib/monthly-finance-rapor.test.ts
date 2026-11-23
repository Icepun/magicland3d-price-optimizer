import { describe, expect, it } from "vitest";
import { aggregateMonthlyFinance, monthKey } from "./monthly-finance";
import { aggregateProductSalesByMonth } from "./finance-product-sales";

const tarih = (s: string) => new Date(`${s}T12:00:00+03:00`);

describe("Raporlar v10 — ceza, gider kategorileri", () => {
  const aylar = aggregateMonthlyFinance({
    snapshots: [
      { platform: "trendyol", orderedAt: tarih("2026-10-05"), revenueKurus: 50000, profitKurus: 9000, profitPartial: false, statusKind: "delivered", currency: "TRY", penaltyKurus: 18000 },
      { platform: "trendyol", orderedAt: tarih("2026-10-06"), revenueKurus: 30000, profitKurus: 5000, profitPartial: false, statusKind: "delivered", currency: "TRY", penaltyKurus: null },
      // İade edilenin cezası iade zararının içinde — ceza toplamına ayrıca girmez.
      { platform: "trendyol", orderedAt: tarih("2026-10-07"), revenueKurus: 40000, profitKurus: 7000, profitPartial: false, statusKind: "cancelled", currency: "TRY", returnLossKurus: 30000, penaltyKurus: 12000 },
    ],
    expenses: [
      { paidAt: tarih("2026-10-01"), amountKurus: 900000, category: "Muhasebe" },
      { paidAt: tarih("2026-10-15"), amountKurus: 100000, category: " " },
      { paidAt: tarih("2026-10-20"), amountKurus: 250000, category: "Reklam" },
      { paidAt: tarih("2026-10-21"), amountKurus: 50000, category: "Reklam" },
    ],
    monthCount: 2,
    now: tarih("2026-11-10"),
  });
  const ekim = aylar.find((a) => a.month === "2026-10")!;

  it("ceza yalnız ciroya giren siparişlerden toplanır", () => {
    expect(ekim.penalty).toBe(180);
    expect(ekim.penaltyOrders).toBe(1);
    expect(ekim.returnLoss).toBe(300);
  });

  it("giderler kategori bazında, büyükten küçüğe; boş kategori 'Diğer'", () => {
    expect(ekim.expensesByCategory).toEqual([
      { category: "Muhasebe", amount: 9000, count: 1 },
      { category: "Reklam", amount: 3000, count: 2 },
      { category: "Diğer", amount: 1000, count: 1 },
    ]);
    expect(ekim.expensesByCategory.reduce((t, g) => t + g.amount, 0)).toBe(ekim.expenses);
  });
});

describe("ay ay ürün listeleri", () => {
  const siparis = (id: string, gun: string, profitKurus: number | null, statusKind = "delivered") => ({
    platform: "trendyol",
    externalOrderId: id,
    orderedAt: tarih(gun),
    revenueKurus: 0,
    profitKurus,
    profitPartial: false,
    statusKind,
    currency: "TRY",
  });
  const kalem = (id: string, gun: string, productId: string | null, adet: number, ciroKurus: number) => ({
    platform: "trendyol",
    externalOrderId: id,
    orderedAt: tarih(gun),
    productId,
    productName: productId ?? "Bağlanmamış ilan",
    quantity: adet,
    lineRevenueKurus: ciroKurus,
    statusKind: "delivered",
  });
  const sonuc = aggregateProductSalesByMonth({
    orders: [siparis("a", "2026-10-02", 10000), siparis("b", "2026-11-03", 4000), siparis("c", "2026-11-04", null), siparis("d", "2026-11-05", 3000)],
    items: [
      kalem("a", "2026-10-02", "p1", 2, 40000),
      kalem("b", "2026-11-03", "p1", 1, 20000),
      kalem("b", "2026-11-03", null, 1, 20000),
      kalem("c", "2026-11-04", "p2", 3, 30000),
    ],
    productInfo: [{ id: "p1", name: "Ürün 1", imageUrl: null }, { id: "p2", name: "Ürün 2", imageUrl: null }],
    ayOf: (t) => monthKey(t),
  });

  it("her ay kendi listesi; kâr kalem cirosu payıyla dağılır, eşleşmeyen pay almaz", () => {
    expect(sonuc["2026-10"].topSellers[0]).toMatchObject({ productId: "p1", quantity: 2, profit: 100 });
    const kasim = sonuc["2026-11"];
    expect(kasim.topSellers.map((r) => r.productId)).toEqual(["p2", "p1"]);
    expect(kasim.topSellers.find((r) => r.productId === "p1")?.profit).toBe(20);
    expect(kasim.unmatched).toEqual({ lines: 1, quantity: 1, revenue: 200 });
  });

  it("kârı bilinmeyen ürün 'çok kazandıran'a girmez; dökümsüz sipariş sayılır", () => {
    const kasim = sonuc["2026-11"];
    expect(kasim.profitLeaders.map((r) => r.productId)).toEqual(["p1"]);
    expect(kasim.ordersWithoutItems).toBe(1);
  });
});
