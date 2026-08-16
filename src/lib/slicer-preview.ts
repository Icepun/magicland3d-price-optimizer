import zlib from "node:zlib";

/**
 * SLICER'IN KENDİ ÖNİZLEMESİ — dosyanın içine gömülü hazır render.
 *
 * NEDEN: kendi çizimimiz baskı YOLLARINI (2 milyon çizgi parçası) çiziyor; slicer ise
 * dilimleme öncesi gerçek YÜZEYİ ışıklandırarak render ediyor. Yan yana ölçüldüğünde
 * (16 Ağu 2026) fark kapanamaz düzeydeydi: bizimki beyaz bir siluet, slicer'ınki kolları
 * ve vantuzları seçilen bir ahtapot. Kullanıcı kararı: hazır olanı kullanalım.
 *
 * İKİ BİÇİM VAR ve ikisi de gerekiyor (ölçüldü — 4 yazıcının 3'ü gcode, 1'i 3MF):
 *   • .gcode  → başlıkta `; thumbnail begin 800x800 …` blokları (Orca/PrusaSlicer)
 *   • .3mf    → zip içinde `Metadata/plate_*.png` (Bambu Studio)
 *
 * Dosyalar 140 MB'a çıkabildiği için TAMAMI asla okunmaz; gcode'da baş, 3MF'te zip dizini
 * (dosyanın sonu) + yalnız ilgili girdi okunur.
 */

export interface GomuluOnizleme {
  genislik: number;
  yukseklik: number;
  png: Buffer;
}

/** Bayt aralığı okuyucu — yerel dosya ya da R2 farkını çağıran çözer. */
export type AralikOkuyucu = (start: number, end: number) => Promise<Buffer>;

// ───────────────────────────── gcode ─────────────────────────────

/**
 * Gcode başlığındaki gömülü PNG'lerden EN BÜYÜĞÜ.
 * Gövde her satırın başında "; " ile yazılır; base64 birleştirilirken temizlenir.
 */
export function gcodeOnizlemesi(bas: string): GomuluOnizleme | null {
  const re =
    /; thumbnail(?:_JPG|_QOI)? begin (\d+)[ x](\d+) \d+\r?\n([\s\S]*?); thumbnail(?:_JPG|_QOI)? end/gi;
  let m: RegExpExecArray | null;
  let en: GomuluOnizleme | null = null;
  while ((m = re.exec(bas)) !== null) {
    const genislik = Number(m[1]);
    const yukseklik = Number(m[2]);
    const b64 = m[3].replace(/^;\s?/gm, "").replace(/\s+/g, "");
    if (!b64) continue;
    if (en && genislik * yukseklik <= en.genislik * en.yukseklik) continue;
    try {
      en = { genislik, yukseklik, png: Buffer.from(b64, "base64") };
    } catch {
      /* bozuk blok — atla */
    }
  }
  return en;
}

// ───────────────────────────── 3MF (zip) ─────────────────────────────

const EOCD_IMZA = 0x06054b50;
const MERKEZ_IMZA = 0x02014b50;

interface ZipGirdi {
  ad: string;
  yontem: number;
  sikisikBoyut: number;
  yerelOfset: number;
}

/** Zip'in sonundaki "end of central directory" kaydını bul (yorum alanı 64 KB'a kadar olabilir). */
function eocdBul(kuyruk: Buffer): { merkezOfset: number; merkezBoyut: number } | null {
  for (let i = kuyruk.length - 22; i >= 0; i--) {
    if (kuyruk.readUInt32LE(i) !== EOCD_IMZA) continue;
    return {
      merkezBoyut: kuyruk.readUInt32LE(i + 12),
      merkezOfset: kuyruk.readUInt32LE(i + 16),
    };
  }
  return null;
}

/** Merkezi dizini ayrıştır — yalnız ada, yönteme ve ofsete bakıyoruz. */
function merkeziAyristir(buf: Buffer): ZipGirdi[] {
  const girdiler: ZipGirdi[] = [];
  let p = 0;
  while (p + 46 <= buf.length && buf.readUInt32LE(p) === MERKEZ_IMZA) {
    const yontem = buf.readUInt16LE(p + 10);
    const sikisikBoyut = buf.readUInt32LE(p + 20);
    const adUz = buf.readUInt16LE(p + 28);
    const ekUz = buf.readUInt16LE(p + 30);
    const yorumUz = buf.readUInt16LE(p + 32);
    const yerelOfset = buf.readUInt32LE(p + 42);
    const ad = buf.subarray(p + 46, p + 46 + adUz).toString("utf8");
    girdiler.push({ ad, yontem, sikisikBoyut, yerelOfset });
    p += 46 + adUz + ekUz + yorumUz;
  }
  return girdiler;
}

/** PNG başlığından ölçü (IHDR sabit yerde). */
function pngOlcu(png: Buffer): { genislik: number; yukseklik: number } | null {
  if (png.length < 24 || png.subarray(1, 4).toString() !== "PNG") return null;
  return { genislik: png.readUInt32BE(16), yukseklik: png.readUInt32BE(20) };
}

/**
 * 3MF (zip) içindeki plaka önizlemesi.
 *
 * Dosyanın TAMAMI okunmaz: önce son 64 KB (zip dizini nerede), sonra dizin, sonra yalnız
 * ilgili girdi. 65 MB'lık bir 3MF'te bile birkaç yüz KB okunur.
 */
export async function zip3mfOnizlemesi(
  oku: AralikOkuyucu,
  toplamBoyut: number
): Promise<GomuluOnizleme | null> {
  if (toplamBoyut <= 0) return null;
  const kuyrukBoy = Math.min(65_536, toplamBoyut);
  const kuyruk = await oku(toplamBoyut - kuyrukBoy, toplamBoyut - 1);
  const eocd = eocdBul(kuyruk);
  if (!eocd || eocd.merkezBoyut <= 0) return null;

  const merkez = await oku(eocd.merkezOfset, eocd.merkezOfset + eocd.merkezBoyut - 1);
  const girdiler = merkeziAyristir(merkez);

  /**
   * Bambu birden çok plaka görseli koyabiliyor. Tercih sırası: küçük/no-light varyantlar
   * DEĞİL, asıl plaka render'ı. `plate_1.png` en yaygın; yoksa ilk uygun PNG.
   */
  const adaylar = girdiler.filter(
    (g) => /^metadata\/plate_\d+\.png$/i.test(g.ad) || /^metadata\/plate_\d+_small\.png$/i.test(g.ad)
  );
  const secilen =
    adaylar.find((g) => /^metadata\/plate_1\.png$/i.test(g.ad)) ??
    adaylar.find((g) => !/small/i.test(g.ad)) ??
    adaylar[0];
  if (!secilen) return null;

  // Yerel başlık değişken uzunlukta → başlığı okuyup gerçek veri başlangıcını bul.
  const yerelBas = await oku(secilen.yerelOfset, secilen.yerelOfset + 29);
  if (yerelBas.length < 30) return null;
  const adUz = yerelBas.readUInt16LE(26);
  const ekUz = yerelBas.readUInt16LE(28);
  const veriBas = secilen.yerelOfset + 30 + adUz + ekUz;
  const ham = await oku(veriBas, veriBas + secilen.sikisikBoyut - 1);

  let png: Buffer;
  if (secilen.yontem === 0) png = ham; // saklanmış
  else if (secilen.yontem === 8) png = zlib.inflateRawSync(ham); // deflate
  else return null;

  const olcu = pngOlcu(png);
  if (!olcu) return null;
  return { ...olcu, png };
}
