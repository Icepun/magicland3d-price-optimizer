/**
 * Üretim hedefi kuralı.
 *
 * Korunan asıl davranış: TALEP modunda satmayan ürün plana GİRMEZ. Sabit hedefle ölçülen tablo
 * (13 Ağu 2026, canlı veri) şuydu — 129 ürün / 492 baskı / 69 kg filament, oysa elde 34 kg
 * filament ve 4 yazıcı vardı; plandaki 129 üründen 67'si ölçülebilen dönemde hiç satmamıştı.
 */
import { describe, expect, it } from "vitest";
import {
  KAPSAM_SECENEKLERI,
  VARSAYILAN_KAPSAM_GUN,
  basilacakAdet,
  gunlukSatis,
  hedefStok,
  parseHedefModu,
  parseKapsamGun,
  parseTavan,
  type HedefAyari,
} from "./planner-target";

const sabit = (tavan = 5): HedefAyari => ({ mod: "sabit", tavan, kapsamGun: 30 });
const talep = (tavan = 5, kapsamGun = 30): HedefAyari => ({ mod: "talep", tavan, kapsamGun });

describe("sabit mod", () => {
  it("satış ne olursa olsun hedef aynıdır", () => {
    expect(hedefStok(sabit(5), 0)).toBe(5);
    expect(hedefStok(sabit(5), 10)).toBe(5);
    expect(hedefStok(sabit(3), null)).toBe(3);
  });
});

describe("talep modu", () => {
  it("SATMAYAN ürün 0 hedef alır — plana hiç girmez", () => {
    // Ölçülen dönemde hiç satmamış ürünü basmak, satanı stoksuz bırakmak demek.
    expect(hedefStok(talep(), 0)).toBe(0);
    expect(hedefStok(talep(), null)).toBe(0);
    expect(hedefStok(talep(), undefined)).toBe(0);
  });

  it("kapsam günü kadar satışı karşılar", () => {
    // Günde 0,1 adet × 30 gün = 3
    expect(hedefStok(talep(5, 30), 0.1)).toBe(3);
    // Günde 0,05 × 60 gün = 3
    expect(hedefStok(talep(5, 60), 0.05)).toBe(3);
  });

  it("küsuratı YUKARI yuvarlar — eksik basmaktansa bir fazla", () => {
    expect(hedefStok(talep(9, 30), 0.11)).toBe(4); // 3,3 → 4
  });

  it("satan ürün en az 1 alır", () => {
    // Ayda bir satan ürün de stoksuz kalmasın.
    expect(hedefStok(talep(5, 30), 0.001)).toBe(1);
  });

  it("tavanı AŞMAZ", () => {
    // Çok satan ürün depoyu tek başına doldurmasın.
    expect(hedefStok(talep(5, 30), 2)).toBe(5);
    expect(hedefStok(talep(2, 30), 2)).toBe(2);
  });

  it("negatif ya da bozuk hız 0 sayılır", () => {
    expect(hedefStok(talep(), -3)).toBe(0);
    expect(hedefStok(talep(), Number.NaN)).toBe(0);
    expect(hedefStok(talep(), Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("gunlukSatis", () => {
  it("ÖLÇÜLEN güne böler", () => {
    expect(gunlukSatis(21, 21)).toBe(1);
    expect(gunlukSatis(10, 20)).toBe(0.5);
  });

  it("satış yoksa ya da gün yoksa 0", () => {
    expect(gunlukSatis(0, 30)).toBe(0);
    expect(gunlukSatis(5, 0)).toBe(0);
    expect(gunlukSatis(5, -1)).toBe(0);
  });

  it("21 günlük veriyi 90'a bölmek hedefi tabana yapıştırırdı", () => {
    // Gerçek: 21 günde 6 adet satan ürün. Doğru bölenle 30 günlük hedef 9;
    // yanlışlıkla 90'a bölünürse 2'ye düşerdi.
    const dogru = hedefStok(talep(20, 30), gunlukSatis(6, 21));
    const yanlis = hedefStok(talep(20, 30), gunlukSatis(6, 90));
    expect(dogru).toBe(9);
    expect(yanlis).toBe(2);
    expect(dogru).toBeGreaterThan(yanlis);
  });
});

describe("basilacakAdet", () => {
  it("hedef ile stok farkı", () => {
    expect(basilacakAdet(5, 2)).toBe(3);
    expect(basilacakAdet(5, 5)).toBe(0);
    expect(basilacakAdet(5, 9)).toBe(0);
  });

  it("hedef 0 ise iş yok", () => {
    expect(basilacakAdet(0, 0)).toBe(0);
  });
});

describe("ayar ayrıştırma — bozuk değer planı boş bırakmaz", () => {
  it("mod", () => {
    expect(parseHedefModu("talep")).toBe("talep");
    expect(parseHedefModu("sabit")).toBe("sabit");
    expect(parseHedefModu("")).toBe("sabit");
    expect(parseHedefModu(null)).toBe("sabit");
    expect(parseHedefModu("bozuk")).toBe("sabit");
  });

  it("kapsam günü", () => {
    expect(parseKapsamGun("30")).toBe(30);
    expect(parseKapsamGun("")).toBe(VARSAYILAN_KAPSAM_GUN);
    expect(parseKapsamGun("abc")).toBe(VARSAYILAN_KAPSAM_GUN);
    expect(parseKapsamGun("0")).toBe(VARSAYILAN_KAPSAM_GUN);
    expect(parseKapsamGun("9999")).toBe(365);
  });

  it("tavan", () => {
    expect(parseTavan("5")).toBe(5);
    expect(parseTavan("")).toBe(5);
    expect(parseTavan("0")).toBe(5);
    expect(parseTavan("2,5")).toBe(5); // Türkçe ondalık sayı değil → varsayılan
  });

  it("arayüzdeki kapsam seçenekleri geçerli", () => {
    for (const gun of KAPSAM_SECENEKLERI) expect(parseKapsamGun(String(gun))).toBe(gun);
  });
});

describe("gerçek tablo — sabit hedef planı neden şişiriyordu", () => {
  it("satmayan ürünler talep modunda tamamen elenir", () => {
    // 21 günlük geçmiş; üç ürün: hiç satmayan, ayda ~1 satan, haftada ~3 satan.
    const urunler = [
      { ad: "satmayan", satilan: 0, stok: 0 },
      { ad: "yavaş", satilan: 1, stok: 0 },
      { ad: "hızlı", satilan: 9, stok: 0 },
    ];
    const olculenGun = 21;

    const sabitPlan = urunler.map((u) => basilacakAdet(hedefStok(sabit(5), 0), u.stok));
    expect(sabitPlan).toEqual([5, 5, 5]); // hepsi 5 → satmayan da basılıyor

    const talepPlan = urunler.map((u) =>
      basilacakAdet(hedefStok(talep(5, 30), gunlukSatis(u.satilan, olculenGun)), u.stok)
    );
    expect(talepPlan[0]).toBe(0); // satmayan elendi
    expect(talepPlan[1]).toBe(2); // 1/21×30 = 1,43 → 2
    expect(talepPlan[2]).toBe(5); // 9/21×30 = 12,9 → tavan 5
    expect(talepPlan.reduce((a, b) => a + b, 0)).toBeLessThan(
      sabitPlan.reduce((a, b) => a + b, 0)
    );
  });
});
