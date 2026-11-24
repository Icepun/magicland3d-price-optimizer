/**
 * KARGO GÖNDERİSİ — uygulamadan açılan HepsiJet gönderisinin durumu. Saf; masaüstü ve telefon aynı
 * kuralı kullanır (telefon `CargoShipment` tablosunu doğrudan okur).
 *
 * HepsiJet takip servisi (`/deliveryTransaction/getDeliveryTracking`, test ortamında 24 Kas 2026
 * ölçüldü):
 *  • Kurye henüz almadıysa gönderi yanıtta HİÇ yer almaz ("yalnız status OK").
 *  • Alınan / randevulu gönderide `deliveryStatus` (WAITING_FOR_DISPATCH, ACCEPTED, DELIVERING,
 *    DELIVERED, UNDELIVERED …), `operationStatus` (IN_CUSTOMER = hâlâ gönderende), Türkçe
 *    `lastTransaction` ve `transactions[]` geçmişi döner.
 * Dokümanın saymadığı kodlar da gelebilir → tanınmayan kod "yolda" sayılır ama ekranda HepsiJet'in
 * kendi Türkçe metni gösterilir; yanlış bir sözcük uydurulmaz.
 */

export type KargoDurumu = "olusturuldu" | "yolda" | "dagitimda" | "teslim" | "sorun" | "iade" | "iptal";

export const KARGO_DURUM_ETIKETI: Record<KargoDurumu, string> = {
  olusturuldu: "Kurye bekleniyor",
  yolda: "Yolda",
  dagitimda: "Dağıtımda",
  teslim: "Teslim edildi",
  sorun: "Teslim edilemedi",
  iade: "İade dönüyor",
  iptal: "İptal edildi",
};

/** Bu durumlardan sonra takip edilmez. */
export const KARGO_SON_DURUMLAR: readonly KargoDurumu[] = ["teslim", "iptal"];

export function kargoSonDurumMu(d: string | null | undefined): boolean {
  return KARGO_SON_DURUMLAR.includes(d as KargoDurumu);
}

/** Kurye paketi aldı mı (Shopify'da "gönderildi" işareti bu andan sonra konur). */
export function kuryeAldiMi(d: string | null | undefined): boolean {
  return d === "yolda" || d === "dagitimda" || d === "teslim" || d === "sorun" || d === "iade";
}

export interface KargoOlayi {
  /** Epoch ms. */
  an: number;
  metin: string;
  durum: string | null;
}

export interface CozulenTakip {
  barkod: string;
  durum: KargoDurumu;
  /** HepsiJet'in son hareket metni (Türkçe); yoksa durum etiketi. */
  metin: string;
  /** HepsiJet'in ham `deliveryStatus` kodu. */
  ham: string | null;
  /** Son hareketin anı (epoch ms); yoksa null. */
  sonOlayAni: number | null;
  olaylar: KargoOlayi[];
}

const metinMi = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

