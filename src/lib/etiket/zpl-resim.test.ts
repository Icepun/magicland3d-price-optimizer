/**
 * HB etiketi (100×150) → 100×100 termal etiket. PNG çözme + küçültme + ZPL grafiği.
 */
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { pngCoz, pngMi } from "./png-coz";
import { ETIKET_NOKTA, etiketeSigdir, zplGrafik } from "./zpl-resim";

/** Test için küçük PNG üretici (RGBA 8 bit, filtre 0). */
function pngYap(w: number, h: number, renk: (x: number, y: number) => [number, number, number, number]): Buffer {
  const crcTablo = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const v of b) c = crcTablo[(c ^ v) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const parca = (tur: string, veri: Buffer) => {
    const u = Buffer.alloc(4);
    u.writeUInt32BE(veri.length);
    const tv = Buffer.concat([Buffer.from(tur, "latin1"), veri]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(tv));
    return Buffer.concat([u, tv, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const ham = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    ham[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) ham.set(renk(x, y), y * (w * 4 + 1) + 1 + x * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    parca("IHDR", ihdr),
    parca("IDAT", zlib.deflateSync(ham)),
    parca("IEND", Buffer.alloc(0)),
  ]);
}

const SIYAH: [number, number, number, number] = [0, 0, 0, 255];
const BEYAZ: [number, number, number, number] = [255, 255, 255, 255];
const SAYDAM: [number, number, number, number] = [0, 0, 0, 0];

describe("png çözücü", () => {
  it("RGBA'yı griye çevirir; saydam = beyaz kağıt", () => {
    const png = pngYap(3, 1, (x) => (x === 0 ? SIYAH : x === 1 ? BEYAZ : SAYDAM));
    expect(pngMi(png)).toBe(true);
    const r = pngCoz(png);
    expect([r.genislik, r.yukseklik]).toEqual([3, 1]);
    expect(Array.from(r.piksel)).toEqual([0, 255, 255]);
  });
});

describe("100×150 → 100×100 sığdırma", () => {
  // HB ölçüsü: 812×1218; içerik kenarlara yakın (8 px pay), ortada dikey bir çubuk.
  const hb = pngCoz(
    pngYap(812, 1218, (x, y) => (x < 8 || x >= 804 || y < 8 || y >= 1210 ? BEYAZ : x >= 400 && x < 412 ? SIYAH : y === 8 || y === 1209 ? SIYAH : BEYAZ))
  );

  it("oranı koruyarak 800 noktalık kareye sığar ve ortalanır", () => {
    const s = etiketeSigdir(hb);
    expect(s.yukseklik).toBeLessThanOrEqual(ETIKET_NOKTA - 16);
    expect(s.genislik).toBeLessThanOrEqual(ETIKET_NOKTA - 16);
    // 796×1202 içerik → yükseklik sınırlar; oran ≈ 0.66.
    expect(s.genislik / s.yukseklik).toBeCloseTo(796 / 1202, 2);
    expect(s.x).toBe(Math.floor((ETIKET_NOKTA - s.genislik) / 2));
    // Dikey çubuk küçülünce de kaybolmaz (12 px → ~8 px).
    const orta = Math.floor(s.yukseklik / 2) * s.genislik;
    const kara = Array.from(s.siyah.subarray(orta, orta + s.genislik)).filter(Boolean).length;
    expect(kara).toBeGreaterThanOrEqual(6);
    expect(kara).toBeLessThanOrEqual(10);
  });

  it("kesik çizgi bulunursa yalnız üst (kargo) kısmı alınır ve daha az küçülür", () => {
    // Üstte dolu blok, y=780'de düzenli kesik çizgi (12 px parça / 8 px ara), altta fiş bloğu.
    const iki = pngCoz(
      pngYap(812, 1218, (x, y) => {
        if (y >= 40 && y < 600 && x >= 20 && x < 790) return y % 40 < 6 ? SIYAH : BEYAZ;
        if (y === 780 && x >= 10 && x < 800 && x % 20 < 12) return SIYAH;
        if (y >= 820 && y < 1180 && x >= 20 && x < 790 && y % 30 < 4) return SIYAH;
        return BEYAZ;
      })
    );
    const tam = etiketeSigdir(iki);
    const ust = etiketeSigdir(iki, ETIKET_NOKTA, { yalnizUstKisim: true });
    expect(ust.yukseklik).toBeLessThan(tam.yukseklik);
    expect(ust.genislik).toBeGreaterThan(tam.genislik);
    // Yazı/barkod satırı (düzensiz çok parçalı) kesik çizgi sanılmaz.
    expect(etiketeSigdir(hb, ETIKET_NOKTA, { yalnizUstKisim: true }).yukseklik).toBe(etiketeSigdir(hb).yukseklik);
  });

  it("tek etiketlik ZPL grafiği üretir (800×800, sıkıştırılmış satırlar)", () => {
    const z = zplGrafik(etiketeSigdir(hb));
    expect(z.startsWith("^XA^PW800^LL800")).toBe(true);
    expect(z.endsWith("^XZ")).toBe(true);
    expect(z).toMatch(/\^GFA,\d+,\d+,\d+,/);
    // Tekrarlayan satırlar ":" ile kısalır → ham onaltılıktan çok küçük.
    expect(z.length).toBeLessThan(20_000);
  });
});
