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
 *   • Resmi listeler (23 Kas 2026, ikisi de bu tabloyla kuruşu kuruşuna aynı): Trendyol panel → Kargo
 *     İşlemleri → Kargo Fiyatları & Desi → "Güncel Kargo Fiyatları" (PDF, 5 Ekim 2026); Hepsiburada
 *     images.hepsiburada.net/cst/assets/solutioncenterui/downloads/cargo.pdf (5 Ekim 2026).
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
 *
 * N11 (n11.com/kampanyalar/ozel-kargo-kampanyasi, "n11 Anlaşmalı Kargo Ücretleri", 26 Kas 2026):
 *   • Fiyatlar KDV ve %2,35 Posta Hizmet Bedeli HARİÇ → `ekBedelOrani` fiyata eklenir, KDV motorda.
 *   • Desi KÜMÜLATİF (paketin toplamı); DHL e-Commerce 50 desiye kadar tabloda, sonrası +35,16/desi
 *     (tablonun 100 desi fiyatı 3.054,25 bu artışla birebir).
 *   • ŞARTLI KARGO (kalemin `deliveryFeeType` = 3): sepet 300 TL altı ve ≤ 10 desi → firmaya göre
 *     SABİT ücret (0–149,99 / 149,99–299,99). Ücret satıcının hesabından düşülür (sayfa SSS).
 *   • `deliveryFeeType` 1 = alıcı öder, 4 = n11 öder → satıcıya kargo kesilmez.
 *   • İade kargosu da tablodaki fiyattan (sayfa SSS: "kampanya iade ürünler için de geçerli").
 */

export type KargoPlatformu = "trendyol" | "hepsiburada" | "n11";

/**
 * Kargoyu kim öder — n11 kargo şablonunun ödeme yöntemi (kalemin `deliveryFeeType`): 1 alıcı,
 * 2 mağaza, 3 şartlı kargo, 4 n11. Diğer pazaryerlerinde boş kalır (kargo hep satıcıda).
 */
export type KargoOdeyen = "alici" | "magaza" | "sartli" | "pazaryeri";

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
     * "sartli": barem yalnız kargo şablonu şartlı kargoysa (n11, `KargoBaglami.odeyen`).
     */
    kosul: "hizli" | "gun1" | "sartli";
    bantlar: BaremBandi[];
  };
  /** Desi listesi: dizinin i. elemanı i desinin fiyatı (0–30; n11'de 0–50). */
  desi: Partial<Record<FirmaKodu, readonly number[]>>;
  /** İade kargosu: "desi" = desi listesinden; "gidis" = gidişle aynı fiyat. */
  iade: "desi" | "gidis";
  /**
   * Fiyata eklenen oransal bedel (KDV hariç fiyat üzerinden) — n11'de Posta Hizmet Bedeli %2,35.
   * Barem ve desi fiyatının ikisine de eklenir; KDV bunun üstüne motorda hesaplanır.
   */
  ekBedelOrani?: number;
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
    // Aşağıdakiler Trendyol'un resmi listesinden ("Güncel Kargo Fiyatları", 5 Ekim 2026).
    dhl: [
      97.99, 97.99, 97.99, 110.99, 124.99, 137.99, 150.99, 159.99, 169.99, 179.99, 189.99, 199.99, 209.99, 219.99,
      229.99, 244.98, 264.99, 280.99, 299.99, 315.99, 334.99, 361.99, 383.99, 410.99, 437.99, 464.99, 491.99,
      518.99, 545.99, 572.99, 599.99,
    ],
    kolaygelsin: [
      96.59, 96.59, 96.59, 107.09, 118.64, 128.09, 138.59, 148.04, 158.54, 167.99, 179.54, 190.04, 201.59, 212.09,
      223.64, 235.19, 246.74, 258.29, 269.84, 281.39, 292.94, 304.49, 316.04, 327.59, 339.14, 350.69, 362.24,
      373.79, 385.34, 396.89, 408.44,
    ],
    ptt: [
      81.95, 81.95, 81.95, 100.0, 105.6, 110.61, 120.83, 129.17, 138.3, 150.0, 169.84, 178.21, 187.17, 196.16,
      205.14, 214.08, 223.04, 232.02, 240.98, 249.97, 258.94, 267.9, 276.87, 285.83, 294.79, 303.77, 312.75,
      321.71, 330.67, 339.64, 348.6,
    ],
    surat: [
      95.54, 95.54, 95.54, 106.45, 116.4, 122.41, 134.48, 143.61, 152.6, 161.73, 170.86, 182.99, 193.34, 201.11,
      206.02, 213.51, 220.73, 232.45, 244.17, 255.75, 267.46, 279.46, 290.36, 300.98, 311.75, 322.37, 332.73,
      343.09, 353.45, 363.79, 374.15,
    ],
    yurtici: [
      121.75, 121.75, 121.75, 132.56, 135.41, 157.16, 164.75, 186.34, 193.5, 205.5, 214.59, 228.48, 242.84,
      250.52, 270.13, 284.54, 292.69, 308.96, 324.29, 331.02, 338.15, 357.33, 368.35, 382.26, 389.91, 416.23,
      455.06, 476.59, 498.16, 515.42, 520.7,
    ],
  },
  iade: "desi",
  kontrol: "23 Kasım 2026",
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
  kontrol: "23 Kasım 2026",
};

