import { describe, expect, it } from "vitest";

import {
  formatCompactCurrency,
  formatCurrency,
  formatDate,
  formatNumber,
  formatPercent,
  formatPercentValue,
  formatRelativeTime,
  friendlyError,
} from "../../mobile/src/lib/format";

/**
 * Mobil biçimlendirme aynasının testi — DOSYA NEDEN `mobile/` ALTINDA DEĞİL:
 *
 * `mobile/` kendi `npm ci`'siyle kurulur ve `vitest` onun bağımlılıklarında YOKTUR; testleri
 * kökteki koşucu çalıştırır. Dosya `mobile/` altındayken yerelde sorunsuz görünüyordu çünkü
 * TypeScript `vitest`'i üst dizindeki KÖK `node_modules`'tan çözüyordu. CI ise yalnız `mobile/`
 * içinde kurulum yapıyor → orada kök `node_modules` hiç yok → `npx tsc --noEmit` "Cannot find
 * module 'vitest'" ile düşüyor ve iOS TestFlight işi kırılıyor.
 *
 * Proje kuralı zaten bu yönde: `sync-core` çekirdek kopyasındaki `*.test.ts` dosyalarını siler,
 * kök `tsconfig` `mobile`'ı dışlar. `mobile/` altına test dosyası KOYMA.
 */
describe("mobil biçimlendirme (tr-TR)", () => {
  it("parayı ₺ önde, virgüllü ondalıkla yazar", () => {
    const out = formatCurrency(1234.5);
    expect(out).toContain("₺");
    expect(out).toContain("1.234,50");
  });

  it("ondalıksız istendiğinde kuruş göstermez", () => {
    expect(formatCurrency(1234.56, { decimals: 0 })).toContain("1.235");
    expect(formatCurrency(1234.56, { decimals: 0 })).not.toContain(",");
  });

  /** BİLİNMEYEN ≠ SIFIR — masaüstü src/lib/format.ts ile aynı kural. */
  it("geçersiz tutarı — yazar, gerçek sıfırı normal yazar", () => {
    expect(formatCurrency(Number.NaN)).toBe("—");
    expect(formatCurrency(null)).toBe("—");
    expect(formatCurrency(undefined)).toBe("—");
    expect(formatCurrency(0)).toContain("0,00");
  });

  it("tanınmayan para birimi kodunda tutarı kaybetmez", () => {
    expect(formatCurrency(10, { currency: "XXXX" })).toContain("10,00");
  });

  it("yüzdeyi işaret önde ve VİRGÜLLE yazar", () => {
    expect(formatPercent(0.125)).toBe("%12,5");
    expect(formatPercent(-0.0725, 2)).toBe("%-7,25");
    expect(formatPercentValue(18)).toBe("%18");
  });

  it("sayıyı binlik ayracıyla yazar", () => {
    expect(formatNumber(1234567)).toBe("1.234.567");
    expect(formatNumber(2.5, 1)).toBe("2,5");
  });

  it("dar alanlar için tutarı kısaltır", () => {
    expect(formatCompactCurrency(1_250_000)).toBe("₺1,3m");
    expect(formatCompactCurrency(45_400)).toBe("₺45b");
    expect(formatCompactCurrency(-320)).toBe("-₺320");
  });

  it("geçersiz tarihte tire gösterir", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("elma")).toBe("—");
    expect(formatDate(new Date("2026-03-09T12:00:00Z"))).toContain("2026");
  });

  it("bağıl zamanı Türkçe yazar", () => {
    const now = Date.UTC(2026, 2, 9, 12, 0, 0);
    expect(formatRelativeTime(now - 10_000, now)).toBe("az önce");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5 dakika önce");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3 saat önce");
    expect(formatRelativeTime(now - 24 * 3_600_000, now)).toBe("dün");
  });
});

describe("hata metni sadeleştirme", () => {
  it("teknik ayrıntıyı kullanıcıya sızdırmaz", () => {
    const out = friendlyError(new Error("Turso HTTP 500: no such column: foo"));
    expect(out).toBe("Bağlantı kurulamadı. İnternetini kontrol et.");
    expect(out).not.toContain("Turso");
    expect(out).not.toContain("500");
  });

  it("zaman aşımını ayrı anlatır", () => {
    expect(friendlyError(new Error("Turso zaman aşımı (12sn) — bağlantıyı kontrol et"))).toBe(
      "Sunucu yanıt vermedi. Birazdan tekrar dene."
    );
  });

  it("yetki hatasında kullanıcıya ne yapacağını söyler", () => {
    expect(friendlyError(new Error("Turso HTTP 401: unauthorized"))).toBe(
      "Giriş bilgileri geçersiz. Masaüstünden ayarları kontrol et."
    );
  });

  it("boş/bilinmeyen hatada genel cümleye düşer", () => {
    expect(friendlyError(undefined)).toBe("Bağlantı kurulamadı. İnternetini kontrol et.");
    expect(friendlyError({}, "Ürün yüklenemedi.")).toBe("Ürün yüklenemedi.");
  });
});
