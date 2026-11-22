/**
 * PAZARYERİ KARGO TARİFELERİ — Trendyol ve Hepsiburada'nın satıcıya kestiği kargo bedelleri.
 *
 * Bu tablo kullanıcı tarafından DÜZENLENMEZ (Berke'nin kararı, 22 Kas 2026): fiyatlar pazaryerinin
 * kendi listesidir, Kargo sayfasında yalnız gösterilir. Tarife değişince bu dosyaya YENİ DÖNEM
 * eklenir (eskisi silinmez, `bitis` ile kapanır) — sipariş kendi tarihinin fiyatını kullanır.
 * Shopify kargo kuralları ayrı ve düzenlenebilir kalır (`CargoRule` tablosu).
 *
 * Tüm fiyatlar KDV HARİÇ TL. Kaynaklar ve ölçümler (22 Kas 2026):
 *
 * TRENDYOL (Satıcı Bilgi Merkezi "Kargo Baremi Uygulaması" + panel "Kargo Fiyatı Hesapla"):
 *   • Sipariş tutarı 350 TL altı ve desi ≤ 10 → firmaya göre SABİT barem fiyatı (0–199,99 / 200–349,99).
 *   • AVANTAJLI tablo (Tablo 1) yalnız siparişte hızlı teslimat işareti (FastDelivery / SameDayShipping)
 *     VARSA ve sipariş zamanında kargoya verildiyse. Ölçüldü: 10/10 hızlı + zamanında → avantajlı;
 *     hızlı ama geç kalan 1 sipariş → standart; hızlı işareti olmayan 76 sipariş → standart.
 *     Hızlı işaretli siparişlerin hepsi ~1 günlük terminli → ürün ekranında termin 1 gün = avantajlı.
 *   • 350 TL ve üstü ya da 10 desi üstü → firmanın desi listesi (panelden okundu; faturalarla birebir:
 *     81,95 / 100,20 / 107,20 / 114,10 / 133,41 / 142,32 / 150,64 / 164,18 / 173,42 / 182,20 / 206,03 / 213,82).
 *   • İADE kargosu baremden değil DESİ listesinden kesiliyor (11 iade faturası: ≤2 desi 81,95,
 *     4 desi 107,20; dönüşü Aras taşıyınca Aras fiyatı 109,90 / 173,09).
 *
 * HEPSİBURADA (Hepsiburada tarifesi; muhasebe kayıtlarıyla doğrulandı — 257 sipariş):
 *   • hepsiJET / Sürat ile, kargoya verme süresi ≤ 1 gün olan siparişte: müşterinin ödediği tutar
 *     200 TL altı → 43,99; 200–399,99 → 75,99 (38/38 ve 57/61 birebir).
 *   • Kargoya verme süresi 2+ gün ya da tutar ≥ 400 → firmanın desi listesi (81,99 / 107,99 / 115,99 /
 *     133,99 / 141,99 / 149,99 / 159,99 / 174,99 faturalarla birebir; Aras 89,92, DHL 100,99 de).
 *   • 24 Ağustos 2026 öncesi farklıydı (72 TL barem, 78,50 desi) → o tarihten eski siparişler
 *     eski kurallara (CargoRule) düşer.
 *   • İADE: dönüş bacağı gidişle aynı fiyattan kesiliyor (43,99+43,99 · 81,99+81,99).
 */

export type KargoPlatformu = "trendyol" | "hepsiburada";

export type FirmaKodu =
  | "tex"
  | "hepsijet"
  | "aras"
  | "dhl"
  | "kolaygelsin"
  | "ptt"
  | "surat"
  | "yurtici";

export const KARGO_FIRMA_ADLARI: Record<FirmaKodu, string> = {
  tex: "Trendyol Express",
  hepsijet: "hepsiJET",
  aras: "Aras Kargo",
  dhl: "DHL eCommerce",
  kolaygelsin: "Kolay Gelsin",
  ptt: "PTT Kargo",
  surat: "Sürat Kargo",
  yurtici: "Yurtiçi Kargo",
};

