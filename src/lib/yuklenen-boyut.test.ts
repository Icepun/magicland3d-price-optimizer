import { describe, expect, it } from "vitest";
import { yuklenenBoyutEkle } from "./yuklenen-boyut";

/**
 * U1'e giden dosya parça iptali komutlarıyla büyüdüğü için "yazıcıda hazır" kısayolu hiç
 * tutmuyordu (19 Kas 2026). Yüklenen boyut içerik imzalı adla saklanıyor; bu testler kaydın
 * sınırsız büyümediğini ve yenisinin eskisinin yerine geçtiğini kilitler.
 */
describe("yüklenen boyut kaydı", () => {
  it("yeni kayıt eklenir, aynı adın eski boyutu güncellenir", () => {
    let h = yuklenenBoyutEkle({}, "Vazo-1a2b3c4d5e.gcode", 1_009_000);
    h = yuklenenBoyutEkle(h, "Kapak-9f8e7d6c5b.gcode", 52_000);
    h = yuklenenBoyutEkle(h, "Vazo-1a2b3c4d5e.gcode", 1_009_500);
    expect(h).toEqual({ "Kapak-9f8e7d6c5b.gcode": 52_000, "Vazo-1a2b3c4d5e.gcode": 1_009_500 });
  });

  it("tavanı aşınca EN ESKİ kayıtlar düşer, en yeniler kalır", () => {
    let h: Record<string, number> = {};
    for (let i = 0; i < 6; i++) h = yuklenenBoyutEkle(h, `d${i}.gcode`, 100 + i, 4);
    expect(Object.keys(h)).toEqual(["d2.gcode", "d3.gcode", "d4.gcode", "d5.gcode"]);
  });

  it("yeniden yüklenen eski dosya listenin sonuna geçer (en son kullanılan düşmez)", () => {
    let h: Record<string, number> = {};
    for (const ad of ["a", "b", "c"]) h = yuklenenBoyutEkle(h, ad, 1, 3);
    h = yuklenenBoyutEkle(h, "a", 2, 3); // a yeniden basıldı
    h = yuklenenBoyutEkle(h, "d", 1, 3); // en eski artık b
    expect(Object.keys(h)).toEqual(["c", "a", "d"]);
  });
});
