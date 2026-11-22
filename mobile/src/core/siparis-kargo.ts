import type { KargoBaglami } from "./kargo-tarife";

/**
 * SİPARİŞİN KARGO BAĞLAMI — pazaryeri siparişinden, tarifenin hangi fiyatı kullanacağını belirleyen
 * bilgiler (`core/kargo-tarife.ts`). Masaüstü ve telefon aynı fonksiyonları çağırır.
 */

/** Trendyol paketinin kargoyla ilgili alanları (Sipariş v2). */
export interface TrendyolKargoPaketi {
  cargoProviderName?: unknown;
  fastDelivery?: unknown;
  /** Söz verilen kargoya verme anı (Trendyol damgası). */
  agreedDeliveryDate?: unknown;
  packageHistories?: unknown;
}

const sayi = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Paketin kargoya verildiği an (geçmişteki ilk "Shipped" kaydı); yoksa null. */
export function trendyolKargolanmaAni(paket: TrendyolKargoPaketi): number | null {
  const gecmis = Array.isArray(paket.packageHistories) ? paket.packageHistories : [];
  let ilk: number | null = null;
  for (const g of gecmis) {
    if (!g || typeof g !== "object") continue;
    const kayit = g as Record<string, unknown>;
    if (!/^shipped$/i.test(String(kayit.status ?? ""))) continue;
    const t = sayi(kayit.createdDate);
    if (t != null && (ilk == null || t < ilk)) ilk = t;
  }
  return ilk;
}

/**
 * Trendyol: avantajlı tablo yalnız hızlı teslimat işaretli VE zamanında kargolanan siparişte.
 * Henüz kargolanmamış siparişte "geç" bilinmez → null (zamanında varsayılır).
 * İki damga da Trendyol'un aynı (Türkiye saati) biçiminde; karşılaştırma doğrudan yapılır.
 */
export function trendyolKargoBaglami(paket: TrendyolKargoPaketi): KargoBaglami {
  const kargolandi = trendyolKargolanmaAni(paket);
  const soz = sayi(paket.agreedDeliveryDate);
  return {
    firma: typeof paket.cargoProviderName === "string" ? paket.cargoProviderName : null,
    hizliTeslimat: paket.fastDelivery === true,
    gecKargolandi: kargolandi != null && soz != null ? kargolandi > soz : null,
  };
}

/**
 * Hepsiburada: barem kalemlerin EN UZUN kargoya verme süresine (≤ 1 gün) ve müşterinin ÖDEDİĞİ
 * tutara bakar. Süresi bilinmeyen kalem varsa süre bilinmiyor sayılır (tedbirli: desi listesi).
 */
export function hepsiburadaKargoBaglami(
  kalemler: ReadonlyArray<{ dispatchDays?: number | null; paidUnitPrice?: number | null; quantity?: number | null }>,
  firma: string | null | undefined
): KargoBaglami {
  let enUzun: number | null = null;
  let bilinmeyen = false;
  let odenen = 0;
  let odenenTam = kalemler.length > 0;
  for (const k of kalemler) {
    const gun = k.dispatchDays;
    if (typeof gun === "number" && Number.isFinite(gun) && gun >= 0) enUzun = Math.max(enUzun ?? 0, gun);
    else bilinmeyen = true;
    const adet = typeof k.quantity === "number" && k.quantity > 0 ? k.quantity : 1;
    if (typeof k.paidUnitPrice === "number" && Number.isFinite(k.paidUnitPrice)) odenen += k.paidUnitPrice * adet;
    else odenenTam = false;
  }
  return {
    firma: firma ?? null,
    kargoyaVermeGunu: bilinmeyen ? null : enUzun,
    baremTutari: odenenTam ? Math.round(odenen * 100) / 100 : null,
  };
}

/** Trendyol: kargoya verilip geri dönen (ya da teslim edilemeyen) paket durumları. */
const TRENDYOL_KARGOLU_IADE = new Set(["Returned", "UnDeliveredAndReturned", "UnDelivered"]);
/** Hepsiburada: aynı anlamdaki sipariş durumları. */
const HEPSIBURADA_KARGOLU_IADE = new Set(["Returned", "UnDelivered"]);

/**
 * Sipariş kargoya verildikten sonra mı geri geldi? (Kargo zararı doğar.) Kargolanmadan iptal
 * edilen siparişte kargo yoktur → false.
 */
export function kargoluIadeMi(platform: string, durum: string | null | undefined, tamIade = false): boolean {
  if (tamIade) return true;
  const d = String(durum ?? "");
  if (platform === "trendyol") return TRENDYOL_KARGOLU_IADE.has(d);
  if (platform === "hepsiburada") return HEPSIBURADA_KARGOLU_IADE.has(d);
  return false;
}
