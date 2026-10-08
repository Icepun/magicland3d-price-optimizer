/**
 * ENTEGRASYONLAR — üç platformun durumu tek bakışta (9 Eki 2026 denetimi: her platform kendi
 * sekmesindeydi; hangisinin bozuk olduğunu görmek için üçünü tek tek açmak gerekiyordu).
 * Denetimde üç platformun da son fiyat eşitlemesi 13 gün önceydi — bu kart onu da söyler.
 */
export const ESITLEME_BAYAT_GUN = 3;

export type BaglantiTonu = "iyi" | "uyari" | "hata" | "kapali";

export interface BaglantiDurumu {
  ton: BaglantiTonu;
  bagli: boolean;
  /** "129 sipariş çekildi" / "Siparişler alınamadı" / null (henüz bilinmiyor). */
  siparisMetni: string | null;
  /** Son fiyat eşitlemesinin üstünden geçen tam gün; hiç yapılmadıysa null. */
  esitlemeGun: number | null;
}

export function baglantiDurumu(d: {
  bagli: boolean | undefined;
  siparis: { ok?: boolean; count?: number } | null | undefined;
  sonEsitlemeIso: string | null | undefined;
  nowMs: number;
}): BaglantiDurumu {
  if (!d.bagli) return { ton: "kapali", bagli: false, siparisMetni: null, esitlemeGun: null };
  const t = d.sonEsitlemeIso ? Date.parse(d.sonEsitlemeIso) : NaN;
  const esitlemeGun = Number.isFinite(t) ? Math.max(0, Math.floor((d.nowMs - t) / 86_400_000)) : null;
  const siparisHata = d.siparis != null && d.siparis.ok === false;
  const siparisMetni =
    d.siparis == null ? null : siparisHata ? "Siparişler alınamadı" : `${d.siparis.count ?? 0} sipariş çekildi`;
  const ton: BaglantiTonu = siparisHata
    ? "hata"
    : esitlemeGun == null || esitlemeGun > ESITLEME_BAYAT_GUN
      ? "uyari"
      : "iyi";
  return { ton, bagli: true, siparisMetni, esitlemeGun };
}
