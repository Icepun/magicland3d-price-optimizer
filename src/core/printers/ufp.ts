import zlib from "node:zlib";

/**
 * SIKIŞTIRILMIŞ AKTARIM — G-code'u yazıcıya zip (UFP) olarak gönder, yazıcı kendisi açsın.
 *
 * Sorun (8 Kas 2026, ölçüldü): 211 MB'lık "Sauron Pelerin" U1 Üst'e üç denemede de gitmedi.
 * Bilgisayar kabloluydu; darboğaz yazıcının WiFi'ıydı — iki U1 de dosyayı en iyi ihtimalle
 * 100–700 KB/sn ile alıyor, U1 Üst o akşam boştayken bile paketlerin %46'sını kaybediyordu.
 * Aktarım ne kadar uzun sürerse bir kopuşa denk gelme ihtimali o kadar büyük; her deneme de
 * baştan başlıyor.
 *
 * Moonraker `.ufp` (Ultimaker Format Package) yüklemesini tanıyor: zip'in içindeki
 * `/3D/model.gcode`'u aynı adla `.gcode` olarak çıkarıyor ve zip'i siliyor. U1'de denendi:
 * çıkan dosya bayt bayt aynı, yanıttaki `item.path` zaten `.gcode`. G-code düz metin olduğu
 * için ~3 kat küçülüyor (ölçüldü: 211 MB → 65 MB, 16,7 MB → 5,0 MB) → aktarım ~3 kat kısa.
 *
 * Sıkıştırma `zlib` iş parçacığı havuzunda koşar (ana döngüyü kilitlemez; 211 MB ≈ 8 sn) ve
 * yüzde bildirir. Zip kabı elle yazılır: tek kayıt, zip64 gerekmez (Moonraker sınırı zaten 4 GB).
 */

/** Moonraker'ın aradığı yol — başındaki eğik çizgi ŞART (Python `zf.extract` adı birebir arar). */
export const UFP_MODEL_YOLU = "/3D/model.gcode";

/** Zip32 sınırı: bundan büyük dosya ham gönderilir. */
const ZIP32_AZAMI = 0xffff_ffff;

const PARCA = 4 * 1024 * 1024;

