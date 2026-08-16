/**
 * KART GÖRSELİ HANGİ KAYNAKTAN GELİYOR — kalıcı koruma.
 *
 * Bu sınıf hatayı iki kez yedik: daha iyi bir görsel üretildi ama EKRANA HİÇ ULAŞMADI.
 * Kart, kendi ürettiğimiz inşa karelerini koşulsuz öne alıyordu; kareler baskı yollarını
 * üst üste bindirdiği için model beyaz bir siluete dönüşüyor, slicer'ın gölgeli render'ı
 * ise arkada bekliyordu.
 *
 * Bileşen testi kurulu değil (RTL yok), o yüzden kaynak düzeyinde koruma: öncelik ifadesi
 * ve prop bağlantısı bozulursa bu test düşer.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const KART = readFileSync(join(process.cwd(), "src/app/printers/page.tsx"), "utf8");

describe("kart görseli kaynağı", () => {
  it("slicer render'ı KARELERDEN önce gelir", () => {
    // hasFrames yalnız plate yokken doğru olabilir.
    expect(KART).toMatch(/const hasFrames = !plate && list\.length > 0/);
  });

  it("slicer render'ı karta gerçekten bağlanmış", () => {
    // Prop geçilmezse görsel sessizce kaybolur; tsc bunu yakalamaz (opsiyonel değil ama
    // yanlışlıkla null sabitine bağlanabilir).
    expect(KART).toMatch(/plateSrc=\{job\.plateThumbnail\}/);
    expect(KART).toMatch(/ratio=\{framePick\.ratio\}/);
  });

  it("açılım oranı clip-path'e bağlı — ilerleme görsele yansısın", () => {
    expect(KART).toMatch(/clipPath: `inset\(\$\{100 - yuzde\}% 0 0 0\)`/);
  });

  it("hareket azaltma isteğine uyar", () => {
    // Açılım ve düzlem çizgisi geçişleri reduceMotion'da kapanmalı.
    const bolum = KART.slice(KART.indexOf("function BuildReveal"), KART.indexOf("function JobVisual"));
    expect(bolum).toContain("!reduceMotion && \"transition-[clip-path]");
    expect(bolum).toContain("!reduceMotion && \"transition-[bottom]");
  });
});
