import zlib from "node:zlib";

/**
 * Küçük PNG çözücü — etiket resmini gri tonlu piksellere çevirir (ek paket yok).
 *
 * Desteklenen: aralıksız (interlace 0) PNG; gri / RGB / palet / gri+alfa / RGBA; 1-2-4-8-16 bit.
 * Saydam pikseller BEYAZ zemine oturtulur (etiket kağıdı beyaz). Hepsiburada etiketi 8 bit RGBA
 * geliyor (ölçüldü 13 Kas 2026).
 */

export interface GriResim {
  genislik: number;
  yukseklik: number;
  /** 0 = siyah, 255 = beyaz; satır satır. */
  piksel: Uint8Array;
}

const IMZA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KANAL: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function pngMi(veri: Buffer): boolean {
  return veri.length > 8 && veri.subarray(0, 8).equals(IMZA);
}

export function pngCoz(veri: Buffer): GriResim {
  if (!pngMi(veri)) throw new Error("PNG değil");
  let ofs = 8;
  let w = 0, h = 0, derinlik = 0, renk = 0, aralikli = 0;
  let palet: Buffer | null = null;
  let saydamlik: Buffer | null = null;
  const idat: Buffer[] = [];
  while (ofs + 8 <= veri.length) {
    const uzunluk = veri.readUInt32BE(ofs);
    const tur = veri.toString("latin1", ofs + 4, ofs + 8);
    const icerik = veri.subarray(ofs + 8, ofs + 8 + uzunluk);
    ofs += 12 + uzunluk;
    if (tur === "IHDR") {
      w = icerik.readUInt32BE(0);
      h = icerik.readUInt32BE(4);
      derinlik = icerik[8];
      renk = icerik[9];
      aralikli = icerik[12];
    } else if (tur === "PLTE") palet = icerik;
    else if (tur === "tRNS") saydamlik = icerik;
    else if (tur === "IDAT") idat.push(icerik);
    else if (tur === "IEND") break;
  }
  const kanal = KANAL[renk];
  if (!w || !h || !kanal) throw new Error("PNG başlığı okunamadı");
  if (aralikli) throw new Error("Aralıklı PNG desteklenmiyor");
  if (w * h > 40_000_000) throw new Error("PNG çok büyük");

  const bitPiksel = kanal * derinlik;
  const satirBayt = Math.ceil((w * bitPiksel) / 8);
  const adim = Math.max(1, Math.ceil(bitPiksel / 8));
  const ham = zlib.inflateSync(Buffer.concat(idat));
  if (ham.length < (satirBayt + 1) * h) throw new Error("PNG verisi eksik");

  // Filtreleri geri al.
  const satirlar = Buffer.alloc(satirBayt * h);
  for (let y = 0; y < h; y++) {
    const filtre = ham[y * (satirBayt + 1)];
    const kaynak = y * (satirBayt + 1) + 1;
    const hedef = y * satirBayt;
    const onceki = hedef - satirBayt;
    for (let i = 0; i < satirBayt; i++) {
      const x = ham[kaynak + i];
      const a = i >= adim ? satirlar[hedef + i - adim] : 0;
      const b = y > 0 ? satirlar[onceki + i] : 0;
      const c = y > 0 && i >= adim ? satirlar[onceki + i - adim] : 0;
      let deger: number;
      switch (filtre) {
        case 0: deger = x; break;
        case 1: deger = x + a; break;
        case 2: deger = x + b; break;
        case 3: deger = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          deger = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error("PNG filtresi tanınmadı");
      }
      satirlar[hedef + i] = deger & 0xff;
    }
  }

  // Örnek okuyucu: (satır, sütun, kanal) → 0..255.
  const enBuyuk = (1 << Math.min(derinlik, 8)) - 1;
  const ornek = (y: number, x: number, k: number): number => {
    const bit = (x * kanal + k) * derinlik;
    const bayt = satirlar[y * satirBayt + (bit >> 3)];
    if (derinlik === 16) return bayt; // yüksek bayt yeter
    if (derinlik === 8) return bayt;
    const kaydir = 8 - derinlik - (bit & 7);
    return (bayt >> kaydir) & enBuyuk;
  };
  const olcekle = (v: number) => (derinlik >= 8 ? v : Math.round((v * 255) / enBuyuk));

  const piksel = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r: number, g: number, bl: number, alfa = 255;
      if (renk === 3) {
        const i = ornek(y, x, 0);
        r = palet ? palet[i * 3] : 0;
        g = palet ? palet[i * 3 + 1] : 0;
        bl = palet ? palet[i * 3 + 2] : 0;
        if (saydamlik && i < saydamlik.length) alfa = saydamlik[i];
      } else if (renk === 0 || renk === 4) {
        r = g = bl = olcekle(ornek(y, x, 0));
        if (renk === 4) alfa = ornek(y, x, 1);
      } else {
        r = ornek(y, x, 0);
        g = ornek(y, x, 1);
        bl = ornek(y, x, 2);
        if (renk === 6) alfa = ornek(y, x, 3);
      }
      const parlaklik = 0.299 * r + 0.587 * g + 0.114 * bl;
      piksel[y * w + x] = Math.round((parlaklik * alfa + 255 * (255 - alfa)) / 255);
    }
  }
  return { genislik: w, yukseklik: h, piksel };
}
