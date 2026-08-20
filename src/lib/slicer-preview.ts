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
  /**
   * Satır sonu `[\r\n]+` — Cura'nın Elegoo eklentisi bloğu SALT-CR ile yazıyor ve `\r?\n`
   * beklersen o dosyalarda görsel hiç çıkmıyor (ölçüldü: 354 dosyanın 4'ü).
   * Ölçü ayracı hem `800x800` hem `32 32` biçiminde gelebiliyor.
   */
  const re =
    /; thumbnail(?:_JPG|_QOI)? begin (\d+)[ x](\d+) \d+[\r\n]+([\s\S]*?); thumbnail(?:_JPG|_QOI)? end/gi;
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

export interface ZipGirdi {
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
/**
 * Zip'in İÇİNDEKİLER LİSTESİ — dosyanın tamamı okunmadan.
 *
 * Önce son 64 KB (dizin nerede), sonra yalnız dizin okunur. 140 MB'lık bir dosyada bile
 * birkaç yüz KB. Adlar bilinince "içinde gcode var mı", "hangi plaka" gibi soruların yanıtı
 * hiçbir şey açılmadan verilebilir.
 */
export async function zipDizini(oku: AralikOkuyucu, toplamBoyut: number): Promise<ZipGirdi[] | null> {
  if (toplamBoyut <= 0) return null;
  const kuyrukBoy = Math.min(65_536, toplamBoyut);
  const kuyruk = await oku(toplamBoyut - kuyrukBoy, toplamBoyut - 1);
  const eocd = eocdBul(kuyruk);
  if (!eocd || eocd.merkezBoyut <= 0) return null;
  const merkez = await oku(eocd.merkezOfset, eocd.merkezOfset + eocd.merkezBoyut - 1);
  return merkeziAyristir(merkez);
}

/**
 * TEK bir zip girdisinin içeriği (yalnız o girdinin baytları okunur).
 *
 * `enFazlaCikti` verilirse akış hâlinde çözülür ve o kadar bayt üretilince kesilir — dev
 * gcode'un başlığını okumak için tamamını çözmek gerekmiyor.
 */
export async function zipGirdiVerisi(
  oku: AralikOkuyucu,
  g: ZipGirdi,
  enFazlaCikti?: number
): Promise<Buffer | null> {
  // Yerel başlık değişken uzunlukta → başlığı okuyup gerçek veri başlangıcını bul.
  const yerelBas = await oku(g.yerelOfset, g.yerelOfset + 29);
  if (yerelBas.length < 30) return null;
  const adUz = yerelBas.readUInt16LE(26);
  const ekUz = yerelBas.readUInt16LE(28);
  const veriBas = g.yerelOfset + 30 + adUz + ekUz;

  // Çıktı sınırı varsa, o kadarını üretecek kadar sıkışık bayt yeter (gcode ~5x sıkışır).
  const okunacak =
    enFazlaCikti != null
      ? Math.min(g.sikisikBoyut, Math.max(64 * 1024, Math.ceil(enFazlaCikti / 3)))
      : g.sikisikBoyut;
  const ham = await oku(veriBas, veriBas + okunacak - 1);

  if (g.yontem === 0) return enFazlaCikti != null ? ham.subarray(0, enFazlaCikti) : ham;
  if (g.yontem !== 8) return null;
  if (enFazlaCikti == null) return zlib.inflateRawSync(ham);

  // Kısmi veri: akış çözücü sonunu göremeyince hata verir, elde ettiğimiz kadarı işimizi görür.
  return await new Promise<Buffer | null>((coz) => {
    const parcalar: Buffer[] = [];
    let uzunluk = 0;
    let bitti = false;
    const akis = zlib.createInflateRaw();
    const kapat = () => {
      if (bitti) return;
      bitti = true;
      try { akis.destroy(); } catch { /* zaten kapalı */ }
      coz(parcalar.length ? Buffer.concat(parcalar).subarray(0, enFazlaCikti) : null);
    };
    akis.on("data", (p: Buffer) => {
      parcalar.push(p);
      uzunluk += p.length;
      if (uzunluk >= enFazlaCikti) kapat();
    });
    akis.on("end", kapat);
    akis.on("error", kapat); // kırpılmış akışta beklenen
    akis.end(ham);
  });
}

export async function zip3mfOnizlemesi(
  oku: AralikOkuyucu,
  toplamBoyut: number
): Promise<GomuluOnizleme | null> {
  const girdiler = await zipDizini(oku, toplamBoyut);
  if (!girdiler) return null;

  /**
   * HANGİ PLAKA? Dosyada projedeki BÜTÜN plakaların görseli duruyor, ama basılacak gcode
   * yalnız BİRİNDEN var. Körü körüne `plate_1.png` seçmek, gerçek dosyalarda 157 baskının
   * 21'inde (ölçüldü, 16 Ağu 2026) BAŞKA BİR PARÇANIN resmini gösteriyordu — örneğin
   * "Delorean Arka Tampon" plate_5'i basarken kartta plate_1 görünüyordu.
   * Doğru sıra: önce gcode hangi plakaya aitse onun görselini ara.
   */
  const plakaNo = girdiler
    .map((g) => /^metadata\/plate_(\d+)\.gcode$/i.exec(g.ad)?.[1])
    .find((x): x is string => !!x);

  const adaylar = girdiler.filter((g) => /^metadata\/plate_\d+(_small)?\.png$/i.test(g.ad));
  const tam = (no: string) => new RegExp(`^metadata/plate_${no}\\.png$`, "i");
  const secilen =
    (plakaNo ? adaylar.find((g) => tam(plakaNo).test(g.ad)) : undefined) ??
    adaylar.find((g) => /^metadata\/plate_1\.png$/i.test(g.ad)) ??
    adaylar.find((g) => !/small/i.test(g.ad)) ??
    adaylar[0];
  if (!secilen) return null;

  const png = await zipGirdiVerisi(oku, secilen);
  if (!png) return null;

  const olcu = pngOlcu(png);
  if (!olcu) return null;
  return { ...olcu, png };
}
