import { describe, expect, it } from "vitest";

import { gunEtiketi, gunlereBol } from "./gun-basliklari";

// Cuma 9 Ekim 2026 18:00 İstanbul.
const SIMDI = Date.parse("2026-10-09T15:00:00.000Z");
const s = (iso: string | null, id: string) => ({ id, date: iso });

describe("sipariş listesinde gün başlıkları", () => {
  it("gün değişince başlık girer, adetler doğru", () => {
    const satirlar = gunlereBol(
      [
        s("2026-10-09T10:00:00.000Z", "a"),
        s("2026-10-09T08:00:00.000Z", "b"),
        s("2026-10-08T20:00:00.000Z", "c"), // 8 Eki 23:00 İstanbul → Dün
        s("2026-10-06T09:00:00.000Z", "d"),
      ],
      SIMDI
    );
    const basliklar = satirlar.filter((r) => r.tur === "gun");
    expect(basliklar.map((b) => (b.tur === "gun" ? `${b.etiket}:${b.adet}` : ""))).toEqual([
      "Bugün:2",
      "Dün:1",
      "6 Ekim Salı:1",
    ]);
    expect(satirlar).toHaveLength(7);
  });

  it("İstanbul gece yarısı sınırı: 21:30 UTC ertesi gündür", () => {
    const satirlar = gunlereBol([s("2026-10-08T21:30:00.000Z", "x")], SIMDI);
    expect(satirlar[0]).toMatchObject({ tur: "gun", etiket: "Bugün" });
  });

  it("tarihsiz sipariş kaybolmaz", () => {
    const satirlar = gunlereBol([s(null, "y")], SIMDI);
    expect(satirlar[0]).toMatchObject({ tur: "gun", etiket: "Tarihi bilinmeyen", adet: 1 });
  });

  it("etiket biçimi", () => {
    expect(gunEtiketi("2026-10-07", SIMDI)).toBe("7 Ekim Çarşamba");
  });
});
