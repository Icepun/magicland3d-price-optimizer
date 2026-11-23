/**
 * Berke'nin 23 Kas 2026'da onayladığı kâr düzeltmeleri — bekçi testleri.
 *
 * EŞİTLİK İLKESİ: bugünkü veride (komisyon kuralı yok, ayar geçmişi yok, siparişlerde oran var)
 * rakam DEĞİŞMEMELİ; yalnız tarif edilen durumlarda yeni davranış devreye girer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  donemliAyarlar,
  donemliDeger,
  donemliGecmiseEkle,
  gecmisAnahtari,
} from "@/core/donemli-oran";
import { computeOrderProfit, computeReturnLoss, resolveOrderProfit, type OrderProfitInput, type OrderProfitLine } from "@/core/order-profit";
import { findCommissionRule, komisyonKuraliPlatformu } from "@/core/commission-calculator";
import { baremDesisi, findCargoRule } from "@/core/cargo-calculator";
import { categoryMatchScore } from "@/core/category";
import { simulatePrice } from "@/core/pricing-engine";
import { resolveListingCommissionOnly, withProductCommissionRule } from "@/core/product-commission";
import { komisyonBilinmiyor } from "@/core/komisyon-bilinmiyor";
import { yeniKuralBaslangiciMs } from "@/core/tariff-period";
import {
  komisyonKuraliGuncellemePlani,
  komisyonKuraliSilmePlani,
  type KomisyonKuraliKaydi,
} from "@/core/komisyon-kurali-donem";
import type { CargoRuleInput, CommissionRuleInput } from "@/core/types";

const TR = (s: string) => new Date(`${s}+03:00`);

function satir(o: Partial<OrderProfitLine> = {}, listingRate: number | null = 0.21): OrderProfitLine {
  return {
    unitPrice: 200,
    quantity: 1,
    product: {
      id: "p1", name: "Ürün", categoryName: "Dekor", desi: 1, commissionRate: null,
      productionCost: 40, packagingCost: 8, packagingComponents: null, filamentCost: 15,
      productionCostKnown: true,
      listing: { platform: "trendyol", commissionRate: listingRate, commissionFixed: null, cargoCost: null },
    },
    ...o,
  };
}

function girdi(lines: OrderProfitLine[], o: Partial<OrderProfitInput> = {}): OrderProfitInput {
  return {
    platform: "trendyol",
    orderTotal: lines.reduce((t, l) => t + l.unitPrice * l.quantity, 0),
    lines,
    commissionRules: [],
    cargoRules: [],
    expenseRules: [],
    settings: { vatRate: "20", shopifyCommissionRate: "6.29" },
    orderedAt: TR("2026-11-20T10:00:00"),
    ...o,
  };
}

const kural = (o: Partial<CommissionRuleInput> = {}): CommissionRuleInput => ({
  id: "r1", name: "Genel", categoryName: null, minPrice: 0, maxPrice: 999999,
  commissionRate: 0.2, fixedCommission: 0, priority: 10, isActive: true, ...o,
});

describe("dönemli ayar (KDV, Shopify komisyonu) — madde 3 ve 21", () => {
  it("geçmiş yoksa ayar haritası AYNEN döner (eşitlik)", () => {
    const s = { vatRate: "20" };
    expect(donemliAyarlar(s, new Date())).toBe(s);
  });

  it("KDV değişince önceki siparişler eski oranla, sonrakiler yeni oranla", () => {
    const degisim = TR("2026-11-15T00:00:00");
    const gecmis = donemliGecmiseEkle(null, "20", "10", degisim)!;
    const s = { vatRate: "10", [gecmisAnahtari("vatRate")]: gecmis };
    expect(donemliDeger(s, "vatRate", TR("2026-11-10T12:00:00"))).toBe("20");
    expect(donemliDeger(s, "vatRate", TR("2026-11-16T12:00:00"))).toBe("10");
    // Sipariş kârı: eski tarihli sipariş eski KDV ile aynı kalır.
    const eski = computeOrderProfit(girdi([satir()], { settings: { vatRate: "20" }, orderedAt: TR("2026-11-10T12:00:00") }));
    const eskiYeniAyarla = computeOrderProfit(girdi([satir()], { settings: s, orderedAt: TR("2026-11-10T12:00:00") }));
    expect(eskiYeniAyarla.profit).toBeCloseTo(eski.profit!, 9);
    const yeni = computeOrderProfit(girdi([satir()], { settings: s, orderedAt: TR("2026-11-16T12:00:00") }));
    const yeniDuz = computeOrderProfit(girdi([satir()], { settings: { vatRate: "10" }, orderedAt: TR("2026-11-16T12:00:00") }));
    expect(yeni.profit).toBeCloseTo(yeniDuz.profit!, 9);
    expect(yeni.profit).not.toBeCloseTo(eski.profit!, 2);
  });

  it("hiç girilmemiş ayar tohumlanınca eski siparişler varsayılanı kullanmaya devam eder", () => {
    const gecmis = donemliGecmiseEkle(undefined, undefined, "6.29", TR("2026-11-15T00:00:00"))!;
    const s = { shopifyCommissionRate: "6.29", [gecmisAnahtari("shopifyCommissionRate")]: gecmis };
    expect(donemliDeger(s, "shopifyCommissionRate", TR("2026-10-01T00:00:00"))).toBeUndefined(); // → %3,2 varsayılanı
    expect(donemliGecmiseEkle(gecmis, "6.29", "6.29", new Date())).toBeNull();
  });

  it("Shopify siparişi kendi tarihindeki komisyonla", () => {
    const gecmis = donemliGecmiseEkle(null, "6.29", "8", TR("2026-11-15T00:00:00"))!;
    const s = { vatRate: "20", shopifyCommissionRate: "8", [gecmisAnahtari("shopifyCommissionRate")]: gecmis };
    const shopifySatiri = satir();
    shopifySatiri.product = { ...shopifySatiri.product!, listing: null };
    const sh = (tarih: string, ayar: Record<string, string>) =>
      computeOrderProfit(girdi([shopifySatiri], { platform: "shopify", settings: ayar, orderedAt: TR(tarih) })).estimatedCommission;
    expect(sh("2026-11-10T12:00:00", s)).toBeCloseTo(200 * 0.0629, 9);
    expect(sh("2026-11-16T12:00:00", s)).toBeCloseTo(200 * 0.08, 9);
  });
});

describe("komisyon kuralı seçimi — madde 1, 4, 6", () => {
  it("eşit öncelikte sonuç listenin sırasına bağlı değil (dar bant → kimlik)", () => {
    const a = kural({ id: "a", minPrice: 0, maxPrice: 200, commissionRate: 0.18 });
    const b = kural({ id: "b", minPrice: 0, maxPrice: 999999, commissionRate: 0.21 });
    expect(findCommissionRule([a, b], 150, "Dekor")!.id).toBe("a");
    expect(findCommissionRule([b, a], 150, "Dekor")!.id).toBe("a");
    const c = kural({ id: "c" });
    const d = kural({ id: "d" });
    expect(findCommissionRule([d, c], 150, "Dekor")!.id).toBe("c");
  });

  it("Hepsiburada ilanı Trendyol kuralını devralmaz; boş platform = Trendyol", () => {
    const eski = kural({ id: "eski", platform: null });
    const hb = kural({ id: "hb", platform: "hepsiburada", commissionRate: 0.12 });
    expect(komisyonKuraliPlatformu(eski)).toBe("trendyol");
    expect(findCommissionRule([eski], 150, "Dekor", new Date(), "hepsiburada")).toBeUndefined();
    expect(findCommissionRule([eski, hb], 150, "Dekor", new Date(), "hepsiburada")!.id).toBe("hb");
    expect(findCommissionRule([eski, hb], 150, "Dekor", new Date(), "trendyol")!.id).toBe("eski");
    // Platform verilmezse eski davranış (hepsi).
    expect(findCommissionRule([eski], 150, "Dekor")!.id).toBe("eski");
  });

  it("ürün oranı (Trendyol'dan gelir) Hepsiburada ilanına uygulanmaz → komisyon bilinmiyor", () => {
    const urun = { id: "p1", name: "Stand", categoryName: "Dekor", commissionRate: 0.129 };
    const ilan = { platform: "hepsiburada", commissionRate: null, commissionFixed: null };
    const sim = simulatePrice({
      salePrice: 160, productCost: 30, packagingCost: 5, categoryName: "Dekor",
      commissionRules: withProductCommissionRule(urun, []), cargoRules: [], expenseRules: [], vatRate: 20,
      ...resolveListingCommissionOnly(ilan, {}),
    });
    expect(sim.appliedCommissionRule).toBeUndefined();
    expect(komisyonBilinmiyor(ilan, sim)).toBe(true);
    // Trendyol ilanında ürün oranı eskisi gibi uygulanır.
    const ty = simulatePrice({
      salePrice: 160, productCost: 30, packagingCost: 5, categoryName: "Dekor",
      commissionRules: withProductCommissionRule(urun, []), cargoRules: [], expenseRules: [], vatRate: 20,
      ...resolveListingCommissionOnly({ ...ilan, platform: "trendyol" }, {}),
    });
    expect(ty.commissionCost).toBeCloseTo(160 * 0.129, 9);
  });

  it("kategori eşleşmesi ters yönde tutmaz", () => {
    expect(categoryMatchScore("Masa Lambası", "Lamba")).toBe(0);
    expect(categoryMatchScore("Lamba", "Masa Lambası")).toBeGreaterThan(0);
    expect(findCommissionRule([kural({ categoryName: "Masa Lambası" })], 150, "Lamba")).toBeUndefined();
  });

  it("kural siparişin tarihine göre seçilir (dönemli)", () => {
    const eski = kural({ id: "eski", commissionRate: 0.21, validTo: TR("2026-10-31T23:59:59.999") });
    const yeni = kural({ id: "yeni", commissionRate: 0.18, validFrom: TR("2026-11-01T00:00:00") });
    const ekim = computeOrderProfit(girdi([satir({}, null)], { commissionRules: [eski, yeni], orderedAt: TR("2026-10-20T10:00:00") }));
    const kasim = computeOrderProfit(girdi([satir({}, null)], { commissionRules: [eski, yeni], orderedAt: TR("2026-11-20T10:00:00") }));
    expect(ekim.estimatedCommission).toBeCloseTo(200 * 0.21, 9);
    expect(kasim.estimatedCommission).toBeCloseTo(200 * 0.18, 9);
  });
});

describe("komisyonu bilinmeyen satır — madde 5", () => {
  it("siparişte/ilanda/kuralda oran yoksa 0 sayılmaz: satır kâra girmez, sipariş kısmi", () => {
    const r = computeOrderProfit(girdi([satir({}, null), satir({ unitPrice: 100 })]));
    expect(r.commissionUnknownLines).toBe(1);
    expect(r.partial).toBe(true);
    expect(r.matchedLines).toBe(1);
    const tek = computeOrderProfit(girdi([satir({}, null)]));
    expect(tek.profit).toBeNull();
  });

  it("oran varsa (sipariş ya da ilan) eskisi gibi (eşitlik)", () => {
    const r = computeOrderProfit(girdi([satir({ orderCommissionRate: 0.2 }, null)]));
    expect(r.commissionUnknownLines).toBe(0);
    expect(r.partial).toBe(false);
    const ilanli = computeOrderProfit(girdi([satir()]));
    expect(ilanli.commissionUnknownLines).toBe(0);
  });

  it("pazaryerinin gerçek komisyon kaydı varsa satır yine kâra girer (eski davranış korunur)", () => {
    const r = resolveOrderProfit(girdi([satir({}, null)]), {
      financial: { actualCommission: 42, settlementRevenue: 200 },
    });
    expect(r.profit).not.toBeNull();
    expect(r.profitPartial).toBe(false);
    expect(r.profitSource).toBe("platform");
    expect(r.actualCommission).toBe(42);
  });

  it("ücretsiz (0 ₺) satır komisyonu bilinmiyor sayılmaz", () => {
    const r = computeOrderProfit(girdi([satir({ unitPrice: 0 }, null), satir()]));
    expect(r.commissionUnknownLines).toBe(0);
  });
});

describe("kargo — madde 1, 7, 11", () => {
  const sh = (o: Partial<CargoRuleInput>): CargoRuleInput => ({
    id: "x", name: "x", platform: "shopify", categoryName: null, minPrice: 0, maxPrice: 999999,
    minDesi: 0, maxDesi: 4, cargoCost: 115, priority: 10, isActive: true, ...o,
  });

  it("eşit kurallarda seçim sıradan bağımsız (dar bant → kimlik)", () => {
    const a = sh({ id: "a", maxPrice: 150, cargoCost: 90 });
    const b = sh({ id: "b", minPrice: 150, cargoCost: 115 });
    expect(findCargoRule([a, b], 150, "", 1)!.id).toBe(findCargoRule([b, a], 150, "", 1)!.id);
  });

  it("Ürünler ekranı da sipariş kârıyla aynı desi yuvarlamasını kullanır (4,1 → 0–4 bandı)", () => {
    expect(baremDesisi(4.1)).toBe(4);
    expect(baremDesisi(4.5)).toBe(5);
    expect(baremDesisi(0.1)).toBe(1);
    const kurallar = [sh({ id: "k04" }), sh({ id: "k510", minDesi: 5, maxDesi: 10, cargoCost: 145 })];
    const sim = simulatePrice({
      salePrice: 300, productCost: 30, packagingCost: 5, categoryName: "", desi: 4.1,
      commissionRules: [], cargoRules: kurallar, expenseRules: [], vatRate: 20, commissionRateOverride: 0.05,
    });
    expect(sim.appliedCargoRule?.id).toBe("k04");
  });

  it("iadede kargo kuralı yoksa işaretlenir (sessiz 0 değil)", () => {
    const z = computeReturnLoss(girdi([satir()], { platform: "shopify", cargoRules: [] }));
    expect(z.cargoRuleMissing).toBe(true);
    const var_ = computeReturnLoss(girdi([satir()], { platform: "shopify", cargoRules: [sh({})] }));
    expect(var_.cargoRuleMissing).toBe(false);
    const gercek = computeReturnLoss(girdi([satir()], { platform: "shopify", cargoRules: [] }), { outboundCargo: 90 });
    expect(gercek.cargoRuleMissing).toBe(false);
  });
});

describe("yeni kural başlangıcı — madde 9 (Berke: tüm kasıma etki etsin)", () => {
  it("bu ayın 1'i; dönem bu aydan sonra başladıysa dönemin başı", () => {
    const simdi = TR("2026-11-23T20:00:00").getTime();
    expect(yeniKuralBaslangiciMs([], simdi)).toBe(TR("2026-11-01T00:00:00").getTime());
    expect(yeniKuralBaslangiciMs([{ validFrom: TR("2026-10-01T00:00:00"), validTo: null }], simdi)).toBe(
      TR("2026-11-01T00:00:00").getTime()
    );
    expect(yeniKuralBaslangiciMs([{ validFrom: TR("2026-11-15T00:00:00"), validTo: null }], simdi)).toBe(
      TR("2026-11-15T00:00:00").getTime()
    );
  });
});

describe("komisyon kuralı dönemleri — madde 3", () => {
  const kayit = (o: Partial<KomisyonKuraliKaydi> = {}): KomisyonKuraliKaydi => ({
    id: "k", name: "Genel", categoryName: null, minPrice: 0, maxPrice: 999999, commissionRate: 0.21,
    fixedCommission: 0, priority: 10, isActive: true, validFrom: null, validTo: null, platform: "trendyol", ...o,
  });
  const an = TR("2026-11-23T20:00:00");

  it("eski kuralın oranı değişince: ay başında kapanır, yeni dönem ay başından başlar", () => {
    const plan = komisyonKuraliGuncellemePlani(kayit(), { commissionRate: 0.18 }, an);
    expect(plan.tur).toBe("donem");
    if (plan.tur !== "donem") return;
    expect(plan.kapat.validTo.getTime()).toBe(TR("2026-11-01T00:00:00").getTime() - 1);
    expect(plan.yeni.validFrom!.getTime()).toBe(TR("2026-11-01T00:00:00").getTime());
    expect(plan.yeni.commissionRate).toBe(0.18);
  });

  it("yalnız ad değişirse ya da kural bu ay eklendiyse yerinde düzenlenir", () => {
    expect(komisyonKuraliGuncellemePlani(kayit(), { name: "Yeni ad" }, an).tur).toBe("yerinde");
    expect(komisyonKuraliGuncellemePlani(kayit({ validFrom: TR("2026-11-01T00:00:00") }), { commissionRate: 0.1 }, an).tur).toBe("yerinde");
  });

  it("silme: eski kural kapanır, bu ay eklenen silinir, istenirse tamamen silinir", () => {
    expect(komisyonKuraliSilmePlani(kayit(), an).tur).toBe("kapat");
    expect(komisyonKuraliSilmePlani(kayit({ validFrom: TR("2026-11-01T00:00:00") }), an).tur).toBe("sil");
    expect(komisyonKuraliSilmePlani(kayit(), an, true).tur).toBe("sil");
  });
});

// ── Uçlar (sahte prisma) ──────────────────────────────────────────────────────
const db = vi.hoisted(() => ({
  appSetting: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn(), findUnique: vi.fn() },
  cargoRule: { findMany: vi.fn(), create: vi.fn() },
  orderFinanceSnapshot: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));
const batchWrite = vi.hoisted(() => vi.fn());
const tazele = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/libsql-batch", () => ({ batchWrite }));
vi.mock("@/lib/cache-busting", () => ({ bustProfitInputCaches: vi.fn(), bustInventoryAlertCaches: vi.fn() }));
vi.mock("@/lib/route-cache", () => ({ bustCache: vi.fn(), bustCaches: vi.fn(), swr: (_k: string, _t: number, f: () => Promise<unknown>) => f() }));
vi.mock("@/lib/r2", () => ({ invalidateR2Config: vi.fn() }));
vi.mock("@/lib/runtime-schema", () => ({ ensureRuntimeSchema: vi.fn() }));
vi.mock("@/lib/kural-sonrasi-tazele", () => ({ kuralSonrasiSiparisleriTazele: tazele }));

const istek = (govde: unknown) => ({ json: async () => govde }) as never;

describe("uçlar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    batchWrite.mockResolvedValue(true);
  });

  it("KDV değişince geçmişe dönem eklenir (aynı atomik yazımda)", async () => {
    const ayarlar = await import("@/app/api/settings/route");
    db.appSetting.findMany.mockResolvedValue([{ key: "vatRate", value: "20" }]);
    await ayarlar.POST(istek({ vatRate: "10" }));
    const ifadeler = batchWrite.mock.calls[0][0] as Array<{ args: unknown[] }>;
    const yazilan = Object.fromEntries(ifadeler.map((i) => [i.args[0], i.args[1]]));
    expect(yazilan.vatRate).toBe("10");
    const gecmis = JSON.parse(String(yazilan.vatRateGecmisi));
    expect(gecmis[0]).toEqual({ bas: null, deger: "20" });
    expect(gecmis[1].deger).toBe("10");
  });

  it("KDV aynıysa geçmiş yazılmaz", async () => {
    const ayarlar = await import("@/app/api/settings/route");
    db.appSetting.findMany.mockResolvedValue([{ key: "vatRate", value: "20" }]);
    await ayarlar.POST(istek({ vatRate: "20" }));
    expect(batchWrite).not.toHaveBeenCalled();
  });

  it("yeni kargo kuralı bu ayın 1'inden başlar, platformsuz kural Shopify olur, bu ay yeniden hesaplanır", async () => {
    const kargo = await import("@/app/api/cargo-rules/route");
    db.cargoRule.findMany.mockResolvedValue([]);
    db.cargoRule.create.mockImplementation(async ({ data }: { data: unknown }) => data);
    const r = await kargo.POST(istek({ name: "0-4", minDesi: 0, maxDesi: 4, cargoCost: 115 }));
    expect(r.status).toBe(201);
    const data = db.cargoRule.create.mock.calls[0][0].data as { platform: string; validFrom: Date };
    expect(data.platform).toBe("shopify");
    const d = new Date(data.validFrom.getTime() + 3 * 3600_000);
    expect(d.getUTCDate()).toBe(1);
    expect(d.getUTCHours()).toBe(0);
    expect(tazele).toHaveBeenCalledWith("shopify", data.validFrom);
  });
});
