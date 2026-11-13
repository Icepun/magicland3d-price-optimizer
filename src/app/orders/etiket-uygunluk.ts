/**
 * Hangi siparişin kargo etiketi uygulamadan basılabilir? Saf — test edilir.
 *
 * • Trendyol: takip numarası şart (ortak etiket Trendyol Express / "Trendyol öder" Aras).
 * • Hepsiburada: PAKET numarası şart — etiket ancak paketlenmiş (panelde "Gönderime hazır")
 *   siparişte var.
 * İptal ve teslim edilmiş siparişte anlamsız.
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

/** Hangi uca, hangi gövdeyle gidilecek. */
export function etiketIstegi(s: EtiketSiparisi): { url: string; govde: Record<string, string> } | null {
  if (!etiketBasilabilir(s)) return null;
  if (s.platform === "trendyol") {
    return { url: "/api/trendyol/etiket", govde: { takipNo: (s.trackingNumber as string).trim() } };
  }
  const govde: Record<string, string> = { paketNo: (s.packageNumber as string).trim() };
  if (dolu(s.trackingNumber)) govde.takipNo = s.trackingNumber.trim();
  return { url: "/api/hepsiburada/etiket", govde };
}