/* ── CRC-32 (zip) ─ Node ≥20.15 `zlib.crc32` sunar; yoksa tablo ile (yine parça parça). ── */
let tablo: Uint32Array | null = null;
function crcTablosu(): Uint32Array {
  if (tablo) return tablo;
  tablo = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tablo[n] = c >>> 0;
  }
  return tablo;
}
function crcJs(veri: Uint8Array, onceki: number): number {
  const t = crcTablosu();
  let c = (onceki ^ 0xffffffff) >>> 0;
  for (let i = 0; i < veri.length; i++) c = t[(c ^ veri[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
type Crc32Fn = (veri: Uint8Array, onceki?: number) => number;
const yerelCrc = (zlib as unknown as { crc32?: Crc32Fn }).crc32;
export function crc32(veri: Uint8Array, onceki = 0): number {
  return yerelCrc ? yerelCrc(veri, onceki) >>> 0 : crcJs(veri, onceki);
}

/** UFP ile gönderilebilir mi? Yalnız `.gcode` (Moonraker çıktıyı HEP `.gcode` adlandırır). */
export function ufpUygunMu(dosyaAdi: string, boyut: number): boolean {
  return /\.gcode$/.test(dosyaAdi) && boyut > 0 && boyut < ZIP32_AZAMI;
}

/** "ad-abc.gcode" → "ad-abc.ufp" — yazıcı bunu yine "ad-abc.gcode" olarak kaydeder. */
export function ufpAdi(gcodeAdi: string): string {
  return gcodeAdi.replace(/\.gcode$/, ".ufp");
}

/**
 * G-code'u UFP zip'ine paketle. `onPct` 0–100 arası sıkıştırma ilerlemesini bildirir.
 * Zip yapısı: yerel başlık + ham deflate verisi + merkez dizin + dizin sonu (tek kayıt).
 */
export async function ufpPaketle(gcode: Buffer, onPct?: (pct: number) => void): Promise<Buffer> {
  if (gcode.length >= ZIP32_AZAMI) throw new Error("Dosya zip için fazla büyük");
  const sikistir = zlib.createDeflateRaw({ level: 6 });
  const cikti: Buffer[] = [];
  let cikanBayt = 0;
  sikistir.on("data", (c: Buffer) => { cikti.push(c); cikanBayt += c.length; });
  const bitti = new Promise<void>((resolve, reject) => {
    sikistir.once("end", resolve);
    sikistir.once("error", reject);
  });

  let crc = 0;
  let sonPct = -1;
  for (let off = 0; off < gcode.length; off += PARCA) {
    const parca = gcode.subarray(off, Math.min(off + PARCA, gcode.length));
    crc = crc32(parca, crc);
    if (!sikistir.write(parca)) {
      await new Promise<void>((resolve, reject) => {
        const hata = (e: Error) => { sikistir.off("drain", bosaldi); reject(e); };
        const bosaldi = () => { sikistir.off("error", hata); resolve(); };
        sikistir.once("drain", bosaldi);
        sikistir.once("error", hata);
      });
    }
    const pct = Math.min(99, Math.floor(((off + parca.length) / gcode.length) * 100));
    if (onPct && pct !== sonPct) { sonPct = pct; onPct(pct); }
  }
  sikistir.end();
  await bitti;
  if (cikanBayt >= ZIP32_AZAMI) throw new Error("Sıkıştırılmış dosya zip için fazla büyük");

  const ad = Buffer.from(UFP_MODEL_YOLU, "utf8");
  const DOS_SAAT = 0;
  const DOS_TARIH = (0 << 9) | (1 << 5) | 1; // 1980-01-01 — içerik kimliği tarihten bağımsız kalsın

  const yerel = Buffer.alloc(30);
  yerel.writeUInt32LE(0x04034b50, 0);
  yerel.writeUInt16LE(20, 4); // açmak için gereken sürüm (2.0 = deflate)
  yerel.writeUInt16LE(0, 6); // bayraklar
  yerel.writeUInt16LE(8, 8); // yöntem: deflate
  yerel.writeUInt16LE(DOS_SAAT, 10);
  yerel.writeUInt16LE(DOS_TARIH, 12);
  yerel.writeUInt32LE(crc, 14);
  yerel.writeUInt32LE(cikanBayt, 18);
  yerel.writeUInt32LE(gcode.length, 22);
  yerel.writeUInt16LE(ad.length, 26);
  yerel.writeUInt16LE(0, 28);

  const merkez = Buffer.alloc(46);
  merkez.writeUInt32LE(0x02014b50, 0);
  merkez.writeUInt16LE(20, 4); // oluşturan sürüm
  merkez.writeUInt16LE(20, 6);
  merkez.writeUInt16LE(0, 8);
  merkez.writeUInt16LE(8, 10);
  merkez.writeUInt16LE(DOS_SAAT, 12);
  merkez.writeUInt16LE(DOS_TARIH, 14);
  merkez.writeUInt32LE(crc, 16);
  merkez.writeUInt32LE(cikanBayt, 20);
  merkez.writeUInt32LE(gcode.length, 24);
  merkez.writeUInt16LE(ad.length, 28);
  // 30: ek alan, 32: yorum, 34: disk, 36: iç öznitelik, 38: dış öznitelik — hepsi 0
  merkez.writeUInt32LE(0, 42); // yerel başlığın konumu

  const merkezKonum = yerel.length + ad.length + cikanBayt;
  const merkezBoy = merkez.length + ad.length;
  const son = Buffer.alloc(22);
  son.writeUInt32LE(0x06054b50, 0);
  son.writeUInt16LE(1, 8); // bu diskteki kayıt
  son.writeUInt16LE(1, 10); // toplam kayıt
  son.writeUInt32LE(merkezBoy, 12);
  son.writeUInt32LE(merkezKonum, 16);

  onPct?.(100);
  return Buffer.concat([yerel, ad, ...cikti, merkez, ad, son]);
}
