/**
 * Filament denetimi (23 Kas 2026) — düzeltmelerin bekçi testleri.
 * Veritabanı açılmaz: uçlar ve telefon veri katmanı sahte bağımlılıklarla koşar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  appSetting: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  filamentSpool: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}));
const batchWrite = vi.hoisted(() => vi.fn());
const turso = vi.hoisted(() => ({ writeBatch: vi.fn(), execute: vi.fn(), query: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/libsql-batch", () => ({ batchWrite }));
vi.mock("@/lib/runtime-schema", () => ({ ensureRuntimeSchema: async () => {} }));
vi.mock("@/lib/cache-busting", () => ({ bustInventoryAlertCaches: vi.fn(), bustProfitInputCaches: vi.fn() }));
vi.mock("@/lib/filament-settings", () => ({ watchFilamentGroup: vi.fn(async () => {}), FILAMENT_SETTING_PREFIX: "filament" }));
vi.mock("@/lib/route-cache", () => ({ bustCache: vi.fn(), swr: vi.fn() }));
vi.mock("@/lib/r2", () => ({ invalidateR2Config: vi.fn() }));
// Telefon veri katmanı (mobile/src/lib/db/spools.ts) "@/lib/turso"yu içe aktarır.
vi.mock("@/lib/turso", () => turso);

const { filamentAyarlariniCoz, esikBul, ozelEsikVarMi, FILAMENT_COLORS } = await import("@/core/filament-groups");
const { renkCipleri, filamentStokDurumu, TEMEL_RENKLER } = await import("@/core/filament-stok");
const { filamentTuketimi } = await import("./filament-tuketim");
const ayarRotasi = await import("@/app/api/settings/route");
const topluRota = await import("@/app/api/spools/batch/route");
const makaraRotasi = await import("@/app/api/spools/[id]/route");
// Değişken yollu içe aktarma: kök tsc mobil modülün "@/lib/turso" bağımlılığını izlemesin.
const TELEFON_YOLU = "../../mobile/src/lib/db/spools";
type TelefonGirdi = Record<string, unknown>;
const telefon = (await import(/* @vite-ignore */ TELEFON_YOLU)) as {
  createSpool: (s: TelefonGirdi) => Promise<void>;
  updateSpool: (id: string, s: TelefonGirdi) => Promise<void>;
  deleteSpool: (id: string) => Promise<void>;
  spoolStatus: (s: TelefonGirdi) => string;
};

const istek = (govde: unknown) => ({ json: async () => govde }) as never;
const parametre = (id: string) => ({ params: Promise.resolve({ id }) });
const makara = (ek: Record<string, unknown> = {}) => ({
  id: "s1", material: "PLA", colorKey: "siyah", colorName: "Siyah", colorHex: "#000000",
  totalGrams: 1000, remainingGrams: 1000, openedAt: null, ...ek,
});
const TEMEL = FILAMENT_COLORS.filter((c) => (TEMEL_RENKLER as readonly string[]).includes(c.key));

beforeEach(() => {
  vi.clearAllMocks();
  batchWrite.mockResolvedValue(true);
  turso.writeBatch.mockResolvedValue([]);
});

describe("filament ayarları — tek okuma kuralı", () => {
  it("boş renk eşiği YOK sayılır (eskiden sayfa 0, zil 1 okuyordu)", () => {
    const ayar = filamentAyarlariniCoz({ filamentLowSpoolCount: "2", "filamentThreshold:PLA__siyah": "" });
    expect(ozelEsikVarMi("PLA__siyah", ayar)).toBe(false);
    expect(esikBul("PLA__siyah", ayar)).toBe(2);
  });

  it("renge özel eşik genel eşiği ezer; en az 1", () => {
    const ayar = filamentAyarlariniCoz({ filamentLowSpoolCount: "2", "filamentThreshold:PLA__siyah": "0", "filamentThreshold:PLA__gri": "4" });
    expect(esikBul("PLA__siyah", ayar)).toBe(1);
    expect(esikBul("PLA__gri", ayar)).toBe(4);
    expect(esikBul("PLA__mavi", ayar)).toBe(2);
  });

  it("izlenen ve susturulan gruplar okunur", () => {
    const ayar = filamentAyarlariniCoz({ "filamentWatch:PLA__mor": "Mor PLA", "filamentMute:PLA__ten": "1", "filamentMute:PLA__x": "0" });
    expect(ayar.watchedGroups).toEqual([{ key: "PLA__mor", label: "Mor PLA" }]);
    expect(ayar.mutedGroups).toEqual(["PLA__ten"]);
  });
});

describe("stok çipleri", () => {
  it("biten ve izlenen Siyah PLA, elde Siyah PETG varken de görünür; iki çipte tür yazar", () => {
    const { cipler } = filamentStokDurumu([makara({ material: "PETG" })], { "filamentWatch:PLA__siyah": "Siyah PLA" });
    const siyahlar = cipler.filter((c) => c.colorKey === "siyah");
    expect(siyahlar.map((c) => c.key).sort()).toEqual(["PETG__siyah", "PLA__siyah"]);
    expect(siyahlar.every((c) => c.turuGoster)).toBe(true);
    expect(siyahlar.find((c) => c.key === "PLA__siyah")?.durum).toBe("biten");
  });

  it("hiç alınmamış temel renk gerçek grup anahtarını taşır (susturma eşleşsin)", () => {
    const cipler = renkCipleri([], () => 1, 1, TEMEL);
    expect(cipler.map((c) => c.key).sort()).toEqual(["PLA__beyaz", "PLA__gri", "PLA__siyah"]);
  });

  it("kapalı makarası kalmayan ama açığı olan renk 'biten' sayılır, grubu açık makarayı bilir", () => {
    const { cipler } = filamentStokDurumu([makara({ remainingGrams: 400, openedAt: "2026-11-01T00:00:00.000Z" })], {});
    const siyah = cipler.find((c) => c.key === "PLA__siyah");
    expect(siyah?.durum).toBe("biten");
    expect(siyah?.group?.openCount).toBe(1);
  });
});

