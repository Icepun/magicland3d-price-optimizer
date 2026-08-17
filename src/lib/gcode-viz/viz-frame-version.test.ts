/**
 * KARE SÜRÜMÜ — "iyileştirme ekrana ulaşmıyor" tuzağının kalıcı koruması.
 *
 * Kareler diskte içerik hash'iyle saklanıyor. Çizim kodunu iyileştirdiğimizde anahtar
 * değişmediği için kullanıcı ESKİ kareleri görmeye devam ediyordu — iki kez yaşandı ve
 * tsc/eslint/test üçü de tertemiz geçiyordu.
 *
 * Bu dosya iki şeyi kilitler: kare anahtarı paket anahtarından AYRI olmalı (yoksa 155 MB'lık
 * dosya boşuna yeniden taranır) ve sürüm gerçekten anahtara girmeli.
 */
import { describe, expect, it } from "vitest";
import { KARE_SURUMU, kareAnahtari, vizKeyForModel } from "./viz-cache";

describe("kare sürümü", () => {
  it("kare anahtarı PAKET anahtarından farklı — tarama boşa gitmesin", () => {
    const paket = "md5:a1b2c3d4e5";
    expect(kareAnahtari(paket)).not.toBe(paket);
    expect(kareAnahtari(paket).startsWith(paket)).toBe(true);
  });

  it("sürüm anahtara giriyor", () => {
    expect(kareAnahtari("md5:abc")).toContain(String(KARE_SURUMU));
  });

  it("sürüm artınca ESKİ kareler artık bulunamaz", () => {
    // Aynı dosya, farklı sürüm → farklı anahtar. İyileştirmenin ekrana ulaşmasını sağlayan şey bu.
    const dosya = { id: "x", contentMd5: "a".repeat(32), sizeBytes: 10 };
    const anahtar = kareAnahtari(vizKeyForModel(dosya));
    expect(anahtar).not.toBe(`${vizKeyForModel(dosya)}#k${KARE_SURUMU + 1}`);
  });

  it("aynı içerik aynı anahtarı verir — her açılışta yeniden üretilmesin", () => {
    const dosya = { id: "x", contentMd5: "b".repeat(32), sizeBytes: 10 };
    expect(kareAnahtari(vizKeyForModel(dosya))).toBe(kareAnahtari(vizKeyForModel(dosya)));
  });

  it("SÜRÜM v1'DE KALMAMIŞ — ışıklandırma değişti", () => {
    // tube-shading normali düzeltildiğinde bu sürümün artması gerekiyordu.
    expect(KARE_SURUMU).toBeGreaterThanOrEqual(2);
  });
});