const N11_2026_11: TarifeDonemi = {
  id: "n11-2026-11",
  platform: "n11",
  // Mağaza 26 Kas 2026'da açıldı; tablo o ayın fiyatı.
  baslangic: istanbul(2026, 11, 1),
  varsayilanFirma: "dhl",
  barem: {
    sinir: 300,
    desiSiniri: 10,
    kosul: "sartli",
    bantlar: [
      { ust: 149.99, standart: { ptt: 38.74, aras: 48.33, surat: 54.58, kolaygelsin: 55.83, dhl: 57.08, yurtici: 83.33 } },
      { ust: 299.99, standart: { ptt: 70.41, aras: 79.16, surat: 85.41, kolaygelsin: 86.66, dhl: 87.91, yurtici: 113.33 } },
    ],
  },
  desi: {
    // DHL e-Commerce, 0–50 desi (0 ve "dosya" 1 desiyle aynı). 50 üstü son adımla (+35,16) uzar.
    dhl: [
      99.16, 99.16, 99.16, 112.35, 126.03, 137.75, 151.43, 160.22, 170, 181.72, 191.49, 201.26, 212.01, 221.78,
      231.55, 246.2, 283.33, 297.01, 316.55, 341.95, 359.54, 373.22, 381.04, 408.39, 433.8, 460.18, 486.56,
      512.94, 539.32, 565.7, 593.05, 628.21, 663.37, 698.53, 733.69, 768.85, 804.01, 839.17, 874.33, 909.49,
      944.65, 979.81, 1014.97, 1050.13, 1085.29, 1120.45, 1155.61, 1190.77, 1225.93, 1261.09, 1296.25,
    ],
  },
  iade: "desi",
  ekBedelOrani: 0.0235,
  kontrol: "26 Kasım 2026",
};

/** Dönemler — eskiden yeniye. Yeni tarife: sona ekle, öncekine `bitis` ver. */
export const KARGO_TARIFELERI: Record<KargoPlatformu, readonly TarifeDonemi[]> = {
  trendyol: [TRENDYOL_2026_08],
  hepsiburada: [HEPSIBURADA_2026_08],
  n11: [N11_2026_11],
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
  /** n11: kargoyu kim öder (kargo şablonu). Alıcı ya da pazaryeri öderse satıcıya kargo kesilmez. */
  odeyen?: KargoOdeyen | null;
}

/** "alici" / "pazaryeri": kargo satıcıya kesilmedi (n11 şablonu alıcı ya da n11 öder). */
export type KargoFiyatTuru = "barem-avantajli" | "barem" | "desi" | "alici" | "pazaryeri";

export interface KargoTahmini {
  /** KDV HARİÇ TL. */
  fiyat: number;
  tur: KargoFiyatTuru;
  firma: FirmaKodu;
  /** Fiyatlandırılan desi (tam sayı, en az 1). */
  desi: number;
  donemId: string;
}

