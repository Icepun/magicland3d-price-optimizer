import { prisma } from "@/lib/prisma";
import {
  TUM_PLATFORMLAR,
  reklamOrani,
  reklamOraniIcin,
  donemGunSayisi,
  type DonemliButce,
} from "@/core/ad-cost";
import { toDbDate } from "@/lib/sqlite-date";

/**
 * REKLAM ORANI SERVİSİ — her bütçe DÖNEMİNİ kendi cirosuna oranlar.
 *
 * Çekirdek (`core/ad-cost.ts`) saf matematiktir; ciroyu bilmez. Burası ciroyu veritabanından
 * okur ve her dönemin oranını o dönemin kaydına yazar.
 *
 * ⚠️ NEDEN DÖNEM BAŞINA: önce tek bir "son 30 gün" oranı hesaplanıp geçmiş dönemler ona göre
 * ölçekleniyordu. Pencere her gün kaydığı için GEÇMİŞ siparişlerin kârı da her gün kayıyordu
 * (ölçüldü: aynı Ağustos siparişi, bugünkü ciro seviyesine göre 120 ₺ ya da 300 ₺ reklam payı
 * — 2,5 kat fark). Artık kapanmış dönemin oranı sabittir: kendi başlangıç–bitişi arasındaki
 * gerçek ciroya bölünür ve bir daha oynamaz.
 *
 * ⚠️ ÖNBELLEK ŞART: uzak Turso'da her sorgu ~96ms ve süreç genelinde SIRALI. Oran sipariş
 * listesinde her sipariş için gerekiyor; önbelleksiz yüzlerce sorgu ederdi.
 */

const TTL_MS = 5 * 60_000;

export interface AdSnapshot {
  at: number;
  /** Oranı doldurulmuş bütçe kayıtları. */
  butceler: DonemliButce[];
  /** Arayüz önizlemesi için platform → bugünkü dönemin oran bilgisi. */
  bugun: Map<string, { oran: number; toplamHarcama: number; guvenilir: boolean; cirodanBuyuk: boolean }>;
}

// Süreç geneli: instrumentation (relay) ile rotalar ayrı paketlere derleniyor; modül
// kapsamında tutulsaydı iki ayrı önbellek doğar ve sorgu iki katına çıkardı.
const g = globalThis as unknown as Record<string, unknown>;
function kayit(): { v: AdSnapshot | null } {
  const anahtar = "__mlhub_adRateCache";
  if (!(anahtar in g)) g[anahtar] = { v: null };
  return g[anahtar] as { v: AdSnapshot | null };
}

/** Önbelleği at — bütçe eklenince/değişince çağrılır. */
export function bustAdRateCache(): void {
  kayit().v = null;
}

const BOS = (at: number): AdSnapshot => ({ at, butceler: [], bugun: new Map() });

export async function adRateSnapshot(): Promise<AdSnapshot> {
  const k = kayit();
  const simdi = Date.now();
  if (k.v && simdi - k.v.at < TTL_MS) return k.v;

  try {
    const kayitlar = await prisma.adBudget.findMany({ where: { isActive: true } });
    if (kayitlar.length === 0) {
      k.v = BOS(simdi);
      return k.v;
    }

    const butceler: DonemliButce[] = [];
    const bugun: AdSnapshot["bugun"] = new Map();

    for (const b of kayitlar) {
      const bas = b.validFrom;
      const bit = b.validTo ?? new Date(simdi);
      // Dönemin KENDİ cirosu — iptal/iade hariç (ciro getirmediler, pay da taşımazlar).
      /**
       * PAYDA: "tüm platformlar" bütçesinde TOPLAM ciro, platform bütçesinde o platformun
       * cirosu. Marka reklamı tüm satışları besliyor; paydasını tek kanala daraltmak o kanalı
       * haksız yere ezerdi (ölçüldü: yalnız Shopify'a yüklenince oran %39,9, tümüne
       * yayılınca %18,1).
       */
      const tumu = b.platform === TUM_PLATFORMLAR;
      const satir = await prisma.$queryRawUnsafe<{ ciro: number }[]>(
        `SELECT COALESCE(SUM(revenueKurus), 0) / 100.0 AS ciro
           FROM OrderFinanceSnapshot
          WHERE orderedAt >= ? AND orderedAt <= ?
            AND (statusKind IS NULL OR statusKind <> 'cancelled')
            ${tumu ? "" : "AND platform = ?"}`,
        ...(tumu ? [toDbDate(bas), toDbDate(bit)] : [toDbDate(bas), toDbDate(bit), b.platform])
      );
      const ciro = Number(satir?.[0]?.ciro) || 0;
      const gun = donemGunSayisi(bas, b.validTo, simdi);
      const o = reklamOrani({ gunlukTutar: b.dailyAmount, gunSayisi: gun, pencereCirosu: ciro });

      butceler.push({
        platform: b.platform,
        dailyAmount: b.dailyAmount,
        validFrom: b.validFrom,
        validTo: b.validTo,
        isActive: b.isActive,
        oran: o.oran,
      });

      // Bugün yürürlükte olan dönem → arayüz önizlemesi.
      const basMs = new Date(bas).getTime();
      const bitMs = b.validTo ? new Date(b.validTo).getTime() : Infinity;
      if (simdi >= basMs && simdi <= bitMs) {
        bugun.set(b.platform, {
          oran: o.oran,
          toplamHarcama: o.toplamHarcama,
          guvenilir: o.guvenilir,
          cirodanBuyuk: o.cirodanBuyuk,
        });
      }
    }

    k.v = { at: simdi, butceler, bugun };
    return k.v;
  } catch {
    // Reklam oranı İSTEĞE BAĞLI bir zenginleştirmedir: hesaplanamazsa kâr eskisi gibi
    // (reklamsız) hesaplanır — sipariş listesi asla bu yüzden düşmemeli.
    k.v = BOS(simdi);
    return k.v;
  }
}

/** Bir siparişin reklam oranı — platformu ve KENDİ tarihiyle (çekirdek karar verir). */
export function adRateFor(
  snapshot: AdSnapshot,
  platform: string,
  orderedAt: Date | null | undefined
): number {
  return reklamOraniIcin(snapshot.butceler, platform, orderedAt ? orderedAt.getTime() : Date.now());
}
