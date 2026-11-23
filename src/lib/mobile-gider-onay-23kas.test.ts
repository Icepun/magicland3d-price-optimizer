import { beforeEach, describe, expect, it, vi } from "vitest";

import { setDbDateStorage } from "@/core/sqlite-date";

/**
 * TELEFON KARŞILIĞI — Gider Ödemeleri + reklam bütçesi, onaylanan 6 madde (23 Kas 2026).
 *
 * Telefonun GERÇEK modülleri çalışır (`db/finance`, `db/ad-budgets`, `db/rules`, `finance-sync`);
 * yalnız veritabanı ve ağ uçları sahte. Modül yolları DEĞİŞKENDE: telefonun `@/` takma adları kökte
 * çözülmez (bkz. mobile-kargo-kural-tarih.test.ts). Testler `mobile/` altına KONMAZ (TestFlight).
 *
 * EŞİTLİK: bütçesiz / KDV'siz / atlasız durumda telefonun rakamları ve yazdıkları eskisiyle aynı.
 */

const yol = vi.hoisted(() => ({
  finans: "../../mobile/src/lib/db/finance",
  reklam: "../../mobile/src/lib/db/ad-budgets",
  kurallar: "../../mobile/src/lib/db/rules",
  senkron: "../../mobile/src/lib/finance-sync",
}));

type Satir = Record<string, unknown>;
type Ifade = { sql: string; args?: unknown[] };

const db = vi.hoisted(() => ({
  /** SQL metnine göre dönen satırlar (ilk eşleşen). */
  yanit: [] as Array<{ eslesme: RegExp; satirlar: Satir[] | (() => never) }>,
  execute: [] as Ifade[],
  writeBatch: [] as Ifade[][],
  sync: [] as unknown[][],
}));

function satirlar(sql: string): Satir[] {
  const bulunan = db.yanit.find((y) => y.eslesme.test(sql));
  if (!bulunan) return [];
  return typeof bulunan.satirlar === "function" ? bulunan.satirlar() : bulunan.satirlar;
}

vi.mock("@/lib/turso", () => ({
  query: vi.fn(async (sql: string) => satirlar(sql)),
  execute: vi.fn(async (sql: string, args?: unknown[]) => {
    db.execute.push({ sql, args });
    return { rows: satirlar(sql), rowsAffected: 1 };
  }),
  writeBatch: vi.fn(async (stmts: Ifade[]) => {
    db.writeBatch.push(stmts);
    return [];
  }),
  batch: vi.fn(async (stmts: Ifade[]) => stmts.map(() => ({ rows: [] }))),
}));
vi.mock("@/lib/db/schema", () => ({
  ensureFinanceSchema: vi.fn(async () => {}),
  ensureManualOrderSchema: vi.fn(async () => {}),
  ensureCargoVatSchema: vi.fn(async () => {}),
  // Komisyon kısmının şema yardımcısı (başka işin dosyası) — kural okuması onu da çağırıyor.
  ensureCommissionPlatformSchema: vi.fn(async () => {}),
}));
// finance-sync'in bağımlılıkları (telefon yolları kökte yok → sahte).
vi.mock("@/lib/api/orders", () => ({
  isCancelledOrder: () => false,
  isIncompleteOrder: () => false,
  isUnknownStatusOrder: () => false,
}));
vi.mock("@/lib/order-profit", () => ({
  getProductMap: () => new Map(),
  computeOrderProfit: () => ({
    revenue: 100, profit: 30, partial: false, profitSource: "calculated", estimatedCommission: 10, actualCommission: null,
  }),
}));
vi.mock("@/lib/db/finance", () => ({
  syncOrderFinanceSnapshots: vi.fn(async (...args: unknown[]) => {
    db.sync.push(args);
  }),
}));

/**
 * Telefon modüllerinin bu testte kullanılan yüzü. `typeof import("../../mobile/…")` YAZILMAZ: kök
 * tsc telefonun `@/lib/turso` takma adını çözemez ve tüm derleme kırılır.
 */