const PLATFORMLAR = new Set<string>(["trendyol", "hepsiburada", "n11"]);

/** Dönemin oransal ek bedeli (posta hizmet bedeli) eklenmiş fiyat — kuruşa yuvarlı. */
function ekBedelli(donem: TarifeDonemi, fiyat: number): number {
  const oran = donem.ekBedelOrani ?? 0;
  return oran > 0 ? Math.round(fiyat * (1 + oran) * 100) / 100 : fiyat;
}

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
    fiyat: ekBedelli(donem, desiListesiFiyati(liste, desi)),
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
  // Kargoyu alıcı ya da pazaryeri ödüyorsa (n11 şablonu) satıcıya kesilen kargo yok.
  if (baglam?.odeyen === "alici" || baglam?.odeyen === "pazaryeri") {
    return { fiyat: 0, tur: baglam.odeyen, firma, desi: d, donemId: donem.id };
  }
  const { barem } = donem;
  const baremde =
    tutar < barem.sinir &&
    (barem.desiSiniri == null || d <= barem.desiSiniri) &&
    (barem.kosul !== "gun1" ||
      (typeof baglam?.kargoyaVermeGunu === "number" && baglam.kargoyaVermeGunu <= 1)) &&
    (barem.kosul !== "sartli" || baglam?.odeyen === "sartli");
  if (baremde) {
    const bant = barem.bantlar.find((b) => tutar <= b.ust) ?? barem.bantlar[barem.bantlar.length - 1];
    const avantajli =
      barem.kosul === "hizli" && baglam?.hizliTeslimat === true && baglam?.gecKargolandi !== true;
    const fiyat = (avantajli ? bant.avantajli?.[firma] : undefined) ?? bant.standart[firma];
    if (typeof fiyat === "number") {
      return {
        fiyat: ekBedelli(donem, fiyat),
        tur: avantajli && bant.avantajli?.[firma] != null ? "barem-avantajli" : "barem",
        firma,
        desi: d,
        donemId: donem.id,
      };
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

/**
 * Kesilen kargo tutarından (KDV HARİÇ) hangi desiden fiyatlandığını bulur — firmanın desi listesinde
 * tam eşleşen EN KÜÇÜK desi (0–2 aynı fiyatsa 2 değil 1 döner). Barem fiyatı ya da listede olmayan
 * tutar → null (desi bilgisi taşımaz). Hepsiburada kesilen desiyi bildirmediği için gerekli.
 */
export function desiFiyatindanDesi(
  platform: string,
  firma: string | null | undefined,
  tarih: Date,
  fiyatKdvHaric: number
): number | null {
  const donem = tarifeDonemiBul(platform, tarih);
  if (!donem || !Number.isFinite(fiyatKdvHaric)) return null;
  const liste = donem.desi[firmaSec(donem, firma)] ?? donem.desi[donem.varsayilanFirma]!;
  for (let d = 1; d < liste.length; d++) {
    if (Math.abs(ekBedelli(donem, liste[d]) - fiyatKdvHaric) < 0.02) return d;
  }
  return null;
}

/** Bir tahminin kısa açıklaması (sipariş dökümü için, son kullanıcı dili). */
export function kargoTahminiEtiketi(t: Pick<KargoTahmini, "tur" | "firma" | "desi">): string {
  if (t.tur === "alici") return "Kargoyu alıcı ödüyor";
  if (t.tur === "pazaryeri") return "Kargoyu pazaryeri ödüyor";
  const firma = KARGO_FIRMA_ADLARI[t.firma];
  // Sabit fiyatlı baremde de paketin desisi yazar ("kaç desiden hesaplandı" her zaman görünsün).
  if (t.tur === "barem-avantajli") return `${firma} · hızlı teslimat fiyatı · ${t.desi} desi`;
  if (t.tur === "barem") return `${firma} · sabit fiyat · ${t.desi} desi`;
  return `${firma} · ${t.desi} desi`;
}