function anOku(v: unknown): number | null {
  if (!metinMi(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** HepsiJet durum kodlarını uygulamanın durumuna çevirir. */
export function hepsijetDurumu(deliveryStatus: unknown, operationStatus?: unknown): KargoDurumu {
  const d = metinMi(deliveryStatus) ? deliveryStatus.trim().toUpperCase() : "";
  const o = metinMi(operationStatus) ? operationStatus.trim().toUpperCase() : "";
  if (d === "DELIVERED") return "teslim";
  if (/DELET|CANCEL|SILIN/.test(d)) return "iptal";
  if (d === "DELIVERING" || d === "OUT_FOR_DELIVERY") return "dagitimda";
  if (/RETURN/.test(d)) return "iade";
  if (/UNDELIVER|LOST|DAMAGE|MISSING/.test(d)) return "sorun";
  if (d === "WAITING_FOR_DISPATCH" || d === "CREATED" || d === "") {
    // Kurye almadıysa paket hâlâ bizde ("IN_CUSTOMER"). Kod boşken de böyle say.
    return !o || o === "IN_CUSTOMER" ? "olusturuldu" : "yolda";
  }
  return "yolda";
}

/**
 * Takip yanıtını gönderi başına çözer. Yanıtta olmayan barkod = kurye henüz almadı (sonuçta yok;
 * çağıran "olusturuldu" bırakır).
 */
export function hepsijetTakipCoz(govde: unknown): Map<string, CozulenTakip> {
  const sonuc = new Map<string, CozulenTakip>();
  const veri = (govde as { data?: unknown } | null)?.data;
  if (!Array.isArray(veri)) return sonuc;
  for (const ham of veri) {
    if (!ham || typeof ham !== "object") continue;
    const k = ham as Record<string, unknown>;
    const barkod = metinMi(k.customerDeliveryNo) ? k.customerDeliveryNo.trim() : metinMi(k.barcode) ? k.barcode.trim() : null;
    if (!barkod) continue;
    const olaylar: KargoOlayi[] = (Array.isArray(k.transactions) ? k.transactions : [])
      .map((t): KargoOlayi | null => {
        if (!t || typeof t !== "object") return null;
        const x = t as Record<string, unknown>;
        const an = anOku(x.transactionDateTime);
        const metin = metinMi(x.transaction) ? x.transaction.trim() : null;
        if (an == null || !metin) return null;
        return { an, metin, durum: metinMi(x.deliveryStatus) ? x.deliveryStatus.trim() : null };
      })
      .filter((x): x is KargoOlayi => x != null)
      .sort((a, b) => a.an - b.an);
    const durum = hepsijetDurumu(k.deliveryStatus, k.operationStatus);
    const son = olaylar.at(-1);
    sonuc.set(barkod, {
      barkod,
      durum,
      metin: metinMi(k.lastTransaction) ? k.lastTransaction.trim() : son?.metin ?? KARGO_DURUM_ETIKETI[durum],
      ham: metinMi(k.deliveryStatus) ? k.deliveryStatus.trim() : null,
      sonOlayAni: son?.an ?? null,
      olaylar,
    });
  }
  return sonuc;
}

/** Kayıtlı olay listesini (JSON) güvenle oku. */
export function kargoOlaylariOku(ham: string | null | undefined): KargoOlayi[] {
  if (!ham) return [];
  try {
    const j = JSON.parse(ham) as unknown;
    if (!Array.isArray(j)) return [];
    return j
      .filter((x): x is KargoOlayi => Boolean(x) && typeof x === "object" && typeof (x as KargoOlayi).an === "number" && metinMi((x as KargoOlayi).metin))
      .map((x) => ({ an: x.an, metin: x.metin, durum: typeof x.durum === "string" ? x.durum : null }));
  } catch {
    return [];
  }
}

/** HepsiJet'in herkese açık takip sayfası (Shopify'a da bu yazılır). */
export function hepsijetTakipAdresi(barkod: string): string {
  return `https://hepsijet.com/gonderi-takibi/${encodeURIComponent(barkod)}`;
}

/** Ekranda gösterilecek gönderi özeti — masaüstü API'si ve telefon aynı biçimi kullanır. */
export interface KargoGonderiOzeti {
  barkod: string;
  firma: "hepsijet";
  ortam: "test" | "prod";
  durum: KargoDurumu;
  metin: string;
  olusturmaAni: number;
  sonOlayAni: number | null;
  olaylar: KargoOlayi[];
  /** Shopify'da "gönderildi" işaretlendi mi / ne zaman. */
  shopifyGonderildi: number | null;
  shopifyTeslim: number | null;
  /** Shopify'a yazılamadıysa kısa neden. */
  shopifyHata: string | null;
}

/** Kurye almadan önce gönderi silinebilir (HepsiJet kuralı). */
export function kargoIptalEdilebilir(o: Pick<KargoGonderiOzeti, "durum">): boolean {
  return o.durum === "olusturuldu";
}