type ReklamZorlama = { baslangicMs: number; platform: string };
type GiderGirdisi = { name: string; amountKurus: number; paidAt: string; vatRate?: number | null };
type Finans = {
  deleteActualExpense: (id: string) => Promise<void>;
  getActualExpenses: () => Promise<Array<{ paidAt: string; recurringId: string | null; vatRate: number | null }>>;
  getMonthlyFinanceSummary: (n: number) => Promise<{ periods: Array<{ expensesKurus: number; netProfitKurus: number }> }>;
  getExpenseTotalSince: (fromMs: number) => Promise<number>;
  createActualExpense: (g: GiderGirdisi) => Promise<void>;
  updateActualExpense: (id: string, g: GiderGirdisi) => Promise<void>;
  syncOrderFinanceSnapshots: (s: unknown[], o?: { zorlaKarYaz?: ReklamZorlama | false }) => Promise<void>;
};
type Reklam = {
  stopAdBudget: (id: string) => Promise<ReklamZorlama | null>;
  saveAdBudget: (g: { platform: string; dailyAmount: number; startsAt: Date }) => Promise<ReklamZorlama>;
};
type Kurallar = {
  getRules: () => Promise<{ adBudgets: unknown[] } & Record<string, unknown>>;
  kurallarReklamBilinmiyor: (r: unknown) => boolean;
};
type SorguIstemcisi = { getQueryData: (k: string[]) => unknown; invalidateQueries: (...a: unknown[]) => unknown };
type Senkron = {
  syncFinanceFromCache: (qc: SorguIstemcisi, o?: { zorla?: boolean; zorlaKarYaz?: ReklamZorlama | false }) => Promise<void>;
};
const finans = () => import(/* @vite-ignore */ yol.finans) as Promise<Finans>;
const reklam = () => import(/* @vite-ignore */ yol.reklam) as Promise<Reklam>;
const kurallar = () => import(/* @vite-ignore */ yol.kurallar) as Promise<Kurallar>;
const senkron = () => import(/* @vite-ignore */ yol.senkron) as Promise<Senkron>;

beforeEach(() => {
  db.yanit = [];
  db.execute = [];
  db.writeBatch = [];
  db.sync = [];
  setDbDateStorage("iso-text"); // telefon bunu açılışta yapıyor
});

/* ═══════════════ 14 · "Reklamı durdur" yalnız bitiş yazar ═══════════════ */

describe("14 · telefon: reklamı durdur dönemin geçmiş payını silmez", () => {
  it("yalnız validTo yazılır, isActive 1 kalır; Raporlar dönemin başından yeniden yazılır", async () => {
    db.yanit = [{ eslesme: /FROM AdBudget WHERE id = \?/, satirlar: [{ bas: 1_785_000_000_000, platform: "trendyol" }] }];
    const { stopAdBudget } = await reklam();
    const etki = await stopAdBudget("ab_1");
    const guncelleme = db.execute.find((e) => /UPDATE AdBudget/.test(e.sql))!;
    expect(guncelleme.sql).toBe("UPDATE AdBudget SET validTo = ? WHERE id = ?");
    expect(guncelleme.sql).not.toMatch(/isActive/);
    expect(etki).toEqual({ baslangicMs: 1_785_000_000_000, platform: "trendyol" });
  });

  it("yeni dönem: kapanan dönemin başı etki aralığına girer, yazım tek parça", async () => {
    db.yanit = [
      { eslesme: /validFrom[\s\S]*>= \?[\s\S]*LIMIT 1/, satirlar: [] },
      { eslesme: /validTo IS NULL OR/, satirlar: [{ bas: 1_780_000_000_000 }] },
    ];
    const { saveAdBudget } = await reklam();
    const bas = new Date(1_790_000_000_000);
    const etki = await saveAdBudget({ platform: "all", dailyAmount: 200, startsAt: bas });
    expect(etki).toEqual({ baslangicMs: 1_780_000_000_000, platform: "all" });
    expect(db.writeBatch).toHaveLength(1);
    expect(db.writeBatch[0].map((s) => s.sql.trim().split(/\s+/)[0])).toEqual(["UPDATE", "INSERT"]);
  });
});

/* ═══════════════ 12 · Telefonda silinen otomatik sabit gider geri gelmez ═══════════════ */

