import { describe, expect, it } from "vitest";
import { lsTarihi } from "./bambu";

/** Kamera kayıtlarını "en yeni" sırasıyla silebilmek için `ls -l` tarihi okunur. */
describe("lsTarihi", () => {
  const simdi = new Date(Date.UTC(2026, 8, 23, 12, 0));

  it("saatli biçim bu yıla düşer", () => {
    expect(lsTarihi("Sep 22 14:05", simdi)).toBe(Date.UTC(2026, 8, 22, 14, 5));
  });

  it("gelecekte kalan saatli tarih geçen yıla alınır", () => {
    expect(lsTarihi("Dec 30 09:00", simdi)).toBe(Date.UTC(2025, 11, 30, 9, 0));
  });

  it("yıllı biçim", () => {
    expect(lsTarihi("Jan  5  2025", simdi)).toBe(Date.UTC(2025, 0, 5));
  });

  it("tanınmayan metin null", () => {
    expect(lsTarihi("dün", simdi)).toBeNull();
  });
});
