import { describe, expect, it } from "vitest";
import {
  formatCompactCurrency,
  formatCurrency,
  formatDate,
  formatNumber,
  formatPercent,
  formatPercentValue,
  formatRelativeTime,
} from "./format";

/** tr-TR biçiminde binlik ayracı NOKTA, ondalık ayracı VİRGÜL, para simgesi sayının ÖNÜNDE.
 *  Intl bazı ortamlarda dar boşluk (U+00A0 / U+202F) koyduğu için karşılaştırmadan önce sadeleştiriyoruz. */
const norm = (s: string) => s.replace(/[  ]/g, " ");

describe("formatCurrency", () => {
  it("varsayılan olarak iki ondalıkla, tr-TR ayraçlarıyla yazar", () => {
    expect(norm(formatCurrency(1234.5))).toBe("₺1.234,50");
  });

  it("özet kartları için ondalıksız yazabilir", () => {
    expect(norm(formatCurrency(1234.56, { decimals: 0 }))).toBe("₺1.235");
  });

  /**
   * BİLİNMEYEN ≠ SIFIR. Hesaplanamamış bir tutarı "₺0,00" yazmak, kullanıcıya gerçek bir sıfır
   * gibi görünür ve "maliyeti girilmemiş ürün" uyarısını biçimlendirme katmanında geri alır.
   * Ekranda NaN de çıkmaz — ikisinin ortası "—".
   */
  it("NaN/null/undefined için — gösterir, gerçek sıfırı normal yazar", () => {
    expect(formatCurrency(NaN)).toBe("—");
    expect(formatCurrency(null)).toBe("—");
    expect(formatCurrency(undefined)).toBe("—");
    expect(norm(formatCurrency(0))).toBe("₺0,00");
  });

  it("tanınmayan para birimi kodunda tutarı kaybetmez, TRY'ye düşer", () => {
    expect(norm(formatCurrency(10, { currency: "XYZQ" }))).toBe("₺10,00");
  });
});

describe("formatPercent", () => {
  /** ASIL DÜZELTME: eskiden toFixed(1) kullanıldığı için Türkçe arayüzde "%12.5" yazıyordu. */
  it("ondalık ayracı olarak VİRGÜL kullanır", () => {
    expect(formatPercent(0.125)).toBe("%12,5");
  });

  it("yüzde işaretini sayının önüne koyar", () => {
    expect(formatPercent(0.2, 0)).toBe("%20");
  });

  it("hazır yüzde değerini olduğu gibi yazar", () => {
    expect(formatPercentValue(18)).toBe("%18");
  });

  it("bilinmeyen oranı %0 diye yazmaz", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
    expect(formatPercent(NaN)).toBe("—");
    expect(formatPercent(0)).toBe("%0,0");
  });
});

describe("formatCompactCurrency", () => {
  it("milyonu ve bini kısaltır", () => {
    expect(formatCompactCurrency(1_250_000)).toBe("₺1,3m");
    expect(formatCompactCurrency(45_400)).toBe("₺45b");
  });

  it("küçük tutarı olduğu gibi yazar", () => {
    expect(formatCompactCurrency(320)).toBe("₺320");
  });

  it("negatif tutarda işareti korur", () => {
    expect(formatCompactCurrency(-45_400)).toBe("-₺45b");
  });
});

describe("formatNumber", () => {
  it("binlik ayracı koyar", () => {
    expect(formatNumber(1234567)).toBe("1.234.567");
  });
});

describe("tarih", () => {
  it("geçersiz tarihte yedek metni döner", () => {
    expect(formatDate("olmayan-tarih")).toBe("—");
    expect(formatDate(null)).toBe("—");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-08-10T12:00:00.000Z").getTime();

  it("çok yakın zamanı 'az önce' der", () => {
    expect(formatRelativeTime(new Date(now - 10_000), now)).toBe("az önce");
  });

  it("dakika ve saati Türkçe yazar", () => {
    expect(formatRelativeTime(new Date(now - 3 * 60_000), now)).toBe("3 dakika önce");
    expect(formatRelativeTime(new Date(now - 5 * 3_600_000), now)).toBe("5 saat önce");
  });

  it("bir gün öncesine 'dün' der", () => {
    expect(formatRelativeTime(new Date(now - 24 * 3_600_000), now)).toBe("dün");
  });
});
