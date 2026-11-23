/**
 * Maliyet & Paketleme denetimi (23 Kas 2026) — düzeltmelerin bekçi testleri.
 * Veritabanı açılmaz: rotalar sahte prisma / batchWrite ile koşar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Sahte bağımlılıklar (rota testleri için) ────────────────────────────────
const db = vi.hoisted(() => ({
  appSetting: { findMany: vi.fn(), upsert: vi.fn() },
  filamentType: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
  $transaction: vi.fn(),
}));
const batchWrite = vi.hoisted(() => vi.fn());
const busts = vi.hoisted(() => ({
  bustProfitInputCaches: vi.fn(),
  bustInventoryAlertCaches: vi.fn(),
  bustCache: vi.fn(),
  invalidateR2Config: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/libsql-batch", () => ({ batchWrite }));
vi.mock("@/lib/cache-busting", () => ({
  bustProfitInputCaches: busts.bustProfitInputCaches,
  bustInventoryAlertCaches: busts.bustInventoryAlertCaches,
}));
vi.mock("@/lib/route-cache", () => ({ bustCache: busts.bustCache, swr: vi.fn() }));
vi.mock("@/lib/r2", () => ({ invalidateR2Config: busts.invalidateR2Config }));
vi.mock("@/lib/order-finance-snapshots", () => ({ recalculateFinanceMonths: async () => ({}) }));

const { computePackagingCost, parsePackagingSettings } = await import("@/core/packaging");
const { resolveProductCost } = await import("@/core/product-cost");
const { karDokumuTopla } = await import("./finance-breakdown");
const { FilamentSemasi } = await import("./filament-semasi");
const ayarlarRotasi = await import("@/app/api/settings/route");
const filamentRotasi = await import("@/app/api/filament-types/[id]/route");

const AYARLAR = {
  packagingOptions: JSON.stringify([{ id: "kutu", name: "Kutu", price: 5 }]),
  costMachineWearPerHour: "4",
  costLaborPerHour: "0",
};

const istek = (govde: unknown) => ({ json: async () => govde }) as unknown as Parameters<typeof ayarlarRotasi.POST>[0];
const parametre = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  batchWrite.mockResolvedValue(true);
});

// ─── #4 Silinmiş poşet/kutu: "bilinmeyen" sayılır, sessizce 0 değil ─────────
describe("silinmiş paketleme seçeneği", () => {
  it("seçili seçenek ayarlarda yoksa bayrak kalkar, tutar uydurulmaz", () => {
    const s = parsePackagingSettings(AYARLAR);
    const sonuc = computePackagingCost({ packagingOptionId: "silinmis", nylonLevel: null, tapeUsed: false }, s);
    expect(sonuc.secenekBulunamadi).toBe(true);
    const normal = computePackagingCost({ packagingOptionId: "kutu", nylonLevel: null, tapeUsed: false }, s);
    expect(normal.secenekBulunamadi).toBeUndefined();
    const yok = computePackagingCost({ packagingOptionId: null, nylonLevel: null, tapeUsed: false }, s);
    expect(yok.secenekBulunamadi).toBeUndefined();
  });

  it("ürün maliyeti TAM sayılmaz (sipariş kârına 'maliyet eksik' olarak düşer)", () => {
    const urun = (packagingOptionId: string | null) => ({
      costMode: "detailed",
      manualCost: null,
      totalCost: null,
      filamentWeight: 50,
      printTimeHours: 2,
      wasteRate: 0,
      packagingOptionId,
      nylonLevel: null,
      tapeUsed: false,
    });
    expect(resolveProductCost(urun("kutu"), AYARLAR, 0.5, new Map())?.productionCostKnown).toBe(true);
    expect(resolveProductCost(urun(null), AYARLAR, 0.5, new Map())?.productionCostKnown).toBe(true);
    expect(resolveProductCost(urun("silinmis"), AYARLAR, 0.5, new Map())?.productionCostKnown).toBe(false);
  });
});

// ─── #10 Kâr dökümü: fiyat değişince fark "Diğer"e değil ürün satırına ──────
describe("kâr dökümü — kayıtlı kârla tutarlı ürün satırı", () => {
  // İç tutarlı motor: 400 − (60 + 50 + 120 + 10 + 40 KDV) = 120 kâr.
  const motor = (ek: Record<string, unknown> = {}) => ({
    profit: 120,
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
  const satir = (d: ReturnType<typeof karDokumuTopla>, key: string) => d.lines.find((l) => l.key === key)?.amount ?? 0;
  const toplam = (d: ReturnType<typeof karDokumuTopla>) => d.lines.reduce((t, l) => t + l.amount, 0);

  it("filament zam gördü (bugünkü hesap 20₺ az kâr): ürün satırı sipariş anındaki maliyeti gösterir", () => {
    const d = karDokumuTopla("2026-10", [
      // Kayıtlı kâr 120; bugün aynı sipariş 140₺ ürün maliyetiyle 100₺ çıkıyor.
      { statusKind: "delivered", currency: "TRY", revenueKurus: 40000, profitKurus: 12000, sonuc: motor({ productAndPackagingCost: 140, profit: 100 }) },
    ] as never);
    expect(satir(d, "urun")).toBeCloseTo(120, 2);
    expect(satir(d, "diger")).toBe(0);
    expect(d.revenue - toplam(d)).toBeCloseTo(120, 2); // toplam kâr DEĞİŞMEZ
  });

  it("fiyat değişmediyse kısmi siparişte de satırlar kaymaz", () => {
    const d = karDokumuTopla("2026-10", [
      { statusKind: "delivered", currency: "TRY", revenueKurus: 50000, profitKurus: 12000, sonuc: motor({ unmatchedRevenue: 100 }) },
    ] as never);
    expect(satir(d, "urun")).toBeCloseTo(120, 2);
    expect(d.revenue - d.unknownCostRevenue - toplam(d)).toBeCloseTo(120, 2);
  });

  it("ürün satırı hiçbir durumda eksiye düşmez", () => {
    const d = karDokumuTopla("2026-10", [
      { statusKind: "delivered", currency: "TRY", revenueKurus: 40000, profitKurus: 30000, sonuc: motor() },
    ] as never);
    expect(satir(d, "urun")).toBeGreaterThanOrEqual(0);
    expect(d.revenue - toplam(d)).toBeCloseTo(300, 2);
  });
});

// ─── Ayar kaydı: doğrulama, yalnız değişen anahtar, önbellek HER HÂLDE düşer ─
describe("POST /api/settings", () => {
  it("eksi maliyet reddedilir, hiçbir şey yazılmaz", async () => {
    const yanit = await ayarlarRotasi.POST(istek({ costLaborPerHour: "-3" }));
    expect(yanit.status).toBe(400);
    expect((await yanit.json()).error).toMatch(/sıfır ya da pozitif/);
    expect(batchWrite).not.toHaveBeenCalled();
    expect(db.appSetting.findMany).not.toHaveBeenCalled();
  });

  it("yalnız DEĞİŞEN anahtarlar tek istekte yazılır", async () => {
    db.appSetting.findMany.mockResolvedValue([
      { key: "costLaborPerHour", value: "10" },
      { key: "costMachineWearPerHour", value: "4" },
    ]);
    const yanit = await ayarlarRotasi.POST(istek({ costLaborPerHour: "12", costMachineWearPerHour: "4" }));
    expect(await yanit.json()).toEqual({ ok: true, degisen: 1 });
    expect(batchWrite).toHaveBeenCalledTimes(1);
    expect(batchWrite.mock.calls[0][0]).toHaveLength(1);
    expect(batchWrite.mock.calls[0][0][0].args).toEqual(["costLaborPerHour", "12"]);
    expect(busts.bustProfitInputCaches).toHaveBeenCalled();
  });

  it("hiçbir şey değişmediyse yazma yok, kâr önbelleği düşmez", async () => {
    db.appSetting.findMany.mockResolvedValue([{ key: "costLaborPerHour", value: "10" }]);
    await ayarlarRotasi.POST(istek({ costLaborPerHour: "10" }));
    expect(batchWrite).not.toHaveBeenCalled();
    expect(busts.bustProfitInputCaches).not.toHaveBeenCalled();
    expect(busts.bustCache).toHaveBeenCalledWith("settings:");
  });

  it("toplu yazma desteklenmezse tek işlemde yazılır", async () => {
    db.appSetting.findMany.mockResolvedValue([]);
    batchWrite.mockResolvedValue(false);
    db.$transaction.mockResolvedValue([]);
    await ayarlarRotasi.POST(istek({ costLaborPerHour: "12" }));
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("yazma patlasa da önbellekler düşer", async () => {
    db.appSetting.findMany.mockResolvedValue([]);
    batchWrite.mockRejectedValue(new Error("ağ koptu"));
    const yanit = await ayarlarRotasi.POST(istek({ costLaborPerHour: "12" }));
    expect(yanit.status).toBeGreaterThanOrEqual(400);
    expect(busts.bustProfitInputCaches).toHaveBeenCalled();
    expect(busts.bustCache).toHaveBeenCalledWith("settings:");
  });
});

// ─── Filament: kg fiyatı yanlış alana yazılamaz, gereksiz önbellek düşmez ─────
describe("filament doğrulama ve güncelleme", () => {
  it("gram fiyatı 0 < x ≤ 20; ad kırpılır", () => {
    expect(FilamentSemasi.safeParse({ name: "PLA", costPerGram: 650 }).success).toBe(false);
    expect(FilamentSemasi.safeParse({ name: "PLA", costPerGram: 0 }).success).toBe(false);
    expect(FilamentSemasi.safeParse({ name: "   ", costPerGram: 1 }).success).toBe(false);
    const iyi = FilamentSemasi.parse({ name: "  PLA Mat  ", costPerGram: 0.65 });
    expect(iyi).toEqual({ name: "PLA Mat", costPerGram: 0.65, isActive: true });
  });

  it("kısmi güncelleme pasif filamenti kendiliğinden açmaz", () => {
    expect(FilamentSemasi.partial().parse({ costPerGram: 1 })).toEqual({ costPerGram: 1 });
  });

  it("yalnız FİYAT değişince kâr önbelleği düşer", async () => {
    db.filamentType.findUnique.mockResolvedValue({ costPerGram: 0.65 });
    db.filamentType.update.mockResolvedValue({ id: "f1" });
    await filamentRotasi.PATCH(istek({ name: "Yeni ad" }), parametre("f1"));
    await filamentRotasi.PATCH(istek({ costPerGram: 0.65 }), parametre("f1"));
    expect(busts.bustProfitInputCaches).not.toHaveBeenCalled();
    await filamentRotasi.PATCH(istek({ costPerGram: 0.7 }), parametre("f1"));
    expect(busts.bustProfitInputCaches).toHaveBeenCalledTimes(1);
  });

  it("olmayan filament 404 döner (güncelleme ve silme)", async () => {
    db.filamentType.findUnique.mockResolvedValue(null);
    const g = await filamentRotasi.PATCH(istek({ name: "x" }), parametre("yok"));
    const s = await filamentRotasi.DELETE(istek({}), parametre("yok"));
    expect(g.status).toBe(404);
    expect(s.status).toBe(404);
    expect(db.filamentType.update).not.toHaveBeenCalled();
    expect(db.filamentType.delete).not.toHaveBeenCalled();
  });
});
