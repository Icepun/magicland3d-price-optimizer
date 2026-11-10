import { sikKomisyonlar } from "@core/hizli-hesap";
import { query } from "@/lib/turso";

/**
 * Hızlı hesap formunun kısayolları: ilanlarda en sık kullanılan komisyon oranları.
 * Masaüstü /api/hizli-hesap ile aynı süzgeç ve aynı çekirdek sayımı (`sikKomisyonlar`).
 */
export async function getSikKomisyonlar(): Promise<Record<"trendyol" | "hepsiburada", number[]>> {
  const satirlar = await query<{ platform: string; commissionRate: number | null }>(
    `SELECT platform, commissionRate FROM Listing
      WHERE isActive = 1 AND commissionRate IS NOT NULL AND platform IN ('trendyol', 'hepsiburada')`
  );
  return sikKomisyonlar(
    satirlar.map((s) => ({
      platform: String(s.platform),
      commissionRate: s.commissionRate == null ? null : Number(s.commissionRate),
    }))
  );
}
