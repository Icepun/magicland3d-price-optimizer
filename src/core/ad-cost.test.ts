/**
 * REKLAM PAYI — dağıtım matematiği ve dönem seçimi.
 *
 * Bu hesap doğrudan KÂR RAKAMINI değiştiriyor, o yüzden davranışı burada kilitleniyor:
 * oranın nasıl kurulduğu, sıfır/bozuk girdide patlamadığı, ve siparişin KENDİ tarihindeki
 * bütçeyi kullandığı (yoksa bütçe değişince geçmiş kârlar da kayardı).
 */
import { describe, expect, it } from "vitest";
import { reklamOrani, reklamPayi, gecerliButce, reklamOraniIcin, donemGunSayisi, TUM_PLATFORMLAR, REKLAM_PENCERE_GUN } from "./ad-cost";

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

  // Her dönemin oranı KENDİ cirosundan hesaplanıp kayda yazılır (servis doldurur).
  const butceler = [
    { platform: "trendyol", dailyAmount: 800, validFrom: AGU, validTo: new Date(EYL.getTime() - 1), oran: 0.1 },
    { platform: "trendyol", dailyAmount: 1600, validFrom: EYL, validTo: null, oran: 0.2 },
  ];

  it("BUGÜNKÜ sipariş bugünkü dönemin oranını alır", () => {
    expect(reklamOraniIcin(butceler, "trendyol", SIMDI)).toBeCloseTo(0.2, 6);
  });

  it("AĞUSTOS siparişi AĞUSTOS döneminin oranını alır", () => {
    const agustos = new Date("2026-08-10T12:00:00+03:00").getTime();
    expect(reklamOraniIcin(butceler, "trendyol", agustos)).toBeCloseTo(0.1, 6);
  });

  it("KAPANMIŞ dönemin oranı SABİT — bugünkü ciro değişse de oynamaz", () => {
    /**
     * Bu, özelliğin İLK sürümündeki gerçek hataydı: oran son 30 günün cirosundan
     * türetiliyordu ve pencere her gün kaydığı için geçmiş siparişlerin payı da kayıyordu
     * (ölçüldü: aynı Ağustos siparişi 120 ₺ ya da 300 ₺ — 2,5 kat). Oran artık kaydın
     * kendisinde; bugünkü pencereye hiç bakılmıyor.
     */
    const agustos = new Date("2026-08-10T12:00:00+03:00").getTime();
    expect(reklamOraniIcin(butceler, "trendyol", agustos)).toBe(butceler[0].oran);
  });

  it("BÜTÇE ÖNCESİ sipariş reklam payı taşımaz", () => {
    const temmuz = new Date("2026-07-15T12:00:00+03:00").getTime();
    expect(reklamOraniIcin(butceler, "trendyol", temmuz)).toBe(0);
  });

  it("bütçesi olmayan platform 0 — Trendyol reklamı Shopify'a yüklenmez", () => {
    expect(reklamOraniIcin(butceler, "shopify", SIMDI)).toBe(0);
  });

  it("oran hesaplanamamışsa (ciro yok → 0) pay bindirilmez", () => {
    const ciroSuz = [{ platform: "trendyol", dailyAmount: 800, validFrom: AGU, validTo: null, oran: 0 }];
    expect(reklamOraniIcin(ciroSuz, "trendyol", SIMDI)).toBe(0);
  });
});