/** Barem bandı — `ust` dahil üst sınır (TL). Fiyatlar firmaya göre. */
export interface BaremBandi {
  ust: number;
  /** Avantajlı fiyat (yalnız Trendyol). */
  avantajli?: Partial<Record<FirmaKodu, number>>;
  standart: Partial<Record<FirmaKodu, number>>;
}

export interface TarifeDonemi {
  id: string;
  platform: KargoPlatformu;
  /** Dönemin ilk anı (dahil). */
  baslangic: Date;
  /** Dönemin son anı (dahil); yoksa hâlâ geçerli. */
  bitis?: Date;
  /** Sipariş firması bilinmiyorsa ya da tabloda yoksa kullanılan firma. */
  varsayilanFirma: FirmaKodu;
  barem: {
    /** Bu tutarın ALTINDAKİ siparişler barem kapsamında (TL). */
    sinir: number;
    /** Bu desinin ÜSTÜ barem dışı (yoksa sınır yok). */
    desiSiniri?: number;
    /**
     * "hizli": avantajlı fiyat hızlı teslimat + zamanında gönderimde (Trendyol).
     * "gun1": barem yalnız kargoya verme süresi ≤ 1 günse (Hepsiburada).
     */
    kosul: "hizli" | "gun1";
    bantlar: BaremBandi[];
  };
  /** Desi listesi: dizinin i. elemanı i desinin fiyatı (0–30). */
  desi: Partial<Record<FirmaKodu, readonly number[]>>;
  /** İade kargosu: "desi" = desi listesinden; "gidis" = gidişle aynı fiyat. */
  iade: "desi" | "gidis";
  /** Fiyatların en son kontrol edildiği gün (gösterim için). */
  kontrol: string;
}

/** İstanbul gece yarısı (UTC+3) → Date. */
const istanbul = (yil: number, ay: number, gun: number) => new Date(Date.UTC(yil, ay - 1, gun - 1, 21, 0, 0));

const TRENDYOL_2026_08: TarifeDonemi = {
  id: "trendyol-2026-08",
  platform: "trendyol",
  // CargoRule'daki mevcut Trendyol tarifesi de bu günden başlıyordu — öncesi oraya düşer.
  baslangic: istanbul(2026, 7, 31),
  varsayilanFirma: "tex",
  barem: {
    sinir: 350,
    desiSiniri: 10,
    kosul: "hizli",
    bantlar: [
      {
        ust: 199.99,
        avantajli: { aras: 48.33, dhl: 57.08, kolaygelsin: 55.83, ptt: 38.74, surat: 54.58, tex: 38.74, yurtici: 83.33 },
        standart: { aras: 80.83, dhl: 89.58, kolaygelsin: 88.33, ptt: 73.33, surat: 87.08, tex: 73.33, yurtici: 114.16 },
      },
      {
        ust: 349.99,
        avantajli: { aras: 79.16, dhl: 87.91, kolaygelsin: 86.66, ptt: 70.41, surat: 85.41, tex: 70.41, yurtici: 113.33 },
        standart: { aras: 86.24, dhl: 94.99, kolaygelsin: 93.74, ptt: 78.74, surat: 92.49, tex: 78.74, yurtici: 119.16 },
      },
    ],
  },
  desi: {
    tex: [
      81.95, 81.95, 81.95, 100.2, 107.2, 114.1, 125.6, 133.41, 142.32, 150.64, 164.18, 173.42, 182.2, 190.46,
      198.1, 206.03, 213.82, 224.32, 233.82, 243.28, 252.77, 263.34, 272.61, 283.24, 293.35, 303.36, 315.98,
      327.76, 338.64, 350.65, 360.55,
    ],
    aras: [
      88.96, 88.96, 88.96, 100.84, 109.9, 117.85, 128.39, 136.17, 145.27, 153.6, 164.23, 173.09, 179.47, 187.61,
      194.84, 202.03, 213.36, 224.62, 235.95, 247.24, 252.09, 264.8, 276.4, 287.97, 298.26, 308.5, 322.85,
      335.94, 347.66, 361.09, 371.34,
    ],
  },
  iade: "desi",
  kontrol: "22 Kasım 2026",
};