describe("kaç gün yeter — fire ORAN", () => {
  it("0,1 fire ×1,1 sayılır", () => {
    const t = filamentTuketimi([{ quantity: 10, filamentWeight: 100, ekFilamentlerJson: null, wasteRate: 0.1 }], 1000, 0, 300 * 86_400_000);
    expect(t.toplamGram).toBeCloseTo(1100, 6);
  });
});

describe("POST /api/settings — null anahtarı siler", () => {
  it("var olan renk eşiği silinir, olmayan için boşuna yazma yapılmaz", async () => {
    db.appSetting.findMany.mockResolvedValue([{ key: "filamentThreshold:PLA__siyah", value: "3" }]);
    const yanit = await ayarRotasi.POST(istek({ "filamentThreshold:PLA__siyah": null, "filamentThreshold:PLA__yok": null }));
    expect(await yanit.json()).toEqual({ ok: true, degisen: 1 });
    const ifadeler = batchWrite.mock.calls[0][0] as Array<{ sql: string; args: unknown[] }>;
    expect(ifadeler).toHaveLength(1);
    expect(ifadeler[0].sql).toMatch(/DELETE FROM "AppSetting"/);
    expect(ifadeler[0].args).toEqual(["filamentThreshold:PLA__siyah"]);
  });
});

describe("toplu makara ekleme", () => {
  it("N makara TEK istekte yazılır", async () => {
    const yanit = await topluRota.POST(istek({ quantity: 3, material: "PLA", colorName: "Mor", totalGrams: 1000 }));
    expect(yanit.status).toBe(201);
    expect(await yanit.json()).toEqual({ count: 3 });
    expect(batchWrite).toHaveBeenCalledTimes(1);
    expect(batchWrite.mock.calls[0][0]).toHaveLength(3);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("toplu yazma desteklenmezse tek işlemde yazılır", async () => {
    batchWrite.mockResolvedValue(false);
    db.$transaction.mockResolvedValue([]);
    await topluRota.POST(istek({ quantity: 2, material: "PLA", colorName: "Mor" }));
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("makara düzenleme", () => {
  it("kalan toplamdan büyükse reddedilir", async () => {
    db.filamentSpool.findUnique.mockResolvedValue(makara());
    const yanit = await makaraRotasi.PATCH(istek({ remainingGrams: 1200 }), parametre("s1"));
    expect(yanit.status).toBe(400);
    expect(db.filamentSpool.update).not.toHaveBeenCalled();
  });
});

describe("telefon veri katmanı", () => {
  const girdi = {
    name: "Mor PLA", material: "PLA", colorName: "Mor", colorHex: "#8B5CF6", brand: null,
    totalGrams: 1000, remainingGrams: 1000, reorderGrams: 200, spoolCost: null,
  };

  it("eklenen makaranın rengi izlemeye alınır (aynı istekte)", async () => {
    await telefon.createSpool(girdi);
    const ifadeler = turso.writeBatch.mock.calls[0][0] as Array<{ sql: string; args: unknown[] }>;
    expect(ifadeler).toHaveLength(2);
    expect(ifadeler[1].sql).toMatch(/INSERT INTO AppSetting/);
    expect(ifadeler[1].args).toEqual(["filamentWatch:PLA__mor", "Mor PLA"]);
  });

  it("düzenleme açık/kapalı damgasını gramla eşitler", async () => {
    await telefon.updateSpool("s1", girdi);
    const ifade = (turso.writeBatch.mock.calls[0][0] as Array<{ sql: string }>)[0];
    expect(ifade.sql).toMatch(/openedAt = CASE WHEN \? >= \? - 1 THEN NULL ELSE COALESCE\(openedAt, \?\) END/);
  });

  it("silme tüketim kayıtlarını da aynı istekte siler", async () => {
    await telefon.deleteSpool("s1");
    const ifadeler = turso.writeBatch.mock.calls[0][0] as Array<{ sql: string }>;
    expect(ifadeler.map((i) => i.sql)).toEqual([
      "DELETE FROM FilamentUsage WHERE spoolId = ?",
      "DELETE FROM FilamentSpool WHERE id = ?",
    ]);
  });

  it("makara durumu: bitti / kapalı / açık (gram eşiği yok)", () => {
    const tam = { ...girdi, id: "a", colorKey: null, openedAt: null };
    expect(telefon.spoolStatus(tam)).toBe("sealed");
    expect(telefon.spoolStatus({ ...tam, remainingGrams: 150, openedAt: "2026-11-01" })).toBe("open");
    expect(telefon.spoolStatus({ ...tam, remainingGrams: 0 })).toBe("empty");
  });
});
