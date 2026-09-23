/**
 * KART GÖRSELİ HANGİ KAYNAKTAN GELİYOR — kalıcı koruma.
 *
 * Bu sınıf hatayı iki kez yedik: daha iyi bir görsel üretildi ama EKRANA HİÇ ULAŞMADI.
 * Kart, kendi ürettiğimiz inşa karelerini koşulsuz öne alıyordu; slicer'ın gölgeli render'ı
 * arkada bekliyordu.
 *
 * 23 Eyl 2026 — KULLANICI KARARI: kartın görseli artık CANLI 3B (KartUcBoyut). Dilimleyicinin
 * resmi alttan düz bir maskeyle açılıyordu; yassı parçada birkaç mm basılmışken resmin yarısı
 * "basıldı" görünüyordu. Resim yalnız 3B hazır olana dek (ya da WebGL yoksa) YEDEK. Hazır kareler
 * (inşa kareleri) tamamen kaldırıldı.
 *
 * Bileşen testi kurulu değil (RTL yok), o yüzden kaynak düzeyinde koruma: öncelik ifadesi
 * ve prop bağlantısı bozulursa bu test düşer.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const KART = readFileSync(join(process.cwd(), "src/app/printers/page.tsx"), "utf8");
const GORSEL = KART.slice(KART.indexOf("function JobVisual"), KART.indexOf("function VisualPlaceholder"));

describe("kart görseli kaynağı", () => {
  it("canlı 3B karta gerçekten bağlanmış — paket ve canlı ölçümle", () => {
    expect(KART).toContain("<JobVisual");
    expect(KART).toMatch(/uc=\{\s*modelGoster && live\.pack/);
    expect(KART).toMatch(/ornek: canliOrnek/);
    expect(GORSEL).toContain("<KartUcBoyut");
  });

  it("3B hazır olunca yedek görsel söner, hazır değilken yedek görünür", () => {
    expect(GORSEL).toMatch(/ucHazir \? "opacity-0" : "opacity-100"/);
    expect(GORSEL).toMatch(/ucHazir \? "opacity-100" : "opacity-0"/);
  });

  it("WebGL yoksa ya da bağlam kaybedilirse yedek görsele döner", () => {
    expect(GORSEL).toMatch(/onHata=\{\(\) => setUcHataPaket\(uc\.pack\)\}/);
    expect(GORSEL).toMatch(/const ucGoster = !!uc && ucHataPaket !== uc\.pack/);
  });

  it("hazır inşa kareleri tamamen kalktı (eski kaynak öne geçemez)", () => {
    expect(KART).not.toMatch(/getSprites|kareAnahtari|frameIndex=/);
  });

  it("yedek: slicer render'ı karta bağlı ve açılım oranı clip-path'e bağlı", () => {
    expect(KART).toMatch(/plateSrc=\{job\.plateThumbnail\}/);
    expect(KART).toMatch(/ratio=\{framePick\.ratio\}/);
    expect(KART).toMatch(/clipPath: `inset\(\$\{100 - yuzde\}% 0 0 0\)`/);
  });

  it("yedek görsel yüklenemezse sıradakine döner — kırık resim kalmaz", () => {
    expect(KART).toMatch(/const plate = plateAday && plateAday !== plateFailed \? plateAday : null/);
    expect(KART).toMatch(/onError=\{\(\) => setPlateFailed\(plate\)\}/);
  });

  it("hareket azaltma isteğine uyar", () => {
    const bolum = KART.slice(KART.indexOf("function BuildReveal"), KART.indexOf("function JobVisual"));
    expect(bolum).toContain("!reduceMotion && \"transition-[clip-path]");
    expect(bolum).toContain("!reduceMotion && \"transition-[bottom]");
    expect(GORSEL).toContain("reduceMotion={reduceMotion}");
  });
});
