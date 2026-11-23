/**
 * Pazaryeri ilanının komisyonu BİLİNMİYOR mu?
 *
 * Trendyol / Hepsiburada ilanında ne ilanın kendi oranı ne de eşleşen bir komisyon kuralı varsa
 * hesap komisyonu 0 sayıyordu: ilan "Komisyon gir!" uyarısıyla birlikte YEŞİL, şişkin bir kâr
 * gösteriyordu (23 Kas 2026: 7 Trendyol ilanı, ör. ₺599,99 fiyatta ₺319 "kâr"). Berke'nin kararı:
 * bu ilanlarda kâr gösterilmez, ortalamalara ve "zarar eden" sayısına girmez (bilinmeyen ≠ sıfır).
 *
 * Ürünler listesi, ürün detayı ve Fiyat Laboratuvarı, Panel'in ilan sağlığı, Raporlar'ın teorik
 * ürün kârı ve telefon AYNI kuralı kullanır (çekirdekte → telefona `sync-core` ile gider).
 */
export function komisyonBilinmiyor(
  listing: { platform: string; commissionRate: number | null | undefined },
  sim: { appliedCommissionRule?: unknown },
): boolean {
  return (
    (listing.platform === "trendyol" || listing.platform === "hepsiburada") &&
    listing.commissionRate == null &&
    !sim.appliedCommissionRule
  );
}
