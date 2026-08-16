/**
 * REKLAM PAYI — dağıtım matematiği ve dönem seçimi.
 *
 * Bu hesap doğrudan KÂR RAKAMINI değiştiriyor, o yüzden davranışı burada kilitleniyor:
 * oranın nasıl kurulduğu, sıfır/bozuk girdide patlamadığı, ve siparişin KENDİ tarihindeki
 * bütçeyi kullandığı (yoksa bütçe değişince geçmiş kârlar da kayardı).
 */
import { describe, expect, it } from "vitest";
import { reklamOrani, reklamPayi, gecerliButce, reklamOraniIcin, REKLAM_PENCERE_GUN } from "./ad-cost";

describe("reklam oranı", () => {
  it("bütçeyi ciroya oranlar — gerçek ölçümle aynı sonuç", () => {
    // Ölçülen veri: 31 gün, günlük ortalama ciro 4.276,75 ₺ → pencere cirosu ~132.579 ₺.
    const r = reklamOrani({ gunlukTutar: 800, gunSayisi: 31, pencereCirosu: 4276.75 * 31 });
    expect(r.toplamHarcama).toBe(24_800);
    expect(r.oran).toBeCloseTo(0.1871, 4); // %18,71
    expect(r.guvenilir).toBe(true);
    expect(r.cirodanBuyuk).toBe(false);
  });

  it("CİRO YOKSA oran 0 — sonsuz/NaN üretmez", () => {
    const r = reklamOrani({ gunlukTutar: 800, gunSayisi: 30, pencereCirosu: 0 });
    expect(r.oran).toBe(0);
    expect(Number.isFinite(r.oran)).toBe(true);
    expect(r.guvenilir).toBe(false); // çağıran "hesaplanamadı" diyebilsin
  });

  it("bütçe yoksa oran 0 ve bu GÜVENİLİR bir sonuçtur (reklam vermiyoruz)", () => {
    const r = reklamOrani({ gunlukTutar: 0, gunSayisi: 30, pencereCirosu: 100_000 });
    expect(r.oran).toBe(0);
    expect(r.guvenilir).toBe(true);
  });

  it("harcama ciroyu aşarsa işaretlenir (arayüz uyarmalı)", () => {
    const r = reklamOrani({ gunlukTutar: 800, gunSayisi: 30, pencereCirosu: 10_000 });
    expect(r.cirodanBuyuk).toBe(true);
    expect(r.oran).toBeGreaterThan(1);
  });

  it("bozuk sayılar hesabı patlatmaz", () => {
    const r = reklamOrani({ gunlukTutar: NaN, gunSayisi: Infinity, pencereCirosu: -5 });
    expect(r.oran).toBe(0);
    expect(Number.isFinite(r.oran)).toBe(true);
  });

  it("pencere sabiti makul (çok kısa = oynak, çok uzun = geç tepki)", () => {
    expect(REKLAM_PENCERE_GUN).toBeGreaterThanOrEqual(14);
    expect(REKLAM_PENCERE_GUN).toBeLessThanOrEqual(90);
  });
});

describe("reklam payı", () => {
  it("satır cirosunun oranı kadar", () => {
    expect(reklamPayi(1000, 0.1871)).toBeCloseTo(187.1, 2);
  });

  it("PAHALI ürün çok, UCUZ ürün az taşır — sabit tutarın çarpıtması yok", () => {
    const oran = 0.1871;
    expect(reklamPayi(200, oran) / 200).toBeCloseTo(oran, 6);
    expect(reklamPayi(2000, oran) / 2000).toBeCloseTo(oran, 6);
  });

  it("sıfır/negatif ciroda 0", () => {
    expect(reklamPayi(0, 0.2)).toBe(0);
    expect(reklamPayi(-100, 0.2)).toBe(0);
    expect(reklamPayi(1000, 0)).toBe(0);
  });
});

