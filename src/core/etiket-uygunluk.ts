/**
 * Hangi siparişin kargo etiketi uygulamadan basılabilir? Saf — test edilir.
 *
 * • Trendyol: takip numarası şart (ortak etiket Trendyol Express / "Trendyol öder" Aras).
 * • Hepsiburada: PAKET numarası şart — etiket ancak paketlenmiş (panelde "Gönderime hazır")
 *   siparişte var.
 * İptal ve teslim edilmiş siparişte anlamsız.
 *
 * Çekirdekte: telefon da aynı kuralla "Etiketi yazdır" düğmesini gösterir ve aynı anahtarla
 * "basıldı" işaretini okur (telefonun isteğini masaüstü basar — bkz. `lib/etiket/telefon-istekleri`).
 */

export interface EtiketSiparisi {
  platform: string;
  id: string;
  orderNumber: string;
  trackingNumber: string | null;
  packageNumber?: string | null;
  statusKind: string;
}

function dolu(s: string | null | undefined): s is string {
  return Boolean(s?.trim());
}

export function etiketBasilabilir(s: EtiketSiparisi): boolean {
  if (s.statusKind === "cancelled" || s.statusKind === "delivered") return false;
  if (s.platform === "trendyol") return dolu(s.trackingNumber);
  if (s.platform === "hepsiburada") return dolu(s.packageNumber);
  return false;
}

/** Seçim ve "basıldı" işaretinin anahtarı: takip/teslimat no, yoksa paket no. */
export function etiketAnahtari(s: EtiketSiparisi): string | null {
  if (dolu(s.trackingNumber)) return s.trackingNumber.trim();
  if (dolu(s.packageNumber)) return s.packageNumber.trim();
  return null;
}

/** Henüz kargoya verilmemiş (etiketi en çok gereken) sipariş. */
export function bekleyenEtiket(s: EtiketSiparisi): boolean {
  return etiketBasilabilir(s) && (s.statusKind === "pending" || s.statusKind === "processing");
}

/**
 * Hangi uca, hangi gövdeyle gidilecek. `siparisNo` yalnız kayıt içindir: basılan etiket buluta
 * "basıldı" olarak yazılırken sipariş numarası da görünsün (telefon listesi).
 */
export function etiketIstegi(s: EtiketSiparisi): { url: string; govde: Record<string, string> } | null {
  if (!etiketBasilabilir(s)) return null;
  if (s.platform === "trendyol") {
    return {
      url: "/api/trendyol/etiket",
      govde: { takipNo: (s.trackingNumber as string).trim(), siparisNo: s.orderNumber },
    };
  }
  const govde: Record<string, string> = { paketNo: (s.packageNumber as string).trim(), siparisNo: s.orderNumber };
  if (dolu(s.trackingNumber)) govde.takipNo = s.trackingNumber.trim();
  return { url: "/api/hepsiburada/etiket", govde };
}

/**
 * TELEFONDAN ETİKET — telefon isteği `LabelPrintRequest`'e yazar, etiket yazıcısı bağlı masaüstü
 * basar. Bu süre içinde alınmayan istek BASILMAZ: masaüstü kapalıyken birikip saatler sonra
 * kimse beklemiyorken basılmasın. Telefon da bu süreden sonra "basılmadı" der.
 */
export const ETIKET_ISTEGI_OMRU_MS = 2 * 60_000;

/** pending → running (masaüstü sahiplendi) → done | error; telefon bekleyeni cancelled yapabilir. */
export type EtiketIstekDurumu = "pending" | "running" | "done" | "error" | "cancelled";

export function etiketIstegiBayat(createdAtMs: number, simdi: number): boolean {
  return simdi - createdAtMs > ETIKET_ISTEGI_OMRU_MS;
}