describe("12 · telefon: otomatik sabit gider silinince atla satırı aynı işlemde yazılır", () => {
  it("otomatik kayıt → INSERT atla + DELETE tek writeBatch'te", async () => {
    db.yanit = [
      { eslesme: /SELECT \* FROM "ActualExpense" WHERE "id"/, satirlar: [{ id: "ae1", recurringId: "r1", periodKey: "2026-09" }] },
      { eslesme: /PRAGMA table_info/, satirlar: [{ name: "vatRate" }] },
    ];
    const { deleteActualExpense } = await finans();
    await deleteActualExpense("ae1");
    expect(db.writeBatch).toHaveLength(1);
    const [atla, sil] = db.writeBatch[0];
    expect(atla.sql).toMatch(/INSERT OR IGNORE INTO "RecurringExpenseSkip"/);
    expect(atla.sql).toMatch(/FROM "ActualExpense"\s+WHERE "id" = \?/);
    expect(String(atla.args?.[0])).toMatch(/\+00:00$/); // masaüstüyle aynı tarih biçimi
    expect(sil.sql).toBe(`DELETE FROM "ActualExpense" WHERE "id" = ?`);
  });

  it("EŞİTLİK: elle girilmiş kayıt eskisi gibi tek DELETE (atla yok)", async () => {
    db.yanit = [{ eslesme: /SELECT \* FROM "ActualExpense" WHERE "id"/, satirlar: [{ id: "ae2", recurringId: null }] }];
    const { deleteActualExpense } = await finans();
    await deleteActualExpense("ae2");
    expect(db.writeBatch).toHaveLength(0);
    expect(db.execute.map((e) => e.sql)).toEqual([`DELETE FROM "ActualExpense" WHERE "id" = ?`]);
  });

  it("liste gerçek recurringId'yi ve KDV oranını okur (sabit rozeti görünür)", async () => {
    db.yanit = [
      {
        eslesme: /SELECT \* FROM "ActualExpense"/,
        satirlar: [
          { id: "a", name: "Muhasebe", category: null, amountKurus: 100_000, paidAt: "2026-11-05T00:00:00.000+00:00", note: null, createdAt: "2026-11-05T00:00:00.000+00:00", updatedAt: "2026-11-05T00:00:00.000+00:00", recurringId: "r1", vatRate: 20 },
          { id: "b", name: "Kırtasiye", category: null, amountKurus: 5_000, paidAt: 1_785_000_000_000, note: null, createdAt: 1_785_000_000_000, updatedAt: 1_785_000_000_000 },
        ],
      },
    ];
    const { getActualExpenses } = await finans();
    const liste = await getActualExpenses();
    expect(liste[0]).toMatchObject({ recurringId: "r1", vatRate: 20 });
    expect(liste[1]).toMatchObject({ recurringId: null, vatRate: null });
    expect(Number.isFinite(Date.parse(liste[1].paidAt))).toBe(true); // sayı biçimli tarih de okunur
  });
});

/* ═══════════════ 17 · Telefon Panel'i ve Raporlar'ı KDV'li gideri NET düşer ═══════════════ */

describe("17 · telefon: gider KDV'si masaüstüyle aynı çekirdek kuralla", () => {
  const ayIci = new Date().toISOString();

  it("EŞİTLİK: oransız giderde aylık gider toplamı eski toplamla aynı", async () => {
    db.yanit = [{ eslesme: /FROM "ActualExpense"/, satirlar: [{ paidAt: ayIci, amountKurus: 12_000 }, { paidAt: ayIci, amountKurus: 5_000 }] }];
    const { getMonthlyFinanceSummary } = await finans();
    const ozet = await getMonthlyFinanceSummary(1);
    expect(ozet.periods[0].expensesKurus).toBe(17_000);
  });

  it("%20 KDV'li gider aylık net kârdan KDV hariç düşer", async () => {
    db.yanit = [{ eslesme: /FROM "ActualExpense"/, satirlar: [{ paidAt: ayIci, amountKurus: 12_000, vatRate: 20 }, { paidAt: ayIci, amountKurus: 5_000, vatRate: null }] }];
    const { getMonthlyFinanceSummary, getExpenseTotalSince } = await finans();
    const ozet = await getMonthlyFinanceSummary(1);
    expect(ozet.periods[0].expensesKurus).toBe(10_000 + 5_000);
    expect(ozet.periods[0].netProfitKurus).toBe(-15_000);
    expect(await getExpenseTotalSince(0)).toBe(15_000); // Panel
  });

  it("kayıt ve düzenleme KDV oranını yazar (geçersiz oran → boş)", async () => {
    db.yanit = [{ eslesme: /PRAGMA table_info/, satirlar: [{ name: "vatRate" }] }];
    const { createActualExpense, updateActualExpense } = await finans();
    const temel = { name: "Servis", amountKurus: 1_200, paidAt: ayIci };
    await createActualExpense({ ...temel, vatRate: 20 });
    await updateActualExpense("x", { ...temel, vatRate: 150 });
    const ekle = db.execute.find((e) => /INSERT INTO "ActualExpense"/.test(e.sql))!;
    const duz = db.execute.find((e) => /UPDATE "ActualExpense"/.test(e.sql))!;
    expect(ekle.args?.[6]).toBe(20);
    expect(duz.args?.[5]).toBeNull();
  });
});

/* ═══════════════ 16 · Zorla yeniden yazma YALNIZ bütçe aralığına ═══════════════ */

