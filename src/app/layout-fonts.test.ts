/**
 * YAZI TİPİ REPODA — derleme ağa bağlı olmamalı.
 *
 * NEDEN VAR: `next/font/google` yazı tipini DERLEME SIRASINDA fonts.gstatic.com'dan indirir.
 * 14 Ağu 2026'da macOS derleme koşucusu oraya ulaşamadı ve v0.19.185 yayını
 * "Failed to fetch font file" ile düştü — aynı commit Windows'ta sorunsuz derlenmişti.
 * Yani sürüm yayınlayabilmek GitHub koşucusunun ağına bağlıydı ve kod değişmeden
 * bir dahaki sefere yine düşebilirdi.
 *
 * Bu test, birinin farkında olmadan `next/font/google`'a geri dönmesini engeller. Geri dönüş
 * YERELDE hiçbir belirti vermez (geliştirme makinesinin interneti vardır); ilk belirti
 * aylar sonra düşen bir yayın derlemesi olur.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const KOK = join(__dirname, "..", "..");
const layout = readFileSync(join(KOK, "src", "app", "layout.tsx"), "utf8");

describe("yazı tipleri repodan gelir", () => {
  it("`next/font/google` KULLANILMAZ — derleme ağdan yazı tipi çekmez", () => {
    // Yorum içinde geçmesi serbest (yukarıdaki açıklama onu anıyor); yasak olan GERÇEK import.
    expect(layout).not.toMatch(/from\s+["']next\/font\/google["']/);
    expect(layout).toMatch(/from\s+["']next\/font\/local["']/);
  });

  it("yerel yazı tipi dosyaları GERÇEKTEN var ve boş değil", () => {
    for (const ad of ["PlusJakartaSans", "GeistMono"]) {
      const yol = join(KOK, "src", "app", "fonts", `${ad}.ttf`);
      // 50 KB altı = büyük ihtimalle indirme HTML hata sayfası yakalamış.
      expect(statSync(yol).size).toBeGreaterThan(50_000);
      // TrueType imzası: 0x00010000.
      expect(readFileSync(yol).subarray(0, 4).toString("hex")).toBe("00010000");
    }
  });

  it("CSS değişken adları korunuyor — arayüz yazı tipsiz kalmasın", () => {
    // globals.css / tailwind bu iki adı bekliyor; adı değiştirmek sessizce
    // her şeyi tarayıcının varsayılan yazı tipine düşürür.
    expect(layout).toContain('variable: "--font-sans"');
    expect(layout).toContain('variable: "--font-geist-mono"');
  });
});
