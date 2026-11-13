import type { GriResim } from "./png-coz";

/**
 * Etiket resmini 100×100 mm termal etikete SIĞDIRIP ZPL grafiğine (^GFA) çevirir.
 *
 * NEDEN: Hepsiburada etiketi 100×150 mm (203 dpi'da 812×1218) tasarlanmış; 100×100 etikete
 * olduğu gibi basılınca iki sticker'a bölünüyor. ZPL komutları ölçeklenemez (barkod modül
 * genişliği tam sayı), bu yüzden etiketin RESMİ alınır: boşluk kırpılır, oran korunarak
 * küçültülür (alan ortalaması), ortalanır ve siyah/beyaza çevrilir. Berke'nin panelden
 * "küçülterek" bastığı çıktının aynısı, ama ayar gerektirmeden.
 */

/** 203 dpi = 8 nokta/mm → 100 mm. */
export const ETIKET_NOKTA = 800;
const KENAR = 8;
/** Ortalama parlaklık bunun altındaysa nokta yanar. 128'den biraz yüksek: ince yazılar silinmesin. */
const ESIK = 150;

interface Kutu { x0: number; y0: number; x1: number; y1: number }

function icerikKutusu(r: GriResim): Kutu | null {
  let x0 = r.genislik, y0 = r.yukseklik, x1 = -1, y1 = -1;
  for (let y = 0; y < r.yukseklik; y++) {
    const s = y * r.genislik;
    for (let x = 0; x < r.genislik; x++) {
      if (r.piksel[s + x] < 200) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** Tek eksende alan ortalamalı yeniden örnekleme ağırlıkları. */
function agirliklar(kaynakBas: number, kaynakBoy: number, hedefBoy: number) {
  const oran = kaynakBoy / hedefBoy;
  const sonuc: Array<Array<[number, number]>> = [];
  for (let i = 0; i < hedefBoy; i++) {
    const bas = kaynakBas + i * oran;
    const son = bas + oran;
    const liste: Array<[number, number]> = [];
    for (let k = Math.floor(bas); k < Math.ceil(son); k++) {
      const pay = Math.min(son, k + 1) - Math.max(bas, k);
      if (pay > 0) liste.push([k, pay / oran]);
    }
    sonuc.push(liste);
  }
  return sonuc;
}

export interface SigdirilmisResim {
  genislik: number;
  yukseklik: number;
  /** Etiket içindeki sol üst konum (nokta). */
  x: number;
  y: number;
  /** true = siyah nokta; satır satır. */
  siyah: Uint8Array;
}

/**
 * Etiketi ikiye bölen yatay KESİK çizgi (HB: üstte kargo etiketi, altta paket fişi). Kesik
 * çizgi satırı: genişliğin çoğuna yayılmış, çok sayıda kısa siyah parça. Bulunamazsa null.
 */
export function kesikCizgiSatiri(r: GriResim): number | null {
  for (let y = Math.floor(r.yukseklik * 0.3); y < Math.floor(r.yukseklik * 0.9); y++) {
    if (kesikCizgiMi(r, y)) return y;
  }
  return null;
}

/**
 * Bir satır DÜZENLİ kesik çizgi mi? Yazı ya da barkod satırı da çok parçalı olur; ayırt eden
 * şey düzen: parçalar ve aralar hep aynı boyda, satırın neredeyse tamamına yayılmış.
 */
function kesikCizgiMi(r: GriResim, y: number): boolean {
  const s = y * r.genislik;
  const parcalar: number[] = [];
  const aralar: number[] = [];
  let x = 0;
  while (x < r.genislik && r.piksel[s + x] >= 128) x++;
  const ilk = x;
  let son = ilk;
  while (x < r.genislik) {
    let p = 0;
    while (x < r.genislik && r.piksel[s + x] < 128) { p++; x++; }
    if (p) { parcalar.push(p); son = x; }
    let a = 0;
    while (x < r.genislik && r.piksel[s + x] >= 128) { a++; x++; }
    if (a && x < r.genislik) aralar.push(a);
  }
  if (parcalar.length < 25 || son - ilk < r.genislik * 0.8) return false;
  const duzenli = (liste: number[]) => {
    const sirali = [...liste].sort((a, b) => a - b);
    const orta = sirali[Math.floor(sirali.length / 2)];
    const uyan = liste.filter((v) => Math.abs(v - orta) <= Math.max(1, orta * 0.25)).length;
    return orta >= 2 && uyan >= liste.length * 0.9;
  };
  return duzenli(parcalar) && aralar.length > 0 && duzenli(aralar);
}

/** Resmin yalnız bir dikey dilimi (kopya değil, yeni dizi). */
function dikeyKes(r: GriResim, y0: number, y1: number): GriResim {
  return {
    genislik: r.genislik,
    yukseklik: y1 - y0,
    piksel: r.piksel.slice(y0 * r.genislik, y1 * r.genislik),
  };
}

export function etiketeSigdir(
  kaynakResim: GriResim,
  hedef = ETIKET_NOKTA,
  secenek: { yalnizUstKisim?: boolean } = {}
): SigdirilmisResim {
  let r = kaynakResim;
  if (secenek.yalnizUstKisim) {
    const cizgi = kesikCizgiSatiri(r);
    if (cizgi !== null) r = dikeyKes(r, 0, cizgi - 2);
  }
  const kutu = icerikKutusu(r) ?? { x0: 0, y0: 0, x1: r.genislik, y1: r.yukseklik };
  const cw = kutu.x1 - kutu.x0;
  const ch = kutu.y1 - kutu.y0;
  const alan = hedef - 2 * KENAR;
  const olcek = Math.min(1, alan / cw, alan / ch);
  const ow = Math.max(1, Math.round(cw * olcek));
  const oh = Math.max(1, Math.round(ch * olcek));

  // Ayrılabilir alan ortalaması: önce yatay, sonra dikey.
  const yatayA = agirliklar(kutu.x0, cw, ow);
  const ara = new Float32Array(ow * ch);
  for (let y = 0; y < ch; y++) {
    const s = (kutu.y0 + y) * r.genislik;
    for (let x = 0; x < ow; x++) {
      let t = 0;
      for (const [k, a] of yatayA[x]) t += r.piksel[s + k] * a;
      ara[y * ow + x] = t;
    }
  }
  const dikeyA = agirliklar(0, ch, oh);
  const siyah = new Uint8Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let t = 0;
      for (const [k, a] of dikeyA[y]) t += ara[k * ow + x] * a;
      siyah[y * ow + x] = t < ESIK ? 1 : 0;
    }
  }
  return {
    genislik: ow,
    yukseklik: oh,
    x: Math.floor((hedef - ow) / 2),
    y: Math.floor((hedef - oh) / 2),
    siyah,
  };
}

/**
 * Siyah/beyaz resmi tek etiketlik ZPL'e çevirir. ZPL'in "sıkıştırılmış ASCII" kısaltmaları:
 * ":" = önceki satırın aynısı, "," = satırın kalanı beyaz. (Etiketin çoğu beyaz → küçük iş.)
 */
export function zplGrafik(s: SigdirilmisResim, hedef = ETIKET_NOKTA): string {
  const satirBayt = Math.ceil(s.genislik / 8);
  const toplam = satirBayt * s.yukseklik;
  const parcalar: string[] = [];
  let onceki: string | null = null;
  for (let y = 0; y < s.yukseklik; y++) {
    let satir = "";
    for (let b = 0; b < satirBayt; b++) {
      let deger = 0;
      for (let bit = 0; bit < 8; bit++) {
        const x = b * 8 + bit;
        if (x < s.genislik && s.siyah[y * s.genislik + x]) deger |= 0x80 >> bit;
      }
      satir += deger.toString(16).toUpperCase().padStart(2, "0");
    }
    if (satir === onceki) {
      parcalar.push(":");
      continue;
    }
    onceki = satir;
    const kirpik = satir.replace(/0+$/, "");
    parcalar.push(kirpik.length === satir.length ? satir : `${kirpik},`);
  }
  return (
    `^XA^PW${hedef}^LL${hedef}^LH0,0` +
    `^FO${s.x},${s.y}^GFA,${toplam},${toplam},${satirBayt},${parcalar.join("")}^FS` +
    `^PQ1^XZ`
  );
}