const HEPSIBURADA_2026_08: TarifeDonemi = {
  id: "hepsiburada-2026-08",
  platform: "hepsiburada",
  baslangic: istanbul(2026, 8, 24),
  varsayilanFirma: "hepsijet",
  barem: {
    sinir: 400,
    kosul: "gun1",
    bantlar: [
      { ust: 199.99, standart: { hepsijet: 43.99, surat: 43.99 } },
      { ust: 399.99, standart: { hepsijet: 75.99, surat: 75.99 } },
    ],
  },
  desi: {
    hepsijet: [
      81.99, 81.99, 81.99, 99.99, 107.99, 115.99, 124.99, 133.99, 141.99, 149.99, 159.99, 166.99, 174.99, 189.99,
      194.99, 201.99, 212.99, 223.99, 235.99, 253.99, 260.99, 270.99, 285.99, 295.99, 305.99, 311.99, 325.99,
      337.99, 348.99, 361.99, 372.99,
    ],
    aras: [
      89.92, 89.92, 92.34, 100.55, 108.91, 116.23, 126.37, 133.77, 142.47, 150.41, 160.62, 168.79, 174.5, 181.9,
      188.46, 195.02, 205.21, 215.36, 225.55, 235.74, 239.78, 251.52, 262.21, 272.95, 282.38, 291.78, 305.2,
      317.41, 328.36, 340.86, 350.4,
    ],
    ptt: [
      93.95, 93.95, 93.95, 115.09, 115.09, 119.79, 126.83, 133.87, 147.97, 162.07, 183.21, 192.6, 201.99, 211.39,
      220.78, 230.18, 239.58, 248.97, 258.37, 267.76, 277.16, 286.55, 293.6, 303.0, 312.39, 321.78, 331.18,
      340.57, 349.97, 359.36, 368.75,
    ],
    surat: [
      97.55, 97.55, 97.55, 110.05, 120.0, 125.99, 138.57, 147.83, 157.24, 166.64, 175.9, 187.76, 195.66, 203.56,
      211.47, 219.23, 227.41, 239.4, 251.39, 263.51, 275.5, 287.9, 298.94, 309.98, 321.01, 332.05, 342.68,
      353.44, 364.07, 374.7, 385.32,
    ],
    kolaygelsin: [
      100.91, 100.91, 100.91, 111.65, 123.47, 133.15, 143.89, 153.57, 164.31, 173.98, 185.81, 196.55, 208.37,
      219.12, 230.94, 242.76, 254.58, 266.41, 278.23, 290.05, 301.87, 313.69, 325.51, 337.34, 349.16, 360.98,
      372.8, 384.62, 396.44, 408.26, 420.08,
    ],
    dhl: [
      100.99, 100.99, 100.99, 110.99, 126.99, 137.99, 153.99, 162.99, 172.99, 182.99, 192.99, 203.99, 214.99,
      224.99, 234.99, 249.99, 286.99, 301.99, 321.99, 346.99, 364.99, 378.99, 386.99, 413.99, 440.99, 467.99,
      494.99, 521.99, 548.99, 575.99, 602.99,
    ],
    yurtici: [
      135.08, 135.08, 138.51, 147.26, 150.21, 167.73, 173.59, 196.04, 204.4, 216.55, 226.24, 248.21, 264.79,
      275.08, 296.52, 315.03, 323.77, 342.31, 355.04, 365.26, 376.53, 395.06, 413.6, 421.33, 431.17, 464.25,
      513.54, 532.06, 546.72, 552.55, 573.05,
    ],
  },
  iade: "gidis",
  kontrol: "22 Kasım 2026",
};

