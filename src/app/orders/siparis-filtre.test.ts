import { describe, expect, it } from "vitest";
import {
  countsInSummary,
  filterOrdersBeforeStatus,
  hasMissingCost,
  orderMatchesSearch,
  statusChipCounts,
  type FilterableOrder,
  type OrdersStatusKind,
} from "./siparis-filtre";

function order(patch: Partial<FilterableOrder> = {}): FilterableOrder {
  return {
    platform: "trendyol",
    statusKind: "delivered",
    orderNumber: "TY-1",
    customer: null,
    items: [{ name: "Ürün" }],
    currency: "TRY",
    profit: 100,
    profitPartial: false,
    ...patch,
  };
}

/** Özet kartının /api/orders içindeki sayımı — testte aynı koşulu tekrar kurup karşılaştırıyoruz. */
function summaryIncompleteCount(orders: FilterableOrder[]): number {
  let count = 0;
  for (const o of orders) {
    if (o.statusKind === "cancelled") continue;
    if (o.dataIncomplete) continue;
    if ((o.currency?.trim().toUpperCase() || "TRY") !== "TRY") continue;
    if (o.profit == null || o.profitPartial) count += 1;
  }
  return count;
}

describe("sipariş araması Türkçe harfleri kaçırmaz", () => {
  it('"kılıf" yazınca "KILIF" bulunur', () => {
    const row = order({ items: [{ name: "TELEFON KILIFI" }] });
    expect(orderMatchesSearch(row, "kılıf")).toBe(true);
  });

  it("müşteri adında da Türkçe harf eşleşir", () => {
    const row = order({ customer: "İLKNUR ÇINAR" });
    expect(orderMatchesSearch(row, "ilknur")).toBe(true);
    expect(orderMatchesSearch(row, "çınar")).toBe(true);
  });

  it("sipariş numarası ve boş arama beklendiği gibi davranır", () => {
    const row = order({ orderNumber: "TY-1042" });
    expect(orderMatchesSearch(row, "1042")).toBe(true);
    expect(orderMatchesSearch(row, "   ")).toBe(true);
    expect(orderMatchesSearch(row, "bulunmayan")).toBe(false);
  });
});

describe("maliyet eksik kümesi özetle birebir aynı", () => {
  const orders = [
    order({ orderNumber: "A", profit: null }),
    order({ orderNumber: "B", profitPartial: true }),
    // İptal sipariş özete girmez → uyarı sayısına da girmemeli.
    order({ orderNumber: "C", statusKind: "cancelled", profit: null }),
    // Bilgisi eksik sipariş de özet dışında.
    order({ orderNumber: "D", dataIncomplete: true, profit: null }),
    // TRY dışı sipariş TL toplamına katılmaz.
    order({ orderNumber: "E", currency: "USD", profit: null }),
    order({ orderNumber: "F" }),
  ];

  it("uyarıya tıklayınca açılan liste, uyarıdaki sayıyla eşleşir", () => {
    const opened = filterOrdersBeforeStatus(orders, {
      platform: "all",
      search: "",
      onlyMissingCost: true,
    });
    expect(opened.map((o) => o.orderNumber)).toEqual(["A", "B"]);
    expect(opened).toHaveLength(summaryIncompleteCount(orders));
  });

  it("iptal sipariş özet toplamlarının dışındadır", () => {
    expect(countsInSummary(order({ statusKind: "cancelled" }))).toBe(false);
    expect(hasMissingCost(order({ statusKind: "cancelled", profit: null }))).toBe(
      false
    );
  });
});

describe("durum çipleri listeyle aynı kümeden sayılır", () => {
  const kinds: OrdersStatusKind[] = [
    "pending",
    "pending",
    "processing",
    "shipped",
    "delivered",
    "cancelled",
    "other",
    "other",
  ];
  const orders = kinds.map((statusKind, i) =>
    order({ statusKind, orderNumber: `NO-${i}` })
  );

  it("çiplerin toplamı 'Hepsi' ile birebir tutar", () => {
    const chips = statusChipCounts(orders);
    const total = chips.reduce((sum, chip) => sum + chip.count, 0);
    expect(total).toBe(orders.length);
  });

  it("tanınmayan durumdaki siparişler kendi çipinde görünür", () => {
    const chips = statusChipCounts(orders);
    expect(chips.find((chip) => chip.kind === "other")?.count).toBe(2);
  });

  it("tanınmayan durum yoksa fazladan çip eklenmez", () => {
    const chips = statusChipCounts([order({ statusKind: "shipped" })]);
    expect(chips.some((chip) => chip.kind === "other")).toBe(false);
    expect(chips).toHaveLength(5);
  });

  it("platform/arama filtresi açıkken çip sayıları da o kümeden gelir", () => {
    const mixed = [
      order({ platform: "shopify", statusKind: "pending" }),
      order({ platform: "trendyol", statusKind: "pending" }),
      order({ platform: "trendyol", statusKind: "cancelled" }),
    ];
    const beforeStatus = filterOrdersBeforeStatus(mixed, {
      platform: "trendyol",
      search: "",
      onlyMissingCost: false,
    });
    const chips = statusChipCounts(beforeStatus);
    expect(beforeStatus).toHaveLength(2);
    expect(chips.reduce((sum, chip) => sum + chip.count, 0)).toBe(
      beforeStatus.length
    );
    expect(chips.find((chip) => chip.kind === "pending")?.count).toBe(1);
  });
});
