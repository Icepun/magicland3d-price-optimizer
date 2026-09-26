import { describe, expect, it } from "vitest";
import {
  MASAUSTU_BILDIRIM_TURLERI,
  TELEFON_BILDIRIM_TURLERI,
  bildirimAcik,
  bildirimTuruBul,
  kapaliListesi,
  kapaliMetni,
} from "./bildirim-turleri";

/**
 * Cihaz başına bildirim tercihi — "Simay telefonuna yalnız sipariş bildirimi istiyor".
 * Tercih KAPATILANLARIN listesi: yeni bir tür eklenince her cihazda varsayılanı açık olmalı.
 */
describe("bildirim türü eşlemesi", () => {
  it("kalıcı satırlar kimliğinden eşlenir", () => {
    expect(bildirimTuruBul({ id: "order-new:trendyol:123", type: "order-new" })).toBe("siparis");
    expect(bildirimTuruBul({ id: "printer-done:p1:1700000000000", type: "printer-done" })).toBe("baski-bitti");
    expect(bildirimTuruBul({ id: "printer-fault:p1:1700000000000", type: "printer-error" })).toBe("baski-sorun");
    expect(bildirimTuruBul({ id: "printer-fault:p1:1700000000000", type: "printer-paused" })).toBe("baski-sorun");
    expect(bildirimTuruBul({ id: "stock-abc", type: "stock" })).toBe("stok");
    expect(bildirimTuruBul({ id: "site-stock-abc", type: "site-stock" })).toBe("stok");
    expect(bildirimTuruBul({ id: "filament-pla__siyah", type: "filament" })).toBe("filament");
  });

  it("masaüstü zilinin daraltılmış tipleriyle de doğru eşlenir", () => {
    // /api/notifications kalıcı satırın tipini gruba indiriyor: printer-done → "printer".
    expect(bildirimTuruBul({ id: "printer-done:p1:1", type: "printer" })).toBe("baski-bitti");
    expect(bildirimTuruBul({ id: "printer-p1-error", type: "printer" })).toBe("baski-sorun");
    expect(bildirimTuruBul({ id: "printer-p1-paused", type: "printer" })).toBe("baski-sorun");
    // Eski makara satırı telefonda "order" tipine düşüyor — kimliği yine filament demeli.
    expect(bildirimTuruBul({ id: "spool-s1", type: "order" })).toBe("filament");
  });

  it("telefondaki anlık yazıcı uyarısı baskı sorunudur", () => {
    expect(bildirimTuruBul({ id: "print-p1", type: "print" })).toBe("baski-sorun");
  });

  it("bilinmeyen bildirim hiçbir türe atanmaz (her zaman görünür)", () => {
    expect(bildirimTuruBul({ id: "bambaska-bir-sey", type: "yeni-tur" })).toBeNull();
    expect(bildirimAcik("siparis,baski-bitti", null)).toBe(true);
  });
});

describe("kapalı tür listesi", () => {
  it("bozuk/bilinmeyen parçaları atar, tekrarları birleştirir", () => {
    expect(kapaliListesi(" baski-bitti ,stok,uydurma,,stok")).toEqual(["baski-bitti", "stok"]);
    expect(kapaliListesi(null)).toEqual([]);
    expect(kapaliListesi("")).toEqual([]);
  });

  it("saklanan metin sıralı ve tekrarsız", () => {
    expect(kapaliMetni(["stok", "baski-bitti", "stok", "uydurma"])).toBe("baski-bitti,stok");
    expect(kapaliMetni([])).toBe("");
  });

  it("boş tercih = her şey açık; kapatılan tür kapalı", () => {
    expect(bildirimAcik("", "baski-bitti")).toBe(true);
    expect(bildirimAcik(null, "siparis")).toBe(true);
    expect(bildirimAcik("baski-bitti,baski-sorun", "baski-bitti")).toBe(false);
    expect(bildirimAcik("baski-bitti,baski-sorun", "siparis")).toBe(true);
  });

  it("telefon türleri masaüstü türlerinin alt kümesi (stok/filament telefona push gitmez)", () => {
    const masaustu = MASAUSTU_BILDIRIM_TURLERI.map((t) => t.anahtar);
    const telefon = TELEFON_BILDIRIM_TURLERI.map((t) => t.anahtar);
    expect(telefon.every((t) => masaustu.includes(t))).toBe(true);
    expect(telefon).not.toContain("stok");
    expect(telefon).not.toContain("filament");
  });
});
