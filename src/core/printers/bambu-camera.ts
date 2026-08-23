/**
 * BAMBU KAMERA (A1 / P1) — yazıcının 6000 portundaki JPEG akışı.
 *
 * Bambu'nun kamerası HTTP değil: cihaz 6000 portunda TLS dinliyor, bağlanınca 80 baytlık bir
 * kimlik paketi bekliyor, sonra kareleri 16 baytlık başlık + JPEG gövdesi olarak akıtıyor.
 * (Ölçüldü 21 Ağu 2026: A1 Combo'da 6000 açık, 3000 de açık — kamera 6000'de.)
 *
 * Paket düzeni:
 *   Kimlik (80 bayt): [gövde boyu=0x40][tip=0x30][0][0][kullanıcı 32B][erişim kodu 32B]
 *   Kare başlığı (16 bayt): [gövde boyu uint32 LE][12 bayt kullanılmıyor] ardından JPEG
 *
 * ⚠️ AKIŞ YALNIZ İZLENİRKEN AÇIK KALIR. Bugün öğrendiğimiz ders: yazıcıya gereksiz yük
 * bindirmek onu ağdan düşürebiliyor. Bu yüzden bağlantı kamera penceresi kapanır kapanmaz
 * kapatılır (`durdur`), arka planda çalışmaya devam etmez.
 */
import tls from "node:tls";

const KIMLIK_UZUNLUK = 80;
const BASLIK_UZUNLUK = 16;
/** Tek kare için makul üst sınır — bozuk başlık okursak belleği doldurmayalım. */
const AZAMI_KARE = 8 * 1024 * 1024;
const KULLANICI = "bblp";

/** 80 baytlık kimlik paketi. */
export function kimlikPaketi(accessCode: string): Buffer {
  const p = Buffer.alloc(KIMLIK_UZUNLUK, 0);
  p.writeUInt32LE(0x40, 0); // gövde boyu
  p.writeUInt32LE(0x3000, 4); // tip
  p.writeUInt32LE(0, 8);
  p.writeUInt32LE(0, 12);
  p.write(KULLANICI, 16, 32, "ascii");
  p.write(accessCode, 48, 32, "ascii");
  return p;
}

/**
 * Gelen baytlardan tam kareleri ayıkla.
 *
 * Akış parça parça geliyor; bir kare iki TCP paketine bölünebilir ya da bir pakette iki kare
 * gelebilir. Bu yüzden ayrıştırıcı durumsuz değil: elde kalan artığı geri döndürür.
 */
export function kareleriAyikla(tampon: Buffer): { kareler: Buffer[]; kalan: Buffer } {
  /** `subarray` görünüm döndürüyor; tip olarak da tam bir Buffer istiyoruz. */
  const kes = (a: number, b?: number): Buffer => Buffer.from(tampon.subarray(a, b));
  const kareler: Buffer[] = [];
  let o = 0;
  for (;;) {
    if (tampon.length - o < BASLIK_UZUNLUK) break;
    const boy = tampon.readUInt32LE(o);
    // Bozuk başlık: akışı baştan toplamak yerine tamponu at (yeniden bağlanma karar verir).
    if (boy <= 0 || boy > AZAMI_KARE) return { kareler, kalan: Buffer.alloc(0) };
    if (tampon.length - o < BASLIK_UZUNLUK + boy) break;
    kareler.push(kes(o + BASLIK_UZUNLUK, o + BASLIK_UZUNLUK + boy));
    o += BASLIK_UZUNLUK + boy;
  }
  return { kareler, kalan: kes(o) };
}

/** JPEG imzası — yanlış çözümlemeyi sessizce yayınlamayalım. */
export function jpegMi(b: Buffer): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;
}

export interface KameraAkisi {
  durdur: () => void;
}

/**
 * Kamera akışını başlat. Her tam karede `onKare` çağrılır; bağlantı düşerse `onHata`.
 * Dönen nesnedeki `durdur()` bağlantıyı kapatır — çağrılmazsa yazıcı boşuna meşgul kalır.
 */
export function bambuKameraAkisi(
  host: string,
  accessCode: string,
  onKare: (jpeg: Buffer) => void,
  onHata: (mesaj: string) => void,
): KameraAkisi {
  let tampon: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let kapandi = false;

  const soket = tls.connect(
    {
      host,
      port: 6000,
      // Yazıcının sertifikası kendinden imzalı; LAN'da cihazın kendisine bağlanıyoruz.
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
    },
    () => {
      try {
        soket.write(kimlikPaketi(accessCode));
      } catch {
        bitir("Kameraya bağlanılamadı.");
      }
    },
  );

  const bitir = (mesaj: string) => {
    if (kapandi) return;
    kapandi = true;
    try { soket.destroy(); } catch { /* zaten kapalı */ }
    onHata(mesaj);
  };

  soket.setTimeout(15_000, () => bitir("Kameradan görüntü gelmiyor."));

  soket.on("data", (parca: Buffer) => {
    tampon = tampon.length ? Buffer.concat([tampon, parca]) : parca;
    const { kareler, kalan } = kareleriAyikla(tampon);
    tampon = kalan;
    for (const k of kareler) if (jpegMi(k)) onKare(k);
  });

  soket.on("error", () => bitir("Kamera bağlantısı koptu."));
  soket.on("close", () => bitir("Kamera bağlantısı kapandı."));

  return {
    durdur: () => {
      kapandi = true; // hata geri çağrısı tetiklenmesin: bu bilinçli bir kapatma
      try { soket.destroy(); } catch { /* zaten kapalı */ }
    },
  };
}
