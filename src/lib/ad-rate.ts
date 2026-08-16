import { prisma } from "@/lib/prisma";
import {
  REKLAM_PENCERE_GUN,
  reklamOrani,
  gecerliButce,
  reklamOraniIcin,
  type ReklamOrani,
  type DonemliButce,
} from "@/core/ad-cost";
import { toDbDate } from "@/lib/sqlite-date";

/**
 * REKLAM ORANI SERVİSİ — bütçeyi platformun GERÇEK cirosuna oranlar.
 *
 * Çekirdek (`core/ad-cost.ts`) saf matematiktir; ciroyu bilmez. Burası ciroyu veritabanından
 * okur ve oranı kurar.
 *
 * ⚠️ ÖNBELLEK ŞART: uzak Turso'da her sorgu ~96ms ve süreç genelinde SIRALI. Oran, sipariş
 * listesinde HER SİPARİŞ için gerekiyor; önbelleksiz 235 sipariş = 235 sorgu = ~22 saniye.
 * Oran gün içinde anlamlı ölçüde değişmediği için 5 dakikalık önbellek fazlasıyla yeterli.
 */

const TTL_MS = 5 * 60_000;

interface Kayit {
  at: number;
  oranlar: Map<string, ReklamOrani>;
  butceler: DonemliButce[];
}

// Süreç geneli: instrumentation (relay) ile rotalar ayrı paketlere derleniyor; modül
// kapsamında tutulsaydı iki ayrı önbellek doğar ve sorgu iki katına çıkardı.
const g = globalThis as unknown as Record<string, unknown>;
function kayit(): { v: Kayit | null } {
  const anahtar = "__mlhub_adRateCache";
  if (!(anahtar in g)) g[anahtar] = { v: null };
  return g[anahtar] as { v: Kayit | null };
}

/** Önbelleği at — bütçe eklenince/değişince çağrılır. */
export function bustAdRateCache(): void {
  kayit().v = null;
}

/**
 * Platform → reklam oranı (bugünkü bütçeye göre) + tüm bütçe kayıtları.
 *
 * Oran penceresi son `REKLAM_PENCERE_GUN` gün. Kısa pencere seçilmedi: sipariş sayısı günlük
 * 1-15 arasında oynuyor, 7 günlük pencere oranı zıplatırdı.
 */
export async function adRateSnapshot(): Promise<Kayit> {
  const k = kayit();
  const simdi = Date.now();
  if (k.v && simdi - k.v.at < TTL_MS) return k.v;

  const bos: Kayit = { at: simdi, oranlar: new Map(), butceler: [] };
  try {
    const butceler = (await prisma.adBudget.findMany({
      where: { isActive: true },
    })) as unknown as DonemliButce[];

    if (butceler.length === 0) {
      k.v = { ...bos, butceler: [] };
      return k.v;
    }

    // Pencere cirosu: iptal/iade siparişler HARİÇ (ciro getirmediler, reklam payı da taşımazlar).
    const baslangic = new Date(simdi - REKLAM_PENCERE_GUN * 24 * 60 * 60_000);
    const satirlar = await prisma.$queryRawUnsafe<{ platform: string; ciro: number }[]>(
      `SELECT platform, COALESCE(SUM(revenueKurus), 0) / 100.0 AS ciro
         FROM OrderFinanceSnapshot
        WHERE orderedAt >= ?
          AND (statusKind IS NULL OR statusKind <> 'cancelled')
        GROUP BY platform`,
      toDbDate(baslangic)
    );

    const ciroOf = new Map<string, number>();
    for (const s of satirlar) ciroOf.set(String(s.platform), Number(s.ciro) || 0);

    const oranlar = new Map<string, ReklamOrani>();
    for (const b of butceler) {
      const bugunku = gecerliButce(butceler, b.platform, simdi);
      if (!bugunku) continue;
      oranlar.set(
        b.platform,
        reklamOrani({
          gunlukTutar: bugunku.dailyAmount,
          gunSayisi: REKLAM_PENCERE_GUN,
          pencereCirosu: ciroOf.get(b.platform) ?? 0,
        })
      );
    }

    k.v = { at: simdi, oranlar, butceler };
    return k.v;
  } catch {
    // Reklam oranı İSTEĞE BAĞLI bir zenginleştirmedir: hesaplanamazsa kâr eskisi gibi
    // (reklamsız) hesaplanır — sipariş listesi asla bu yüzden düşmemeli.
    k.v = bos;
    return bos;
  }
}

/**
 * Bir siparişin taşıyacağı reklam oranı — platformu ve KENDİ tarihi ile.
 *
 * ⚠️ Tarih ŞART: bütçe dönemlidir. Geçilmezse bugünün bütçesi tüm geçmişe uygulanır ve
 * bütçe her değiştiğinde geçmiş siparişlerin kârı kayar (kargo tarifelerindeki hata).
 */
export function adRateFor(
  snapshot: Kayit,
  platform: string,
  orderedAt: Date | null | undefined
): number {
  return reklamOraniIcin(
    snapshot.butceler,
    snapshot.oranlar,
    platform,
    orderedAt ? orderedAt.getTime() : Date.now(),
    Date.now()
  );
}
