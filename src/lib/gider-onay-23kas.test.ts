/**
 * Gider Ödemeleri + reklam bütçesi — Berke'nin onayladığı 6 madde (23 Kas 2026). SAF kurallar.
 *
 * Her madde iki tür testle kilitlenir:
 *   • EŞİTLİK — bugünkü veride (reklam bütçesi YOK, giderlerde KDV oranı YOK, atla satırı YOK)
 *     yeni kural eski rakamı birebir verir. Bu düzeltmelerin bugünkü kâra etkisi SIFIR.
 *   • YENİ DAVRANIŞ — oran/bütçe girildiğinde doğru çalışır.
 *
 * Veritabanına dokunan kısımlar: `gider-onay-23kas-db.test.ts`; telefon: `mobile-gider-onay-23kas.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  GIDER_KDV_ORANLARI,
  gecerliGiderKdvOrani,
  giderKdvAyir,
  giderKdvEtiketi,
  giderNetKurus,
} from "@/core/gider-kdv";
import { gecerliButce, reklamOraniIcin, type DonemliButce } from "@/core/ad-cost";
import { aggregateMonthlyFinance, aggregateWeeklyFinance } from "@/lib/monthly-finance";

/* ── reklam oranı servisi için sahte veritabanı (yalnız bu dosyada) ─────────────────────────── */
const db = vi.hoisted(() => ({
  hata: false,
  butceler: [] as Record<string, unknown>[],
  ciro: 0,
  findMany: 0,
  bekle: null as Promise<void> | null,
  sorgular: [] as unknown[][],
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRawUnsafe: async (...args: unknown[]) => {
      if (String(args[0]).includes(`FROM "AdBudget"`)) {
        db.findMany++;
        if (db.bekle) await db.bekle;
        if (db.hata) throw new Error("ağ koptu");
        return db.butceler;
      }
      db.sorgular.push(args);
      return [{ ciro: db.ciro }];
    },
  },
}));

/* ═════════════════════════ 17 · Gider KDV'si (çekirdek kural) ═════════════════════════ */