describe("16 · telefon: bütçe değişince yalnız aralıktaki siparişler zorla yeniden yazılır", () => {
  const snap = (platform: string, id: string, orderedAt: string) => ({
    platform, externalOrderId: id, orderNumber: id, orderedAt, revenue: 100, profit: 30,
    profitPartial: false, statusKind: "active", currency: "TRY", profitSource: "calculated" as const,
    estimatedCommission: 10, actualCommission: null,
  });
  const kayitli = (platform: string, id: string) => ({
    platform, externalOrderId: id, revenueKurus: 10_000, profitKurus: 3_000, profitPartial: 0, statusKind: "active",
    currency: "TRY", profitSource: "calculated", estimatedCommissionKurus: 1_000, actualCommissionKurus: null,
  });
  const girdiler = [
    snap("trendyol", "once", "2026-09-10T10:00:00.000Z"),
    snap("trendyol", "sonra", "2026-09-20T10:00:00.000Z"),
    snap("shopify", "baska", "2026-09-20T10:00:00.000Z"),
  ];

  beforeEach(() => {
    db.yanit = [
      { eslesme: /FROM "OrderFinanceSnapshot"/, satirlar: girdiler.map((g) => kayitli(g.platform, g.externalOrderId)) },
      { eslesme: /FROM "OrderItemSnapshot"/, satirlar: [] },
    ];
  });

  it("EŞİTLİK: zorlama yokken değişmeyen satırlar hiç yazılmaz", async () => {
    const { syncOrderFinanceSnapshots } = await finans();
    await syncOrderFinanceSnapshots(girdiler);
    expect(db.writeBatch).toHaveLength(0);
  });

  it("yalnız başlangıçtan sonraki ve platformu tutan sipariş zorlanır", async () => {
    const { syncOrderFinanceSnapshots } = await finans();
    await syncOrderFinanceSnapshots(girdiler, {
      zorlaKarYaz: { baslangicMs: Date.parse("2026-09-15T00:00:00.000Z"), platform: "trendyol" },
    });
    const yazilan = db.writeBatch.flat();
    expect(yazilan).toHaveLength(1);
    expect(yazilan[0].args?.[2]).toBe("sonra");
    expect(yazilan[0].sql).toContain("<> 'platform'"); // zorlama koşulu yalnız bu satırda
  });

  it("'Tüm platformlar' bütçesi her platformu kapsar", async () => {
    const { syncOrderFinanceSnapshots } = await finans();
    await syncOrderFinanceSnapshots(girdiler, {
      zorlaKarYaz: { baslangicMs: Date.parse("2026-09-15T00:00:00.000Z"), platform: "all" },
    });
    expect(db.writeBatch.flat().map((s) => s.args?.[2]).sort()).toEqual(["baska", "sonra"]);
  });
});

/* ═══════════════ 15 · Telefonda reklam okunamazsa finans geçmişi yazılmaz ═══════════════ */

describe("15 · telefon: reklam bütçesi okunamazsa kurallar işaretlenir, geçmiş yazılmaz", () => {
  it("AdBudget okunamazsa kurallar 'bilinmiyor'; okunursa (boş bile olsa) işaretsiz", async () => {
    const { getRules, kurallarReklamBilinmiyor } = await kurallar();
    db.yanit = [{ eslesme: /FROM AdBudget/, satirlar: () => { throw new Error("ağ"); } }];
    const bozuk = await getRules();
    expect(bozuk.adBudgets).toEqual([]);
    expect(kurallarReklamBilinmiyor(bozuk)).toBe(true);

    db.yanit = [];
    const saglam = await getRules();
    expect(kurallarReklamBilinmiyor(saglam)).toBe(false); // EŞİTLİK: bütçesiz durum eskisi gibi
    expect(Object.keys(saglam)).not.toContain("reklamBilinmiyor");
  });

  it("işaretli kurallarla senkron yazmaz; işaretsizle eskisi gibi yazar (aralık iletilir)", async () => {
    const { syncFinanceFromCache } = await senkron();
    const veri = (rules: object) => ({
      orders: { orders: [{ platform: "trendyol", id: "1001", orderNumber: "1001", date: "2026-11-20T10:00:00.000Z", items: [], currency: "TRY" }] },
      "match-products": [],
      rules,
      settings: {},
    });
    const qc = (v: Record<string, unknown>): SorguIstemcisi => ({ getQueryData: (k) => v[k[0]], invalidateQueries: vi.fn() });

    await syncFinanceFromCache(qc(veri({ adBudgets: [], reklamBilinmiyor: true })), { zorla: true });
    expect(db.sync).toHaveLength(0);

    const etki = { baslangicMs: 1, platform: "all" };
    await syncFinanceFromCache(qc(veri({ adBudgets: [] })), { zorlaKarYaz: etki });
    expect(db.sync).toHaveLength(1);
    expect(db.sync[0][1]).toEqual({ zorlaKarYaz: etki });
  });
});
