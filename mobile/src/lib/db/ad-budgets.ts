import { execute, query, writeBatch } from "@/lib/turso";
import { dbEpochMs } from "@core/sqlite-date";
import { tarifeDonemSiniri } from "@core/tariff-period";
import type { ReklamZorlama } from "@/lib/db/finance";

/**
 * REKLAM BÜTÇESİ — platform başına günlük reklam harcaması.
 *
 * NEDEN TELEFONDA: bütçe kâr rakamını doğrudan değiştiriyor (her sipariş reklam payı taşıyor)
 * ama yalnız masaüstünden girilebiliyordu. Kullanıcı reklamı telefondan açıp kapatıyor;
 * harcamayı günlerce geç girince aradaki tüm siparişlerin kârı yanlış hesaplanıyordu.
 *
 * ⚠️ KAYITLAR SİLİNMEZ. Geçmiş siparişlerin kârı kendi DÖNEMİNİN oranına bağlı; eski dönem
 * silinirse o siparişler bir daha doğru hesaplanamaz. Yeni bütçe, eskisini bitirip başlar
 * (masaüstündeki /api/ad-budgets ile aynı kural, sınır `@core/tariff-period`ten).
 */

export interface AdBudgetRow {
  id: string;
  platform: string;
  dailyAmount: number;
  validFrom: number | null;
  validTo: number | null;
  isActive: number;
}

export const AD_PLATFORMS = ["all", "trendyol", "shopify", "hepsiburada"] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

export const AD_PLATFORM_LABEL: Record<AdPlatform, string> = {
  all: "Tüm platformlar",
  trendyol: "Trendyol",
  shopify: "Shopify",
  hepsiburada: "Hepsiburada",
};

/** Kayıtlı bütçeler — yeni dönem üstte. */
export async function getAdBudgets(): Promise<AdBudgetRow[]> {
  const rows = await query<AdBudgetRow>(
    `SELECT id, platform, dailyAmount,
            ${dbEpochMs("validFrom")} AS validFrom,
            ${dbEpochMs("validTo")} AS validTo,
            isActive
       FROM AdBudget
      ORDER BY ${dbEpochMs("validFrom")} DESC`
  );
  return (rows as unknown as AdBudgetRow[]).map((r) => ({
    ...r,
    dailyAmount: Number(r.dailyAmount) || 0,
    validFrom: r.validFrom == null ? null : Number(r.validFrom),
    validTo: r.validTo == null ? null : Number(r.validTo),
  }));
}

export class AdBudgetOverlapError extends Error {}

/**
 * Yeni bütçe dönemi başlat.
 *
 * Masaüstündeki uçla AYNI üç adım:
 *  1. başlangıçtan SONRA başlayan bir kayıt varsa reddet (dönemler iç içe geçmesin — izin
 *     verilseydi kapatma işlemi o dönemin bitişini kendi başlangıcından öne düşürür ve hiç
 *     eşleşmeyen ölü kayıt doğardı),
 *  2. yürürlükteki/yaklaşan kayıtları yeni başlangıçtan 1 ms önce kapat (geçmişe dokunma),
 *  3. yeni dönemi aç.
 */
