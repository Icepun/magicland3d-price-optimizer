import { describe, expect, it } from "vitest";
import { stockCommitValue } from "./StockInput";

/**
 * Stok kutusu. Esc "vazgeç" demektir: yazılan rakam KAYDEDİLMEZ, alan eski değerine döner.
 * Eskiden Esc odaktan çıkarttığı için blur yazmayı tetikliyor ve iptal edilen rakam stoğa
 * yazılıyordu (900 → yanlışlıkla 9 yazıp Esc'e basmak stoğu bozuyordu).
 *
 * null = "yazma yok, eski değere dön".
 */
describe("stok kutusu", () => {
  it("Esc yazılanı KAYDETMEZ", () => {
    expect(stockCommitValue("9", 900, true)).toBeNull();
  });

  it("Enter/blur yazılanı kaydeder", () => {
    expect(stockCommitValue("9", 900, false)).toBe(9);
  });

  it("boş bırakılırsa eski değer korunur (kaza ile 0 olmaz)", () => {
    expect(stockCommitValue("", 900, false)).toBeNull();
    expect(stockCommitValue("   ", 900, false)).toBeNull();
  });

  it("değer değişmemişse gereksiz yazma yapılmaz", () => {
    expect(stockCommitValue("900", 900, false)).toBeNull();
  });

  it("0 girilebilir (stok bitti)", () => {
    expect(stockCommitValue("0", 900, false)).toBe(0);
  });

  it("eksi ve ondalık giriş güvenli sayıya indirilir", () => {
    expect(stockCommitValue("-5", 900, false)).toBe(0);
    expect(stockCommitValue("3.7", 900, false)).toBe(3);
  });

  it("geçersiz metin yazılmaz", () => {
    expect(stockCommitValue("abc", 900, false)).toBeNull();
  });
});