/** Dönemler — eskiden yeniye. Yeni tarife: sona ekle, öncekine `bitis` ver. */
export const KARGO_TARIFELERI: Record<KargoPlatformu, readonly TarifeDonemi[]> = {
  trendyol: [TRENDYOL_2026_08],
  hepsiburada: [HEPSIBURADA_2026_08],
};

/** Siparişin kargo bilgileri — pazaryeri siparişinden okunur. Hepsi isteğe bağlı. */
export interface KargoBaglami {
  /** Kargo firmasının adı (pazaryerinin verdiği gibi); boşsa platformun varsayılanı. */
  firma?: string | null;
  /** Trendyol: siparişte hızlı teslimat işareti var mı. */
  hizliTeslimat?: boolean | null;
  /** Trendyol: sipariş söz verilen tarihten SONRA mı kargoya verildi (bilinmiyorsa null). */
  gecKargolandi?: boolean | null;
  /** Hepsiburada: kalemlerin en uzun kargoya verme süresi (gün); bilinmiyorsa null. */
  kargoyaVermeGunu?: number | null;
  /** Barem bandına bakılacak tutar; verilmezse sipariş toplamı. (Hepsiburada: müşterinin ödediği.) */
  baremTutari?: number | null;
}

export type KargoFiyatTuru = "barem-avantajli" | "barem" | "desi";

export interface KargoTahmini {
  /** KDV HARİÇ TL. */
  fiyat: number;
  tur: KargoFiyatTuru;
  firma: FirmaKodu;
  /** Fiyatlandırılan desi (tam sayı, en az 1). */
  desi: number;
  donemId: string;
}

const PLATFORMLAR = new Set<string>(["trendyol", "hepsiburada"]);

/** Pazaryerinin verdiği firma adı → firma kodu; tanınmazsa null. */
export function kargoFirmasiKodu(ad: string | null | undefined): FirmaKodu | null {
  const s = (ad ?? "").toLocaleLowerCase("tr-TR");
  if (!s.trim()) return null;
  if (/hepsi\s*jet\s*xl/.test(s)) return null;
  if (/trendyol\s*express|^tex\b/.test(s)) return "tex";
  if (/hepsi\s*jet/.test(s)) return "hepsijet";
  if (/aras/.test(s)) return "aras";
  if (/dhl/.test(s)) return "dhl";
  if (/kolay\s*gelsin/.test(s)) return "kolaygelsin";
  if (/ptt/.test(s)) return "ptt";
  if (/s[üu]rat/.test(s)) return "surat";
  if (/yurt\s*i[çc]i/.test(s)) return "yurtici";
  return null;
}

/** Platformun o tarihte geçerli tarife dönemi; yoksa null (eski kurallar geçerli). */
export function tarifeDonemiBul(platform: string, tarih: Date): TarifeDonemi | null {
  if (!PLATFORMLAR.has(platform)) return null;
  const t = tarih.getTime();
  if (!Number.isFinite(t)) return null;
  const donemler = KARGO_TARIFELERI[platform as KargoPlatformu];
  for (let i = donemler.length - 1; i >= 0; i--) {
    const d = donemler[i];
    if (t >= d.baslangic.getTime() && (!d.bitis || t <= d.bitis.getTime())) return d;
  }
  return null;
}

/** Fiyatlandırılan desi: en yakın tam sayı, en az 1 (sipariş kârının barem desisiyle aynı kural). */
export function fiyatDesisi(desi: number): number {
  return Math.max(1, Math.round(Number.isFinite(desi) && desi > 0 ? desi : 1));
}

/** Desi listesinden fiyat; liste sonundan büyük desi son adımın artışıyla uzatılır. */
export function desiListesiFiyati(liste: readonly number[], desi: number): number {
  const d = fiyatDesisi(desi);
  const son = liste.length - 1;
  if (d <= son) return liste[d];
  const adim = liste[son] - liste[son - 1];
  return Math.round((liste[son] + (d - son) * adim) * 100) / 100;
}