describe("dönem gün sayısı", () => {
  it("kapanmış dönem: başlangıç–bitiş arası", () => {
    const bas = new Date("2026-08-01T00:00:00+03:00");
    const bit = new Date("2026-08-31T00:00:00+03:00");
    // "Şimdi" dönemin BİTİŞİNDEN sonra: dönem tamamlanmış, tam 30 gün sayılır.
    const simdi = new Date("2026-10-01T00:00:00+03:00").getTime();
    expect(donemGunSayisi(bas, bit, simdi)).toBeCloseTo(30, 1);
  });

  it("HENÜZ BİTMEMİŞ dönem ileriye saymaz — bugüne kadar sayar", () => {
    // Bitişi gelecekte olan dönemde gelecek günleri saymak, oranı yapay olarak şişirirdi.
    const bas = new Date("2026-08-01T00:00:00+03:00");
    const bit = new Date("2026-08-31T00:00:00+03:00");
    const simdi = new Date("2026-08-11T00:00:00+03:00").getTime();
    expect(donemGunSayisi(bas, bit, simdi)).toBeCloseTo(10, 1);
  });

  it("açık dönem: başlangıçtan BUGÜNE (ileriye saymaz)", () => {
    const bas = new Date("2026-08-01T00:00:00+03:00");
    const simdi = new Date("2026-08-11T00:00:00+03:00").getTime();
    expect(donemGunSayisi(bas, null, simdi)).toBeCloseTo(10, 1);
  });

  it("tarihsiz dönem 0 — gün sayısı bilinmez, oran kurulamaz", () => {
    expect(donemGunSayisi(null, null, Date.now())).toBe(0);
  });
});

/**
 * TOPLAM (marka) BÜTÇESİ + PLATFORM BÜTÇESİ birlikte.
 *
 * Kullanıcı kararı: "mağazamızı reklamdan gören biri girip Trendyol'dan da alabilir" → marka
 * reklamı TÜM cironun üstüne yayılır. Bir kanala AYRICA reklam verilirse o da gerçekten
 * harcanmış ayrı bir paradır; biri diğerini ezerse harcanan paranın bir kısmı hiçbir ürüne
 * yansımaz ve kâr olduğundan yüksek görünür.
 */
describe("toplam + platform bütçesi", () => {
  const AGU = new Date("2026-08-01T00:00:00+03:00");
  const SIMDI = new Date("2026-08-20T12:00:00+03:00").getTime();

  it("yalnız TOPLAM bütçe varsa her platform aynı oranı taşır", () => {
    const b = [{ platform: TUM_PLATFORMLAR, dailyAmount: 800, validFrom: AGU, validTo: null, oran: 0.18 }];
    expect(reklamOraniIcin(b, "trendyol", SIMDI)).toBeCloseTo(0.18, 6);
    expect(reklamOraniIcin(b, "shopify", SIMDI)).toBeCloseTo(0.18, 6);
    expect(reklamOraniIcin(b, "hepsiburada", SIMDI)).toBeCloseTo(0.18, 6);
  });

  it("TOPLAM + platform bütçesi TOPLANIR (biri diğerini ezmez)", () => {
    const b = [
      { platform: TUM_PLATFORMLAR, dailyAmount: 800, validFrom: AGU, validTo: null, oran: 0.18 },
      { platform: "trendyol", dailyAmount: 300, validFrom: AGU, validTo: null, oran: 0.05 },
    ];
    // Trendyol hem markanın hem kendi reklamının payını taşır.
    expect(reklamOraniIcin(b, "trendyol", SIMDI)).toBeCloseTo(0.23, 6);
    // Shopify yalnız marka payını taşır — Trendyol'un reklamı ona yüklenmez.
    expect(reklamOraniIcin(b, "shopify", SIMDI)).toBeCloseTo(0.18, 6);
  });

  it("TOPLAM bütçe DÖNEMLİDİR — başlangıcından önce pay yok", () => {
    const b = [{ platform: TUM_PLATFORMLAR, dailyAmount: 800, validFrom: AGU, validTo: null, oran: 0.18 }];
    const temmuz = new Date("2026-07-20T12:00:00+03:00").getTime();
    expect(reklamOraniIcin(b, "trendyol", temmuz)).toBe(0);
  });

  it("bilinmeyen bir platform da TOPLAM payını taşır (manuel sipariş dahil)", () => {
    const b = [{ platform: TUM_PLATFORMLAR, dailyAmount: 800, validFrom: AGU, validTo: null, oran: 0.18 }];
    expect(reklamOraniIcin(b, "manual", SIMDI)).toBeCloseTo(0.18, 6);
  });

  it("bütçe yoksa oran 0 — hiçbir sipariş pay taşımaz", () => {
    expect(reklamOraniIcin([], "trendyol", SIMDI)).toBe(0);
  });
});
