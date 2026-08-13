import { query } from "@/lib/turso";
import { gunlukSatis } from "@/core/planner-target";

/**
 * Ürün başına GÜNLÜK satış adedi — Üretim ekranındaki "satışa göre" hedefin girdisi.
 *
 * Masaüstündeki `src/lib/print-queue.ts → readGunlukSatis` ile AYNI kuralları izler; yoksa
 * telefon ile masaüstü aynı ürün için farklı "kaç adet basmalı" gösterir:
 *   • iptal satırları sayılmaz,
 *   • tarih karşılaştırması depolama tipinden bağımsız normalize edilir,
 *   • bölen ÖLÇÜLEN gün (kanalların birlikte kapsadığı dönem), pencere değil.
 */

const GUN_MS = 86_400_000;
const PENCERE_GUN = 90;
const IPTAL = "cancelled";

/**
 * Tarih kolonunu depolama tipinden BAĞIMSIZ epoch-ms'e çeviren SQL.
 *
 * ⚠️ ŞART: `orderedAt` bu veritabanında METİN olarak saklanıyor. SQLite'ta tamsayı her zaman
 * metinden küçük sayıldığı için düz `orderedAt >= 1755...` karşılaştırması TÜM satırları
 * geçirir — bugün tüm veri pencere içinde olduğu için yanlış sonuç görünmez, ama geçmiş
 * biriktiğinde sessizce eski satırları da sayardı.
 */
function epochMs(kolon: string): string {
  return (
    `(CASE WHEN typeof("${kolon}") IN ('integer','real') ` +
    `THEN CAST("${kolon}" AS INTEGER) ` +
    `ELSE CAST(ROUND((julianday("${kolon}") - 2440587.5) * 86400000.0) AS INTEGER) END)`
  );
}

export interface SatisHizi {
  /** productId → günlük satış adedi. Listede olmayan ürün hiç satmamıştır. */
  gunlukById: Map<string, number>;
  /** Hızın hesaplandığı gün sayısı. */
  olculenGun: number;
}

/**
 * Geçmişin GÜVENİLİR başlangıcı: kanalların EN GENÇ başlangıcı.
 * Bir kanalda 200, diğerinde 20 günlük geçmiş varsa 200 demek, kısa geçmişli kanalın
 * ürünlerine haksızca "satmıyor" damgası vurmak olurdu.
 */
function kapsamBasi(baslangiclar: number[]): number | null {
  const gecerli = baslangiclar.filter((v) => Number.isFinite(v) && v > 0);
  return gecerli.length ? Math.max(...gecerli) : null;
}

export async function getSatisHizi(): Promise<SatisHizi> {
  const simdi = Date.now();
  const since = simdi - PENCERE_GUN * GUN_MS;

  const [satislar, kapsam] = await Promise.all([
    query<{ productId: string; adet: number }>(
      `SELECT productId, SUM(quantity) AS adet
         FROM OrderItemSnapshot
        WHERE productId IS NOT NULL AND statusKind <> ? AND ${epochMs("orderedAt")} >= ?
        GROUP BY productId`,
      [IPTAL, since]
    ),
    query<{ bas: number }>(
      `SELECT MIN(${epochMs("orderedAt")}) AS bas FROM OrderItemSnapshot GROUP BY platform`
    ),
  ]);

  const bas = kapsamBasi(kapsam.map((r) => Number(r.bas)));
  const gecmisGun = bas == null ? 0 : Math.floor((simdi - bas) / GUN_MS);
  const olculenGun = Math.max(1, Math.min(gecmisGun, PENCERE_GUN));

  const gunlukById = new Map<string, number>();
  for (const row of satislar) {
    const id = String(row.productId ?? "");
    if (!id) continue;
    gunlukById.set(id, gunlukSatis(Number(row.adet ?? 0), olculenGun));
  }
  return { gunlukById, olculenGun };
}