/** Siparişin firması; tanınmazsa dönemin varsayılan firması. */
function firmaSec(donem: TarifeDonemi, ad: string | null | undefined): FirmaKodu {
  return kargoFirmasiKodu(ad) ?? donem.varsayilanFirma;
}

/** Firmanın desi listesi; listesi bilinmeyen firma varsayılan firmanın listesiyle fiyatlanır. */
function desiTahmini(donem: TarifeDonemi, firma: FirmaKodu, desi: number): KargoTahmini {
  const kendi = donem.desi[firma];
  const liste = kendi ?? donem.desi[donem.varsayilanFirma]!;
  return {
    fiyat: desiListesiFiyati(liste, desi),
    tur: "desi",
    firma: kendi ? firma : donem.varsayilanFirma,
    desi: fiyatDesisi(desi),
    donemId: donem.id,
  };
}

/**
 * Siparişin GİDİŞ kargosu (KDV hariç). Platformun o tarihte tarifesi yoksa null — çağıran eski
 * kurallara düşer. `siparisTutari` müşterinin ödediği sipariş toplamı; `desi` paketin toplam desisi.
 */
export function kargoTahmini(
  platform: string,
  siparisTutari: number,
  desi: number,
  tarih: Date,
  baglam?: KargoBaglami | null
): KargoTahmini | null {
  const donem = tarifeDonemiBul(platform, tarih);
  if (!donem) return null;
  const firma = firmaSec(donem, baglam?.firma);
  const tutarHam = baglam?.baremTutari ?? siparisTutari;
  const tutar = Number.isFinite(tutarHam) ? Math.max(0, tutarHam as number) : 0;
  const d = fiyatDesisi(desi);
  const { barem } = donem;
  const baremde =
    tutar < barem.sinir &&
    (barem.desiSiniri == null || d <= barem.desiSiniri) &&
    (barem.kosul !== "gun1" ||
      (typeof baglam?.kargoyaVermeGunu === "number" && baglam.kargoyaVermeGunu <= 1));
  if (baremde) {
    const bant = barem.bantlar.find((b) => tutar <= b.ust) ?? barem.bantlar[barem.bantlar.length - 1];
    const avantajli =
      barem.kosul === "hizli" && baglam?.hizliTeslimat === true && baglam?.gecKargolandi !== true;
    const fiyat = (avantajli ? bant.avantajli?.[firma] : undefined) ?? bant.standart[firma];
    if (typeof fiyat === "number") {
      return { fiyat, tur: avantajli && bant.avantajli?.[firma] != null ? "barem-avantajli" : "barem", firma, desi: d, donemId: donem.id };
    }
    // Firma barem kapsamında değil → desi listesi.
  }
  return desiTahmini(donem, firma, d);
}

/**
 * İADE edilen siparişin DÖNÜŞ kargosu (KDV hariç). Trendyol desi listesinden keser; Hepsiburada
 * gidişle aynı fiyattan. Tarife yoksa null.
 */
export function iadeKargoTahmini(
  platform: string,
  siparisTutari: number,
  desi: number,
  tarih: Date,
  baglam?: KargoBaglami | null
): KargoTahmini | null {
  const donem = tarifeDonemiBul(platform, tarih);
  if (!donem) return null;
  if (donem.iade === "gidis") return kargoTahmini(platform, siparisTutari, desi, tarih, baglam);
  return desiTahmini(donem, firmaSec(donem, baglam?.firma), desi);
}

/** Bir tahminin kısa açıklaması (sipariş dökümü için, son kullanıcı dili). */
export function kargoTahminiEtiketi(t: Pick<KargoTahmini, "tur" | "firma" | "desi">): string {
  const firma = KARGO_FIRMA_ADLARI[t.firma];
  if (t.tur === "barem-avantajli") return `${firma} · hızlı teslimat fiyatı`;
  if (t.tur === "barem") return `${firma} · sabit fiyat`;
  return `${firma} · ${t.desi} desi`;
}