describe("17 · gider KDV'si — tek çekirdek kural", () => {
  it("KDV dahil tutardan net ve KDV ayrılır (kuruş tamsayı)", () => {
    expect(giderKdvAyir(12_000, 20)).toEqual({ netKurus: 10_000, kdvKurus: 2_000 });
    expect(giderKdvAyir(11_000, 10)).toEqual({ netKurus: 10_000, kdvKurus: 1_000 });
    expect(giderKdvAyir(10_100, 1)).toEqual({ netKurus: 10_000, kdvKurus: 100 });
    // 100 / 1,2 = 83,33 → 83; KDV farktan çıkar (17) — toplam kaybolmaz.
    expect(giderKdvAyir(100, 20)).toEqual({ netKurus: 83, kdvKurus: 17 });
  });

  it("net + KDV her zaman tutara eşit (yuvarlama kuruş kaybettirmez)", () => {
    for (const oran of GIDER_KDV_ORANLARI) {
      for (let tutar = 1; tutar <= 5_000; tutar += 7) {
        const { netKurus, kdvKurus } = giderKdvAyir(tutar, oran);
        expect(netKurus + kdvKurus).toBe(tutar);
        expect(Number.isInteger(netKurus)).toBe(true);
        expect(kdvKurus).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("EŞİTLİK: oran boş / 0 / geçersiz → net = tutar, KDV = 0 (eski kayıtlar değişmez)", () => {
    for (const oran of [null, undefined, 0, "", "abc", -5, 100, 250, Number.NaN]) {
      expect(giderKdvAyir(12_345, oran)).toEqual({ netKurus: 12_345, kdvKurus: 0 });
      expect(giderNetKurus(12_345, oran)).toBe(12_345);
      expect(gecerliGiderKdvOrani(oran)).toBeNull();
    }
  });

  it("listede kısa etiket", () => {
    expect(giderKdvEtiketi(20)).toBe("KDV %20");
    expect(giderKdvEtiketi(1)).toBe("KDV %1");
    expect(giderKdvEtiketi(null)).toBeNull();
    expect(giderKdvEtiketi(0)).toBeNull();
  });
});

/* ═════════════════════ 17 · Aylık net kâr + KDV özeti (Raporlar, Panel) ═════════════════════ */

const NOW = new Date("2026-11-23T12:00:00.000Z");
const siparisler = [
  {
    platform: "trendyol",
    orderedAt: new Date("2026-11-05T10:00:00.000Z"),
    revenueKurus: 50_000,
    profitKurus: 12_000,
    profitPartial: false,
    statusKind: "delivered",
    currency: "TRY",
    outputVatKurus: 8_333,
    inputVatCreditKurus: 1_000,
  },
  {
    platform: "shopify",
    orderedAt: new Date("2026-10-12T10:00:00.000Z"),
    revenueKurus: 30_000,
    profitKurus: 9_000,
    profitPartial: false,
    statusKind: "delivered",
    currency: "TRY",
    outputVatKurus: 5_000,
    inputVatCreditKurus: 700,
  },
];
const giderler = (vatRate?: number | null) => [
  { paidAt: new Date("2026-11-03T09:00:00.000Z"), amountKurus: 12_000, category: "Yazılım", ...(vatRate === undefined ? {} : { vatRate }) },
  { paidAt: new Date("2026-10-20T09:00:00.000Z"), amountKurus: 4_500, category: "Kira" },
];

describe("17 · aylık net kâr gideri NET tutarla düşer, KDV indirilecek KDV'ye girer", () => {
  it("EŞİTLİK: KDV oranı olmayan giderlerde rakamlar eski formülle birebir aynı", () => {
    const yeni = aggregateMonthlyFinance({ snapshots: siparisler, expenses: giderler(), monthCount: 3, now: NOW });
    const kasim = yeni.find((m) => m.month === "2026-11")!;
    const ekim = yeni.find((m) => m.month === "2026-10")!;
    // Eski formül: net kâr = sipariş kârı − giderin TAMAMI; indirilecek KDV yalnız siparişlerden.
    expect(kasim.expenses).toBe(120);
    expect(kasim.netProfit).toBe(120 - 120);
    expect(kasim.vat.inputVatCredit).toBe(10);
    expect(ekim.expenses).toBe(45);
    expect(ekim.netProfit).toBe(90 - 45);
    expect(ekim.vat.inputVatCredit).toBe(7);
    // null / undefined / 0 → aynı çıktı.
    for (const oran of [null, 0]) {
      expect(aggregateMonthlyFinance({ snapshots: siparisler, expenses: giderler(oran), monthCount: 3, now: NOW })).toEqual(yeni);
    }
  });

  it("%20 KDV'li gider: net kârdan KDV hariç düşer, KDV o ayın indirilecek KDV'sine eklenir", () => {
    const sonuc = aggregateMonthlyFinance({ snapshots: siparisler, expenses: giderler(20), monthCount: 3, now: NOW });
    const kasim = sonuc.find((m) => m.month === "2026-11")!;
    expect(kasim.expenses).toBe(100); // 120 ₺ KDV dahil → 100 ₺ net
    expect(kasim.netProfit).toBe(120 - 100); // eskiden 0 görünüyordu (KDV kadar düşük)
    expect(kasim.vat.inputVatCredit).toBe(10 + 20);
    expect(kasim.vat.payable).toBe(83.33 - 30);
    expect(kasim.expensesByCategory).toEqual([{ category: "Yazılım", amount: 100, count: 1 }]);
    // KDV'siz Ekim gideri etkilenmez.
    expect(sonuc.find((m) => m.month === "2026-10")!.expenses).toBe(45);
  });

  it("haftalık görünüm aynı kuralı kullanır (eşitlik + KDV'li)", () => {
    const eski = aggregateWeeklyFinance({ snapshots: siparisler, expenses: giderler(), weekCount: 12, now: NOW });
    expect(aggregateWeeklyFinance({ snapshots: siparisler, expenses: giderler(null), weekCount: 12, now: NOW })).toEqual(eski);
    const kdvli = aggregateWeeklyFinance({ snapshots: siparisler, expenses: giderler(20), weekCount: 12, now: NOW });
    const toplam = (l: typeof eski) => l.reduce((t, w) => t + w.expenses, 0);
    expect(toplam(eski)).toBeCloseTo(165, 2);
    expect(toplam(kdvli)).toBeCloseTo(145, 2);
  });
});

/* ═══════════════ 14 · "Reklamı durdur" geçmiş payı silmez — okuyucu validTo'yu uygular ═══════════════ */

describe("14 · durdurulan dönem: bitişten önceki siparişler payını taşımaya devam eder", () => {
  const AGU = Date.parse("2026-08-01T00:00:00+03:00");
  const DURDU = Date.parse("2026-08-15T12:00:00+03:00");
  const durdurulan: DonemliButce = { platform: "trendyol", dailyAmount: 100, validFrom: AGU, validTo: DURDU, isActive: true, oran: 0.1 };

  it("validTo öncesi sipariş oranı taşır, sonrası taşımaz (sipariş KENDİ tarihiyle)", () => {
    expect(reklamOraniIcin([durdurulan], "trendyol", Date.parse("2026-08-10T10:00:00+03:00"))).toBe(0.1);
    expect(reklamOraniIcin([durdurulan], "trendyol", DURDU)).toBe(0.1); // bitiş dahil
    expect(reklamOraniIcin([durdurulan], "trendyol", DURDU + 1)).toBe(0);
    expect(reklamOraniIcin([durdurulan], "trendyol", AGU - 1)).toBe(0);
  });

  it("isActive=0 dönemin TÜMÜNÜ eler — telefonun eski 'durdur'u bu yüzden geçmişi siliyordu", () => {
    const eskiDurdur = { ...durdurulan, isActive: false };
    expect(gecerliButce([eskiDurdur], "trendyol", Date.parse("2026-08-10T10:00:00+03:00"))).toBeNull();
  });
});

/* ═══════════════════ 15 · Reklam oranı okunamazsa "bilinmiyor" — önbelleğe girmez ═══════════════════ */

describe("15 · reklam oranı okunamazsa bilinmiyor döner ve önbelleğe girmez", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__mlhub_adRateCache;
    Object.assign(db, { hata: false, butceler: [], ciro: 0, findMany: 0, bekle: null, sorgular: [] });
  });

  it("EŞİTLİK: bütçe yokken boş ve BİLİNEN sonuç (oran 0, kâr yazımı serbest)", async () => {
    const { adRateSnapshot, reklamOraniYakindaOkunamadi } = await import("@/lib/ad-rate");
    const snap = await adRateSnapshot();
    expect(snap.bilinmiyor).toBeFalsy();
    expect(snap.butceler).toEqual([]);
    expect(reklamOraniYakindaOkunamadi()).toBe(false);
  });

  it("hata → bilinmiyor; önbelleğe girmez, sonraki çağrı yeniden okur", async () => {
    const { adRateSnapshot, reklamOraniYakindaOkunamadi } = await import("@/lib/ad-rate");
    db.hata = true;
    const hatali = await adRateSnapshot();
    expect(hatali.bilinmiyor).toBe(true);
    expect(hatali.butceler).toEqual([]);
    expect(reklamOraniYakindaOkunamadi()).toBe(true); // kâr yazan yollar bu turu atlar

    db.hata = false;
    db.butceler = [{ platform: "all", dailyAmount: 100, bas: Date.parse("2026-11-01T00:00:00Z"), bit: null }];
    db.ciro = 10_000;
    const ikinci = await adRateSnapshot();
    expect(db.findMany).toBe(2); // eskiden 5 dk boyunca boş (oran 0) önbellekten dönüyordu
    expect(ikinci.bilinmiyor).toBeFalsy();
    expect(ikinci.butceler).toHaveLength(1);
    expect(ikinci.butceler[0].oran).toBeGreaterThan(0);
    // Az önceki hata penceresi kapanana kadar ilk yakalama yine bekler (o turun kârı reklamsızdı).
    expect(reklamOraniYakindaOkunamadi()).toBe(true);
    expect(reklamOraniYakindaOkunamadi(Date.now() + 3 * 60_000)).toBe(false);
  });

  it("başarılı okuma önbelleğe girer; ciro sorgusu tarihleri dbEpochMs ile karşılaştırır", async () => {
    const { adRateSnapshot } = await import("@/lib/ad-rate");
    db.butceler = [{ platform: "trendyol", dailyAmount: 50, bas: Date.parse("2026-11-01T00:00:00Z"), bit: null }];
    await adRateSnapshot();
    await adRateSnapshot();
    expect(db.findMany).toBe(1);
    const [sql, bas, bit, platform] = db.sorgular[0] as [string, unknown, unknown, unknown];
    expect(sql).toContain("julianday");
    expect(typeof bas).toBe("number");
    expect(typeof bit).toBe("number");
    expect(platform).toBe("trendyol");
  });

  it("bütçe değişirken süren eski okuma önbelleğe YAZILMAZ", async () => {
    const { adRateSnapshot, bustAdRateCache } = await import("@/lib/ad-rate");
    let birak!: () => void;
    db.bekle = new Promise<void>((r) => (birak = r));
    const suren = adRateSnapshot(); // eski veriyi okuyor
    bustAdRateCache(); // bu arada bütçe kaydedildi
    birak();
    await suren;
    db.bekle = null;
    await adRateSnapshot();
    expect(db.findMany).toBe(2); // eski sonuç önbellekte kalmadı → yeniden okundu
  });
});
