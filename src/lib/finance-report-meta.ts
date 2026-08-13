/**
 * Raporlar yanıtının İKİ yan bilgisi: Trendyol komisyon durumu ve veri kaynağı sağlığı.
 * Burada hiçbir kâr/ciro rakamı hesaplanmaz; yalnız "bu rakamlar neye dayanıyor" anlatılır.
 */
import { getOrdersCache } from "./orders-cache";

/**
 * TRENDYOL GERÇEK KOMİSYON DURUMU — TEK sorgu.
 *
 * ⚠️ ÖLÇÜLMÜŞ HATA: sayfa "193 Trendyol siparişinde gerçek komisyon kullanılıyor" diyordu.
 * 193, indirilen komisyon KAYDI sayısıydı (`PlatformOrderFinancial`) — kaç siparişin kârının
 * gerçekten o komisyonla hesaplandığı DEĞİL. Canlı ölçüm: 193 kayıt var, 190'ı bir siparişle
 * eşleşiyor, ama gerçek komisyonla hesaplanmış sipariş yalnız 101 (224 Trendyol siparişinin
 * %45'i); 89 siparişin komisyonu netleşmiş ama kârı hâlâ tahminle kayıtlı.
 *
 * "Uygulanmış" ölçütü `OrderFinanceSnapshot.actualCommissionKurus` doludur — kâr yazılırken
 * gerçek komisyonun kullanıldığının kaydıdır. Burada kâr rakamına DOKUNULMAZ.
 *
 * Eşleştirme `externalOrderId` üzerinden yapılır: sipariş numarasına düşen yedek eşleşme
 * (bkz. `readRecalcFinancials`) yalnız iki tarafta da TEKİL olduğunda geçerli olduğundan
 * sayım için kullanılmaz — burada eksik saymak, fazla saymaktan iyidir.
 */
export function trendyolCommissionStatsSql(): string {
  return `SELECT
    (SELECT COUNT(*) FROM "PlatformOrderFinancial" WHERE "platform" = 'trendyol') AS "records",
    (SELECT COUNT(*) FROM "OrderFinanceSnapshot" WHERE "platform" = 'trendyol') AS "orders",
    (SELECT COUNT(*) FROM "OrderFinanceSnapshot"
      WHERE "platform" = 'trendyol' AND "actualCommissionKurus" IS NOT NULL) AS "applied",
    (SELECT COUNT(*) FROM "PlatformOrderFinancial" f
       JOIN "OrderFinanceSnapshot" s
         ON s."platform" = 'trendyol' AND s."externalOrderId" = f."externalOrderId"
      WHERE f."platform" = 'trendyol' AND s."actualCommissionKurus" IS NULL) AS "pending"`;
}

export interface TrendyolCommissionStats {
  /** Pazaryerinden indirilmiş komisyon kaydı sayısı. */
  records: number;
  /** Toplam Trendyol siparişi. */
  orders: number;
  /** Kârı GERÇEK komisyonla hesaplanmış sipariş sayısı. */
  applied: number;
  /** Komisyonu netleşmiş ama kârı hâlâ tahminle kayıtlı sipariş sayısı. */
  pending: number;
}

export function parseTrendyolCommissionStats(
  rows: Array<Record<string, unknown>>
): TrendyolCommissionStats {
  const row = rows[0] ?? {};
  const toInt = (value: unknown) => {
    const parsed = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    records: toInt(row.records),
    orders: toInt(row.orders),
    applied: toInt(row.applied),
    pending: toInt(row.pending),
  };
}

/**
 * Sağlık damgasının TAZE sayıldığı süre.
 *
 * Siparişler ekranı açıkken 60 saniyede bir çekim yapılır; bu eşik birkaç turluk gecikmeyi
 * tolere eder ama "dünkü" bir damgayı taze saymaz.
 */
export const SOURCE_HEALTH_MAX_AGE_MS = 10 * 60_000;

export interface FinanceSourceHealth {
  /** Son sipariş çekiminde HER kaynak yanıt verdi mi? null = bilinmiyor (hiç çekim yok ya da damga bayat). */
  complete: boolean | null;
  /** Verisi alınamayan kaynakların adları (kurulu olmayanlar buraya girmez). */
  missing: string[];
  /** Son sipariş çekiminin yapıldığı an. */
  computedAt: string | null;
}

/**
 * VERİ KAYNAĞI SAĞLIĞI.
 *
 * Aylık finans veritabanındaki kayıtlı özetlerden okunur; bir pazaryerinden veri alınamadığında
 * o siparişler kayda hiç girmez ve toplamlar sessizce eksik kalır. Siparişler sayfası bu uyarıyı
 * gösteriyordu, Raporlar hiç göstermiyordu. Bilgi son sipariş çekiminin gövdesinde duruyor;
 * burada yalnız okunur (veritabanına ya da ağa gidilmez).
 *
 * ⚠️ Bu blok yanıt önbelleğinin DIŞINDA üretilmelidir: 60 saniyelik bayat bir "her şey yolunda"
 * damgası, tam o sırada başarısız olmuş bir çekimi gizlerdi.
 *
 * ⚠️ AYNI TUZAK BİR KAT AŞAĞIDA DA VARDI: okunan sipariş önbelleği uygulama yeniden başlarken
 * DİSKTEN yükleniyor ve disk kopyası 3 güne kadar taze sayılıyor; üstelik diske yalnız TAM
 * gövdeler yazılıyor. Yani "uygulamayı aç, doğrudan Raporlar'a git" akışında dünkü bir gövde
 * "tüm kaynaklar alındı" diyordu — pazaryeri o an çökmüş olsa bile. Bu yüzden damganın YAŞI
 * eşiği aşarsa yanıt "bilinmiyor" (`complete: null`) olur; sözleşme zaten bunu taşıyor.
 */
export function readFinanceSourceHealth(now: Date = new Date()): FinanceSourceHealth {
  const cached = getOrdersCache();
  const body = cached?.body;
  if (!body) return { complete: null, missing: [], computedAt: null };

  const summary = body.summary as { quality?: { missingSources?: unknown } } | undefined;
  const rawMissing = summary?.quality?.missingSources;
  const missing = Array.isArray(rawMissing)
    ? rawMissing.filter((value): value is string => typeof value === "string")
    : [];
  const computedAt =
    typeof body.computedAt === "string"
      ? body.computedAt
      : cached
        ? new Date(cached.at).toISOString()
        : null;

  const damgaAni = computedAt ? Date.parse(computedAt) : Number.NaN;
  const bayat =
    !Number.isFinite(damgaAni) || now.getTime() - damgaAni > SOURCE_HEALTH_MAX_AGE_MS;
  // Bayat damgada HİÇBİR ŞEY iddia edilmez: ne "hepsi alındı" ne de "şu kaynak eksik".
  // Yaşı `computedAt` taşır, karar arayüzün.
  if (bayat) return { complete: null, missing: [], computedAt };

  const complete =
    typeof body.dataComplete === "boolean" ? body.dataComplete : missing.length === 0;
  return { complete, missing, computedAt };
}
