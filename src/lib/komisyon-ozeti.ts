/**
 * KOMİSYONLAR SAYFASI — "gerçekte ne kadar komisyon ödüyorum?" (9 Eki 2026 denetimi).
 * Sayfa yalnız kural listesiydi ve boştu; oysa siparişlerin çoğunda pazaryerinin bildirdiği
 * GERÇEK komisyon var. Son 30 günün siparişlerinden platform başına özet çıkarılır.
 *
 * Kurallar Siparişler ekranıyla aynı: iptal ve TRY dışı sipariş sayılmaz; gerçek tutar varsa o,
 * yoksa kurallardan hesaplanan tahmin — ikisinin sayısı ayrı tutulur (tahmin gerçek gibi durmasın).
 */
export interface KomisyonSiparisi {
  platform: string;
  total: number;
  currency?: string | null;
  statusKind?: string | null;
  actualCommission?: number | null;
  estimatedCommission?: number | null;
  /** Maliyeti/ürünü eşleşmeyen satır sayısı — >0 ise tahmini komisyon eksik (yalnız eşleşen satırlar). */
  unmatchedCount?: number | null;
}

export interface PlatformKomisyonu {
  platform: string;
  siparis: number;
  ciro: number;
  komisyon: number;
  /** Komisyon ÷ komisyonu BİLİNEN siparişlerin cirosu; yoksa null. */
  oran: number | null;
  /** Komisyonu bilinen siparişlerin cirosu (ortalamanın paydası). */
  bilinenCiro: number;
  gercekAdet: number;
  tahminAdet: number;
  /** Ne gerçek ne tahmin — komisyonu bilinmeyen sipariş. */
  bilinmeyenAdet: number;
}

export function komisyonOzeti(siparisler: readonly KomisyonSiparisi[]): PlatformKomisyonu[] {
  const harita = new Map<string, PlatformKomisyonu>();
  for (const s of siparisler) {
    if (s.platform === "manual") continue; // elle siparişte pazaryeri komisyonu yok
    if (s.statusKind === "cancelled") continue;
    if ((s.currency || "TRY").trim().toUpperCase() !== "TRY") continue;
    const p =
      harita.get(s.platform) ??
      { platform: s.platform, siparis: 0, ciro: 0, komisyon: 0, oran: null, bilinenCiro: 0, gercekAdet: 0, tahminAdet: 0, bilinmeyenAdet: 0 };
    p.siparis++;
    p.ciro += s.total;
    // Eşleşmeyen satırı olan siparişin TAHMİNİ yalnız eşleşen satırları kapsıyor (tümü eşleşmezse 0):
    // ortalamaya girerse oranı düşük gösterir → "bilinmiyor" sayılır (denetim, 23 Kas 2026).
    const eksikTahmin = (s.unmatchedCount ?? 0) > 0;
    if (s.actualCommission != null && Number.isFinite(s.actualCommission)) {
      p.komisyon += s.actualCommission;
      p.bilinenCiro += s.total;
      p.gercekAdet++;
    } else if (s.estimatedCommission != null && Number.isFinite(s.estimatedCommission) && !eksikTahmin) {
      p.komisyon += s.estimatedCommission;
      p.bilinenCiro += s.total;
      p.tahminAdet++;
    } else {
      p.bilinmeyenAdet++;
    }
    harita.set(s.platform, p);
  }
  return [...harita.values()]
    .map((p) => ({ ...p, oran: p.bilinenCiro > 0 ? p.komisyon / p.bilinenCiro : null }))
    .sort((a, b) => b.komisyon - a.komisyon);
}
