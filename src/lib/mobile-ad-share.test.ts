import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * MOBİL REKLAM PAYI KORUMASI — sahada yaşanan hatanın tekrarını engeller.
 *
 * NE OLMUŞTU: telefon reklam payını HER ZAMAN 0 hesaplıyordu, çünkü
 *   (a) `rules.ts` ciro penceresini ham MİLİSANİYE ile sorguluyordu; `orderedAt` kolonu ISO
 *       METİN olduğu için (SQLite'ta tamsayı < metin) koşul hiçbir satırı tutmuyordu → payda 0,
 *   (b) ürün ekranı ve Fiyat Lab `simulatePrice`'a `adRate` HİÇ geçmiyordu.
 * Sonuç: aynı ürün "Siparişler"de reklam payı düşülmüş, "Ürünler"de düşülmemiş kâr gösteriyordu;
 * Fiyat Lab'ın önerdiği fiyat hedef marjı tutturmuyordu. Canlı veride payda 0 ₺ yerine
 * 89.509 ₺ çıkması gerekiyordu (~%14 reklam payı).
 *
 * NEDEN YAPISAL (kaynak metni okuyan) TEST: mobil dosyalar `@core/…` ve `@/…` takma adlarını
 * MOBİL köküne göre çözüyor; kökteki vitest'te yalnız `@` → kök `src` tanımlı, dolayısıyla bu
 * modülleri doğrudan içe aktarmak takma-ad cerrahisi gerektirir. Oysa hatanın özü "şu çağrı
 * yapılmıyor" olduğu için kaynak üzerinde doğrulamak hem yeterli hem kırılgan değil.
 * (Testin `mobile/` altına KONULAMAYACAĞI kuralı için bkz. mobile/AGENTS.md — vitest orada yok,
 * iOS derlemesini kırar.)
 */

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const oku = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** `simulatePrice({ … })` çağrılarının kaç tanesi `adRate` geçiyor? */
function simulatePriceCagrilari(src: string): { toplam: number; adRateli: number } {
  const cagrilar = src.split("simulatePrice({").slice(1);
  let adRateli = 0;
  for (const parca of cagrilar) {
    // Çağrının gövdesi: ilk kapanışa kadar bak (iç içe nesne için kabaca 2000 karakter yeter).
    const govde = parca.slice(0, 2000);
    if (/\badRate\s*:/.test(govde)) adRateli += 1;
  }
  return { toplam: cagrilar.length, adRateli };
}

describe("mobil reklam payı — masaüstüyle aynı kârı üretmeli", () => {
  it("ürün ekranı simulatePrice'a adRate geçiyor", () => {
    const src = oku("mobile/src/lib/profit.ts");
    const { toplam, adRateli } = simulatePriceCagrilari(src);
    expect(toplam).toBeGreaterThan(0);
    expect(adRateli).toBe(toplam); // TEK bir çağrı bile atlanırsa o ekran kârı fazla gösterir
  });

  it("Fiyat Lab simulatePrice'a adRate geçiyor", () => {
    const src = oku("mobile/src/lib/price-lab.ts");
    const { toplam, adRateli } = simulatePriceCagrilari(src);
    expect(toplam).toBeGreaterThan(0);
    expect(adRateli).toBe(toplam);
  });

  it("sipariş kârı adRate geçmeye devam ediyor", () => {
    expect(oku("mobile/src/lib/order-profit.ts")).toContain("adRate:");
  });

  it("oran her üç yerde de ortak çekirdek fonksiyonuyla hesaplanıyor", () => {
    for (const dosya of [
      "mobile/src/lib/profit.ts",
      "mobile/src/lib/price-lab.ts",
      "mobile/src/lib/order-profit.ts",
    ]) {
      expect(oku(dosya), dosya).toContain("reklamOraniIcin");
    }
  });
});

describe("mobil tarih karşılaştırması — biçimden bağımsız olmalı", () => {
  it("reklam ciro penceresi dbEpochMs ile normalize ediliyor (ham ms DEĞİL)", () => {
    const src = oku("mobile/src/lib/db/rules.ts");
    expect(src).toContain("dbEpochMs");
    // Ham `orderedAt >= ?` kalmışsa metin/sayı tuzağı geri gelmiş demektir.
    expect(src).not.toMatch(/WHERE\s+orderedAt\s*>=/);
  });

  it("telefon tarih yazma biçimini açılışta sabitliyor", () => {
    const src = oku("mobile/src/lib/turso.ts");
    expect(src).toContain('setDbDateStorage("iso-text")');
  });

  it("biçim bilgisi ORTAK çekirdekte tek kopya", () => {
    // Masaüstü tarafı yalnız yönlendirici olmalı; mantık çekirdekte.
    expect(fs.existsSync(path.join(ROOT, "src/core/sqlite-date.ts"))).toBe(true);
    const shim = oku("src/lib/sqlite-date.ts");
    expect(shim).toContain('from "@/core/sqlite-date"');
    expect(shim).not.toContain("julianday"); // mantık kopyalanmış olurdu
  });
});