describe("dönem seçimi", () => {
  const AGU = new Date("2026-08-01T00:00:00+03:00");
  const EYL = new Date("2026-09-01T00:00:00+03:00");
  const butceler = [
    { platform: "trendyol", dailyAmount: 500, validFrom: AGU, validTo: new Date(EYL.getTime() - 1) },
    { platform: "trendyol", dailyAmount: 700, validFrom: EYL, validTo: null },
    { platform: "shopify", dailyAmount: 300, validFrom: AGU, validTo: null },
  ];

  it("siparişin KENDİ tarihindeki bütçeyi seçer", () => {
    const agustos = new Date("2026-08-15T12:00:00+03:00").getTime();
    const eylul = new Date("2026-09-15T12:00:00+03:00").getTime();
    expect(gecerliButce(butceler, "trendyol", agustos)?.dailyAmount).toBe(500);
    expect(gecerliButce(butceler, "trendyol", eylul)?.dailyAmount).toBe(700);
  });

  it("BAŞLANGIÇTAN ÖNCE bütçe yok — geçmiş siparişler reklam payı taşımaz", () => {
    const temmuz = new Date("2026-07-15T12:00:00+03:00").getTime();
    expect(gecerliButce(butceler, "trendyol", temmuz)).toBeNull();
  });

  it("platformlar birbirine karışmaz", () => {
    const agustos = new Date("2026-08-15T12:00:00+03:00").getTime();
    expect(gecerliButce(butceler, "shopify", agustos)?.dailyAmount).toBe(300);
    // Bütçesi olmayan platform hiç pay taşımaz.
    expect(gecerliButce(butceler, "hepsiburada", agustos)).toBeNull();
  });

  it("kapalı bütçe seçilmez", () => {
    const kapali = [{ platform: "trendyol", dailyAmount: 500, validFrom: AGU, validTo: null, isActive: false }];
    expect(gecerliButce(kapali, "trendyol", Date.now())).toBeNull();
  });

  it("sınırda boşluk yok: bir dönem biterken diğeri başlar", () => {
    const sinir = EYL.getTime();
    expect(gecerliButce(butceler, "trendyol", sinir - 1)?.dailyAmount).toBe(500);
    expect(gecerliButce(butceler, "trendyol", sinir)?.dailyAmount).toBe(700);
  });
});

/**
 * ORAN SEÇİMİ — masaüstü ve mobil AYNI fonksiyonu çağırır.
 * Ayrı yazılsalardı aynı sipariş iki cihazda farklı kâr gösterirdi (gerçek komisyonda yaşandı).
 */
describe("sipariş için oran seçimi", () => {
  const AGU = new Date("2026-08-01T00:00:00+03:00");
  const EYL = new Date("2026-09-01T00:00:00+03:00");
  const SIMDI = new Date("2026-09-15T12:00:00+03:00").getTime();

  const butceler = [
    { platform: "trendyol", dailyAmount: 800, validFrom: AGU, validTo: new Date(EYL.getTime() - 1) },
    { platform: "trendyol", dailyAmount: 1600, validFrom: EYL, validTo: null },
  ];
  // Bugünkü (Eylül, 1600 ₺) bütçeye göre hesaplanmış oran: %20
  const oranlar = new Map([
    ["trendyol", { oran: 0.2, toplamHarcama: 48_000, guvenilir: true, cirodanBuyuk: false }],
  ]);

  it("BUGÜNKÜ sipariş bugünkü oranı alır", () => {
    expect(reklamOraniIcin(butceler, oranlar, "trendyol", SIMDI, SIMDI)).toBeCloseTo(0.2, 6);
  });

  it("AĞUSTOS siparişi, o dönemin bütçesi oranında ÖLÇEKLENİR (800/1600 = yarısı)", () => {
    const agustos = new Date("2026-08-15T12:00:00+03:00").getTime();
    expect(reklamOraniIcin(butceler, oranlar, "trendyol", agustos, SIMDI)).toBeCloseTo(0.1, 6);
  });

  it("BÜTÇE ÖNCESİ sipariş reklam payı taşımaz", () => {
    const temmuz = new Date("2026-07-15T12:00:00+03:00").getTime();
    expect(reklamOraniIcin(butceler, oranlar, "trendyol", temmuz, SIMDI)).toBe(0);
  });

  it("bütçesi olmayan platform 0 — Trendyol reklamı Shopify'a yüklenmez", () => {
    expect(reklamOraniIcin(butceler, oranlar, "shopify", SIMDI, SIMDI)).toBe(0);
  });

  it("oran güvenilmezse (ciro yok) 0 — uydurma pay bindirilmez", () => {
    const guvensiz = new Map([
      ["trendyol", { oran: 0, toplamHarcama: 48_000, guvenilir: false, cirodanBuyuk: false }],
    ]);
    expect(reklamOraniIcin(butceler, guvensiz, "trendyol", SIMDI, SIMDI)).toBe(0);
  });
});
