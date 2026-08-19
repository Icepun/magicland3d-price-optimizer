/**
 * TRENDYOL'UN KENDİ KOMİSYON ORANI — kâr rakamına dokunan bir alan, koruması şart.
 *
 * Ürün v2 ile Trendyol komisyonu ürün bazında bildiriyor; bugüne kadar kategori
 * kurallarından tahmin ediliyordu. `Product.commissionRate` alanı bunun için açılmış ama
 * hiçbir yer yazmıyordu.
 *
 * İKİ KIRMIZI ÇİZGİ:
 *  1) Oran YÜZDE geliyor (21.0), hesabımız KESİR kullanıyor (0.21). Çevrilmezse komisyon
 *     100 kat büyür ve kâr eksiye düşer — sessizce.
 *  2) Kullanıcının elle girdiği oran ASLA ezilmemeli.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SENKRON = readFileSync(
  join(process.cwd(), "src/app/api/trendyol/sync-products/route.ts"),
  "utf8",
);

/** Rotadaki dönüştürücünün birebir aynısı (davranışı burada sınanıyor). */
function komisyonKesri(v: number | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const kesir = v > 1 ? v / 100 : v;
  if (kesir <= 0 || kesir >= 1) return null;
  return Math.round(kesir * 10000) / 10000;
}

describe("komisyon oranı dönüşümü", () => {
  it("YÜZDE gelirse kesire çevrilir", () => {
    expect(komisyonKesri(21)).toBe(0.21);
    expect(komisyonKesri(12.5)).toBe(0.125);
  });

  it("zaten kesirse dokunulmaz", () => {
    expect(komisyonKesri(0.21)).toBe(0.21);
  });

  it("SAÇMA değerler yok sayılır — kâr sessizce bozulmasın", () => {
    expect(komisyonKesri(0)).toBeNull();
    expect(komisyonKesri(-5)).toBeNull();
    expect(komisyonKesri(100)).toBeNull(); // %100 komisyon gerçek değil
    expect(komisyonKesri(150)).toBeNull();
    expect(komisyonKesri(undefined)).toBeNull();
    expect(komisyonKesri(Number.NaN)).toBeNull();
  });

  it("dört basamağa yuvarlanır (gereksiz yazma olmasın)", () => {
    expect(komisyonKesri(21.23456)).toBe(0.2123);
  });
});

describe("elle girilen oran korunuyor", () => {
  it("başka kaynaklı satır atlanıyor", () => {
    expect(SENKRON).toMatch(/commissionSource && pr\.commissionSource !== "trendyol"/);
  });

  it("yazarken kaynak damgalanıyor", () => {
    // Damga olmadan bir sonraki senkron kendi yazdığını "yabancı" sanıp atlardı.
    expect(SENKRON).toContain("commissionSource = 'trendyol'");
  });

  it("değişmeyen oran yeniden YAZILMIYOR", () => {
    // Uzak-HTTP'de her yazma ~96 ms; her senkronda 300 satırı yeniden yazmak kabul edilemez.
    expect(SENKRON).toMatch(/Math\.abs\(pr\.commissionRate - yeniOran\) < 0\.0001/);
  });

  it("toplu yazma kullanılıyor", () => {
    expect(SENKRON).toContain("batchWrite(komisyonYazma)");
  });
});
