import { describe, expect, it, vi } from "vitest";
import type { TyGecikme } from "@/core/trendyol-gecikme";

// Saf kural testi — veritabanı / pazaryeri istemcisi açılmaz.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/order-finance-snapshots", () => ({ recalculateFinanceMonths: async () => ({}) }));

const { tyGecmisGuncellemeleri } = await import("./ty-ceza-gecmisi");

const GUN = 86_400_000;
const pencereBas = Date.parse("2026-09-24T00:00:00Z");
const eski = Date.parse("2026-08-01T10:00:00Z");

const satir = (id: string, ek: Partial<Parameters<typeof tyGecmisGuncellemeleri>[0][number]> = {}) => ({
  externalOrderId: id,
  orderedAtMs: eski,
  statusKind: "delivered",
  penaltyKurus: null,
  delayInfo: null,
  returnLossKurus: null,
  adet: null,
  ...ek,
});

const gecikme = (ceza: number): TyGecikme => ({
  sonGun: "2026-07-31",
  tolerans: "2026-08-01",
  kargolanma: Date.parse("2026-08-03T09:00:00Z"),
  gecikti: true,
  kargolanmadi: false,
  ceza,
  muaf: false,
});

const bos = { gecikmeler: null, kusurlular: new Map(), iadeler: new Map() };

describe("geçmiş Trendyol cezaları ve iade zararı", () => {
  it("pencere içindeki kayda dokunmaz (orası siparişler ucunun işi)", () => {
    const u = tyGecmisGuncellemeleri([satir("ty-1", { orderedAtMs: pencereBas + GUN })], {
      ...bos,
      pencereBas,
      kusurlular: new Map([["ty-1", { ceza: 120, durum: "gercek" as const }]]),
    });
    expect(u).toEqual([]);
  });

  it("gecikme taraması gecikme bilgisini ve bedeli yazar", () => {
    const u = tyGecmisGuncellemeleri([satir("ty-2")], {
      ...bos,
      pencereBas,
      gecikmeler: new Map([["ty-2", { g: gecikme(100), s: { ceza: 100, durum: "gercek" as const } }]]),
    });
    expect(u).toHaveLength(1);
    expect(u[0].penaltyKurus).toBe(10000);
    expect(JSON.parse(u[0].delayInfo!)).toMatchObject({ gecikti: true, ceza: 100, durum: "gercek", tolerans: "2026-08-01" });
  });

  it("kusurlu iade: ceza + iade zararı işareti (yeniden hesap zararı üretir)", () => {
    const u = tyGecmisGuncellemeleri([satir("ty-3", { statusKind: "cancelled", adet: 1 })], {
      ...bos,
      pencereBas,
      kusurlular: new Map([["ty-3", { ceza: 180, durum: "gercek" as const }]]),
      iadeler: new Map([["ty-3", { kabulAdet: 1, satirSayisi: 1 }]]),
    });
    expect(u).toEqual([
      { externalOrderId: "ty-3", orderedAtMs: eski, penaltyKurus: 18000, delayInfo: null, returnLossKurus: 0 },
    ]);
  });

  it("kısmi iadede zarar işareti konmaz; zararı kayıtlı iadeye dokunulmaz", () => {
    const u = tyGecmisGuncellemeleri(
      [
        satir("ty-4", { statusKind: "cancelled", adet: 2 }),
        satir("ty-5", { statusKind: "cancelled", adet: 1, returnLossKurus: 9150 }),
      ],
      {
        ...bos,
        pencereBas,
        iadeler: new Map([
          ["ty-4", { kabulAdet: 1, satirSayisi: 1 }],
          ["ty-5", { kabulAdet: 1, satirSayisi: 1 }],
        ]),
      }
    );
    expect(u).toEqual([]);
  });

  it("gecikme ile kusurlu bedel toplanır; talep bilinmeyince kayıtlı kusurlu payı korunur", () => {
    const delayInfo = JSON.stringify({ ceza: 50, durum: "gercek" });
    // 50 gecikme + 120 kusurlu kayıtlı; talep artık 150 günlük listede değil → aynı kalır.
    const korunan = tyGecmisGuncellemeleri([satir("ty-6", { penaltyKurus: 17000, delayInfo })], { ...bos, pencereBas });
    expect(korunan).toEqual([]);
    // Kusurlu bedel faturayla "kesilmedi"ye döndü → yalnız gecikme kalır.
    const u = tyGecmisGuncellemeleri([satir("ty-6", { penaltyKurus: 17000, delayInfo })], {
      ...bos,
      pencereBas,
      kusurlular: new Map([["ty-6", { ceza: 0, durum: "kesilmedi" as const }]]),
    });
    expect(u[0].penaltyKurus).toBe(5000);
  });

  it("değişmeyen kayıt yazılmaz (ikinci tur boş)", () => {
    const g = new Map([["ty-7", { g: gecikme(180), s: { ceza: 180, durum: "gercek" as const } }]]);
    const [ilk] = tyGecmisGuncellemeleri([satir("ty-7")], { ...bos, pencereBas, gecikmeler: g });
    const ikinci = tyGecmisGuncellemeleri(
      [satir("ty-7", { penaltyKurus: ilk.penaltyKurus, delayInfo: ilk.delayInfo })],
      { ...bos, pencereBas, gecikmeler: g }
    );
    expect(ikinci).toEqual([]);
  });

  it("zamanında kargolanan eski sipariş: gecikme bilgisi yazılır, bedel yok", () => {
    const u = tyGecmisGuncellemeleri([satir("ty-8")], {
      ...bos,
      pencereBas,
      gecikmeler: new Map([
        ["ty-8", { g: { ...gecikme(0), gecikti: false }, s: { ceza: 0, durum: "zamaninda" as const } }],
      ]),
    });
    expect(u[0].penaltyKurus).toBeNull();
    expect(JSON.parse(u[0].delayInfo!)).toMatchObject({ gecikti: false, durum: "zamaninda" });
  });
});