export async function saveAdBudget(input: {
  platform: AdPlatform;
  dailyAmount: number;
  startsAt: Date;
}): Promise<ReklamZorlama> {
  const { platform, dailyAmount, startsAt } = input;
  if (!Number.isFinite(dailyAmount) || dailyAmount < 0) {
    throw new Error("Günlük tutar 0 veya daha büyük olmalı.");
  }
  if (Number.isNaN(startsAt.getTime())) throw new Error("Başlangıç tarihi geçersiz.");

  const { eskiBitis } = tarifeDonemSiniri(startsAt);
  const basMs = startsAt.getTime();

  const cakisan = await query<{ validFrom: number }>(
    `SELECT ${dbEpochMs("validFrom")} AS validFrom FROM AdBudget
      WHERE platform = ? AND ${dbEpochMs("validFrom")} >= ?
      ORDER BY ${dbEpochMs("validFrom")} DESC LIMIT 1`,
    [platform, basMs]
  );
  const varOlan = (cakisan as unknown as { validFrom: number }[])[0];
  if (varOlan) {
    const t = new Date(Number(varOlan.validFrom)).toLocaleDateString("tr-TR");
    throw new AdBudgetOverlapError(
      `${t} tarihinde başlayan bir reklam bütçesi zaten var. Yeni bütçe ondan sonraki bir tarihte başlamalı.`
    );
  }

  // Kapanacak dönemler: sınırları değiştiği için oranları da değişir → Raporlar'da yeniden
  // yazılacak aralık onların başından başlar (masaüstüyle aynı kural).
  const kayitAniMs = Date.now();
  const kapanacaklar = await query<{ bas: number | null }>(
    `SELECT ${dbEpochMs("validFrom")} AS bas FROM AdBudget
      WHERE platform = ? AND (validTo IS NULL OR ${dbEpochMs("validTo")} >= ?)`,
    [platform, kayitAniMs]
  );
  const etkiBaslangici = Math.min(
    basMs,
    ...(kapanacaklar as unknown as { bas: number | null }[])
      .map((r) => (r.bas == null ? Number.NaN : Number(r.bas)))
      .filter((n) => Number.isFinite(n))
  );

  // ⚠️ TARİHLER ISO METİN (masaüstü Prisma da öyle yazıyor). Epoch-ms sayı yazılırsa SQLite'ta
  // tamsayı < metin olduğu için dönem filtreleri bu satırları sessizce eler.
  // TEK PARÇA: eski dönem kapanıp yenisi yazılamazsa reklam bütçesi tamamen kaybolurdu.
  await writeBatch([
    {
      sql: `UPDATE AdBudget SET validTo = ?
             WHERE platform = ? AND (validTo IS NULL OR ${dbEpochMs("validTo")} >= ?)`,
      args: [eskiBitis.toISOString(), platform, kayitAniMs],
    },
    {
      sql: `INSERT INTO AdBudget (id, platform, dailyAmount, validFrom, validTo, isActive, createdAt)
            VALUES (?, ?, ?, ?, NULL, 1, ?)`,
      args: [
        `ab_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
        platform,
        dailyAmount,
        startsAt.toISOString(),
        new Date(kayitAniMs).toISOString(),
      ],
    },
  ]);
  return { baslangicMs: etkiBaslangici, platform };
}

/**
 * Bütçeyi kapat (reklam durdu): dönem SİLİNMEZ, bugünle biter.
 *
 * ⚠️ YALNIZ `validTo` YAZILIR, `isActive` 1 KALIR (denetim, 23 Kas 2026). Eskiden `isActive = 0`
 * yapılıyordu; okuyucular (masaüstü + telefon) yalnız etkin dönemleri gördüğü için durdurulan
 * dönemin TÜM reklam payı geriye dönük siliniyor, o dönemdeki siparişler reklamsız (yüksek) kâr
 * gösteriyordu. Masaüstü de dönemi böyle kapatır: bitişten önceki siparişler payını taşımaya devam eder.
 *
 * Döner: Raporlar'da yeniden yazılacak aralık (dönemin başından itibaren).
 */
export async function stopAdBudget(id: string): Promise<ReklamZorlama | null> {
  const satir = (await query<{ bas: number | null; platform: string }>(
    `SELECT ${dbEpochMs("validFrom")} AS bas, platform FROM AdBudget WHERE id = ?`,
    [id]
  )) as unknown as { bas: number | null; platform: string }[];
  await execute(`UPDATE AdBudget SET validTo = ? WHERE id = ?`, [new Date().toISOString(), id]);
  const bas = satir[0]?.bas == null ? Number.NaN : Number(satir[0].bas);
  return Number.isFinite(bas) ? { baslangicMs: bas, platform: String(satir[0].platform) } : null;
}
