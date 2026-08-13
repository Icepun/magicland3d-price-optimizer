/**
 * Tekrarlayan sabit gider üretimi.
 *
 * ⚠️ BU KOD NET KÂRI DEĞİŞTİRİYOR — açılan her satır o ayın kârından düşüyor. Bu yüzden iki
 * davranış burada kilitli:
 *   • aynı dönem İKİ KEZ açılmaz (üretim her açılışta koşuyor; koruma olmadan gider her
 *     açılışta bir kat artardı),
 *   • günü GELMEMİŞ dönem açılmaz (ayın 25'inde ödenen gideri ayın 3'ünde yazmak o ayın
 *     kârını olduğundan düşük gösterir).
 */
import { describe, expect, it } from "vitest";
import {
  ayinGunu,
  donemAnahtari,
  odemeAni,
  uretilecekler,
  type TekrarKurali,
} from "./recurring-expense";

/** Türkiye duvar saatiyle verilen anı UTC ms'e çevirir. */
const TR = (iso: string) => Date.parse(`${iso}+03:00`);

const kural = (over: Partial<TekrarKurali> = {}): TekrarKurali => ({
  id: "k1",
  name: "Muhasebe",
  category: "Muhasebe",
  amountKurus: 200_000,
  dayOfMonth: 9,
  startsAtMs: TR("2026-07-01T00:00:00"),
  endsAtMs: null,
  isActive: true,
  note: null,
  ...over,
});

const SIMDI = TR("2026-08-14T12:00:00");

describe("dönem anahtarı", () => {
  it("Türkiye takvimine göre ay verir", () => {
    expect(donemAnahtari(TR("2026-08-14T12:00:00"))).toBe("2026-08");
    // Ayın son günü gece yarısından sonra: UTC'de bir önceki ay görünür, TR'de doğru ay.
    expect(donemAnahtari(TR("2026-09-01T01:00:00"))).toBe("2026-09");
  });
});

describe("ayın günü", () => {
  it("ay o günü taşımıyorsa son güne düşer", () => {
    expect(ayinGunu(2026, 2, 31)).toBe(28);
    expect(ayinGunu(2024, 2, 31)).toBe(29); // artık yıl
    expect(ayinGunu(2026, 4, 31)).toBe(30);
    expect(ayinGunu(2026, 8, 9)).toBe(9);
  });

  it("bozuk gün değeri aralığa çekilir", () => {
    expect(ayinGunu(2026, 8, 0)).toBe(1);
    expect(ayinGunu(2026, 8, -5)).toBe(1);
  });
});

describe("ödeme anı", () => {
  it("Türkiye gün başına oturur", () => {
    expect(odemeAni("2026-08", 9)).toBe(TR("2026-08-09T00:00:00"));
  });

  it("kısa ayda son güne kayar", () => {
    expect(odemeAni("2026-02", 31)).toBe(TR("2026-02-28T00:00:00"));
  });
});

describe("üretilecek dönemler", () => {
  it("başlangıçtan bugüne kadarki her ay için bir kayıt", () => {
    const sonuc = uretilecekler(kural(), [], SIMDI);
    expect(sonuc.map((x) => x.periodKey)).toEqual(["2026-07", "2026-08"]);
    expect(sonuc[0].amountKurus).toBe(200_000);
    expect(sonuc[0].name).toBe("Muhasebe");
  });

  it("ZATEN açılmış dönem tekrar açılmaz", () => {
    // Asıl koruma: üretim her açılışta koşuyor.
    const sonuc = uretilecekler(kural(), ["2026-07"], SIMDI);
    expect(sonuc.map((x) => x.periodKey)).toEqual(["2026-08"]);
  });

  it("hepsi açılmışsa hiçbir şey üretilmez", () => {
    expect(uretilecekler(kural(), ["2026-07", "2026-08"], SIMDI)).toEqual([]);
  });

  it("GÜNÜ GELMEMİŞ ay açılmaz", () => {
    // Ayın 25'inde ödenen gider, ayın 14'ünde yazılmaz.
    const sonuc = uretilecekler(kural({ dayOfMonth: 25 }), [], SIMDI);
    expect(sonuc.map((x) => x.periodKey)).toEqual(["2026-07"]);
  });

  it("bugün ödeme günüyse O AY da açılır", () => {
    const sonuc = uretilecekler(kural({ dayOfMonth: 14 }), [], SIMDI);
    expect(sonuc.map((x) => x.periodKey)).toEqual(["2026-07", "2026-08"]);
  });

  it("pasif kural hiç üretmez", () => {
    expect(uretilecekler(kural({ isActive: false }), [], SIMDI)).toEqual([]);
  });

  it("bitiş ayından sonrası üretilmez", () => {
    const sonuc = uretilecekler(
      kural({ endsAtMs: TR("2026-07-31T23:59:59") }),
      [],
      SIMDI
    );
    expect(sonuc.map((x) => x.periodKey)).toEqual(["2026-07"]);
  });

  it("başlangıçtan ÖNCEKİ ödeme günü atlanır", () => {
    // Kural ayın 20'sinde kuruldu ama ödeme günü 9 → o ayın ödemesi zaten geçmiş,
    // büyük ihtimalle elle girilmiş; otomatik ikinci kez yazılmaz.
    const sonuc = uretilecekler(
      kural({ startsAtMs: TR("2026-07-20T00:00:00") }),
      [],
      SIMDI
    );
    expect(sonuc.map((x) => x.periodKey)).toEqual(["2026-08"]);
  });

  it("tutarı sıfır ya da negatif olan kural üretmez", () => {
    expect(uretilecekler(kural({ amountKurus: 0 }), [], SIMDI)).toEqual([]);
    expect(uretilecekler(kural({ amountKurus: -100 }), [], SIMDI)).toEqual([]);
  });

  it("bozuk başlangıç tarihi çökertmez", () => {
    expect(uretilecekler(kural({ startsAtMs: Number.NaN }), [], SIMDI)).toEqual([]);
  });

  it("çok eski başlangıç sonsuz döngü yapmaz", () => {
    const sonuc = uretilecekler(kural({ startsAtMs: TR("1990-01-01T00:00:00") }), [], SIMDI);
    expect(sonuc.length).toBeGreaterThan(0);
    expect(sonuc.length).toBeLessThanOrEqual(600);
  });

  it("ödeme anı doğru aya düşer", () => {
    const sonuc = uretilecekler(kural(), [], SIMDI);
    expect(donemAnahtari(sonuc[0].paidAtMs)).toBe("2026-07");
    expect(donemAnahtari(sonuc[1].paidAtMs)).toBe("2026-08");
  });

  it("Şubat'ta 31'i seçilmişse ay sonuna oturur ve dönem kaymaz", () => {
    const sonuc = uretilecekler(
      kural({ dayOfMonth: 31, startsAtMs: TR("2026-02-01T00:00:00") }),
      [],
      TR("2026-03-05T12:00:00")
    );
    expect(sonuc.map((x) => x.periodKey)).toEqual(["2026-02"]);
    expect(donemAnahtari(sonuc[0].paidAtMs)).toBe("2026-02");
  });
});
