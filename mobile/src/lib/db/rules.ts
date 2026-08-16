import { TUM_PLATFORMLAR, reklamOrani, donemGunSayisi, type DonemliButce } from "@core/ad-cost";
// Tarih biçimi bilgisi TEK yerde (ortak çekirdek) — karşılaştırmalar biçimden bağımsız olsun diye.
import { dbEpochMs } from "@core/sqlite-date";
import { batch, query, type SqlValue } from "@/lib/turso";
import type {
  CommissionRuleInput,
  CargoRuleInput,
  ExpenseRuleInput,
} from "@core/types";
import type { Rules } from "@/lib/profit";
import { ensureCargoVatSchema } from "@/lib/db/schema";

function parseRuleDate(value: unknown): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  // libSQL/Prisma sürümüne göre DATETIME ISO metni veya epoch olarak gelebilir.
  const numeric = typeof value === "number" ? value : /^\d+$/.test(String(value)) ? Number(value) : null;
  const date = new Date(numeric == null ? String(value) : numeric < 100_000_000_000 ? numeric * 1000 : numeric);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeRuleDates<T extends CommissionRuleInput | CargoRuleInput>(row: T): T {
  return {
    ...row,
    validFrom: parseRuleDate(row.validFrom as unknown),
    validTo: parseRuleDate(row.validTo as unknown),
    ...("cargoCost" in row
      ? { vatIncluded: row.vatIncluded == null ? true : Number(row.vatIncluded) !== 0 }
      : {}),
  };
}

/**
 * Üç kural setini TEK round-trip'te getir (batch). Ekranlardaki ["rules"] sorgusu bunu kullanır —
 * eski hali 3 ARDIŞIK round-trip'ti (~100-400ms boşa; açılışın kritik yolunda).
 */
/** Ham SQL tarih kolonu (epoch-ms sayı ya da ISO metin) → ms. */
function ruleMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

export async function getRules(): Promise<Rules> {
  await ensureCargoVatSchema();
  const [c, k, e, f] = await batch([
    {
      sql: `SELECT id, name, categoryName, minPrice, maxPrice, commissionRate,
                   fixedCommission, validFrom, validTo, priority, isActive
              FROM CommissionRule WHERE isActive = 1
             ORDER BY priority DESC, name ASC`,
    },
    {
      sql: `SELECT id, name, platform, cargoProvider, categoryName, minPrice, maxPrice,
                   minDesi, maxDesi, cargoCost, vatIncluded, validFrom, validTo, priority, isActive
              FROM CargoRule WHERE isActive = 1`,
    },
    {
      sql: `SELECT id, name, platform, type, value, categoryName, minPrice, maxPrice,
                   priority, isActive
              FROM ExpenseRule WHERE isActive = 1`,
    },
    {
      // Trendyol GERÇEK komisyonu (settlement). Aynı batch'te → ekstra round-trip YOK.
      sql: `SELECT externalOrderId, orderNumber, commissionKurus, grossRevenueKurus
              FROM PlatformOrderFinancial WHERE platform = 'trendyol'`,
    },
  ]);

  // Settlement haritaları — masaüstü /api/orders ile aynı iki anahtar (kimlik + tekil sipariş no).
  const financialByExternalId = new Map<
    string,
    { actualCommission: number; settlementRevenue: number }
  >();
  const financialByOrderNumber = new Map<
    string,
    { actualCommission: number; settlementRevenue: number }[]
  >();
  type FinancialRow = {
    externalOrderId: string;
    orderNumber: string;
    commissionKurus: number;
    grossRevenueKurus: number;
  };
  for (const row of (f?.rows ?? []) as unknown as FinancialRow[]) {
    const entry = {
      actualCommission: Number(row.commissionKurus) / 100,
      settlementRevenue: Number(row.grossRevenueKurus) / 100,
    };
    financialByExternalId.set(String(row.externalOrderId), entry);
    const list = financialByOrderNumber.get(String(row.orderNumber));
    if (list) list.push(entry);
    else financialByOrderNumber.set(String(row.orderNumber), [entry]);
  }

  // --- REKLAM PAYI ---
  // Her bütçe DÖNEMİNİN oranı KENDİ cirosundan hesaplanır ve kayda yazılır. Tek bir
  // "son 30 gün" oranı kullanılsaydı pencere her gün kayacağı için GEÇMİŞ siparişlerin
  // payı da her gün değişirdi (masaüstünde ölçüldü: 2,5 kat fark).
  let adBudgets: DonemliButce[] = [];
  try {
    const b = await query<Record<string, unknown>>(
      `SELECT platform, dailyAmount, validFrom, validTo, isActive
         FROM AdBudget WHERE isActive = 1`
    );
    const simdi = Date.now();
    adBudgets = [];
    const satirlar = b as unknown as {
      platform: string; dailyAmount: number; validFrom: unknown; validTo: unknown; isActive: unknown;
    }[];

    /**
     * ⚠️ TARİH KARŞILAŞTIRMASI `dbEpochMs()` ÜZERİNDEN YAPILIR.
     *
     * Eskiden pencere sınırları ham MİLİSANİYE olarak bağlanıyordu; kolon ise ISO METİN.
     * SQLite'ta tamsayı DAİMA metinden küçüktür → `orderedAt <= <sayı>` hiçbir satırı tutmadı,
     * ciro 0 çıktı, reklam oranı 0 oldu ve telefon her ürünü/siparişi masaüstünden DAHA KÂRLI
     * gösterdi (Fiyat Lab'ın önerdiği fiyat da hedef marjı tutturmadı). `dbEpochMs()` kolonu
     * hangi biçimde yazılmışsa olsun sayıya çevirir → karışık kayıtlarda bile doğru çalışır.
     *
     * N+1 KALKTI: her bütçe için ayrı ağ turu atılıyordu (7 ekranın açılışını yavaşlatıyordu).
     * Tüm dönemler TEK sorguda toplanıyor; satırlar sıra numarasıyla eşleşiyor.
     */
    const donemler = satirlar.map((row) => ({
      row,
      basMs: ruleMs(row.validFrom) ?? 0,
      bitMs: ruleMs(row.validTo) ?? simdi,
      tumu: row.platform === TUM_PLATFORMLAR,
    }));

    let cirolar: number[] = [];
    if (donemler.length > 0) {
      const ms = dbEpochMs("orderedAt");
      const parcalar = donemler.map((d, i) =>
        `SELECT ${i} AS i, COALESCE(SUM(revenueKurus), 0) / 100.0 AS ciro
           FROM OrderFinanceSnapshot
          WHERE ${ms} >= ? AND ${ms} <= ?
            AND (statusKind IS NULL OR statusKind <> 'cancelled')
            ${d.tumu ? "" : "AND platform = ?"}`
      );
      const args: SqlValue[] = [];
      for (const d of donemler) {
        args.push(d.basMs, d.bitMs);
        if (!d.tumu) args.push(d.row.platform);
      }
      const sonuc = await query<{ i: number; ciro: number }>(parcalar.join(" UNION ALL "), args);
      cirolar = donemler.map((_, i) => {
        const bulunan = (sonuc as unknown as { i: number; ciro: number }[]).find((r) => Number(r.i) === i);
        return Number(bulunan?.ciro) || 0;
      });
    }

    donemler.forEach((d, i) => {
      /**
       * PAYDA masaüstüyle AYNI olmalı: "tüm platformlar" bütçesinde TOPLAM ciro, platform
       * bütçesinde o platformun cirosu. Marka reklamı tüm satışları beslediği için paydasını
       * tek kanala daraltmak o kanalı haksız yere ezerdi.
       */
      const o = reklamOrani({
        gunlukTutar: Number(d.row.dailyAmount) || 0,
        gunSayisi: donemGunSayisi(ruleMs(d.row.validFrom), ruleMs(d.row.validTo), simdi),
        pencereCirosu: cirolar[i] ?? 0,
      });
      adBudgets.push({
        platform: d.row.platform,
        dailyAmount: Number(d.row.dailyAmount) || 0,
        validFrom: ruleMs(d.row.validFrom),
        validTo: ruleMs(d.row.validTo),
        isActive: true,
        oran: o.oran,
      });
    });
  } catch {
    // Reklam payı isteğe bağlı: tablo yoksa/okunamazsa kâr eskisi gibi (reklamsız) hesaplanır.
    adBudgets = [];
  }

  return {
    commission: (c.rows as unknown as CommissionRuleInput[]).map(normalizeRuleDates),
    cargo: (k.rows as unknown as CargoRuleInput[]).map(normalizeRuleDates),
    expense: e.rows as unknown as ExpenseRuleInput[],
    financialByExternalId,
    financialByOrderNumber,
    adBudgets,
  };
}

/** Aktif komisyon kuralları (öncelik sırasıyla). */
export async function getCommissionRules(): Promise<CommissionRuleInput[]> {
  const rows = await query<CommissionRuleInput>(
    `SELECT id, name, categoryName, minPrice, maxPrice, commissionRate,
            fixedCommission, validFrom, validTo, priority, isActive
       FROM CommissionRule WHERE isActive = 1
      ORDER BY priority DESC, name ASC`
  );
  return rows.map(normalizeRuleDates);
}

/** Aktif kargo kuralları. */
export async function getCargoRules(): Promise<CargoRuleInput[]> {
  await ensureCargoVatSchema();
  const rows = await query<CargoRuleInput>(
    `SELECT id, name, platform, cargoProvider, categoryName, minPrice, maxPrice,
            minDesi, maxDesi, cargoCost, vatIncluded, validFrom, validTo, priority, isActive
       FROM CargoRule WHERE isActive = 1`
  );
  return rows.map(normalizeRuleDates);
}

/** Aktif ek gider kuralları (KDV, platform bedeli vb.). */
export async function getExpenseRules(): Promise<ExpenseRuleInput[]> {
  return query<ExpenseRuleInput>(
    `SELECT id, name, platform, type, value, categoryName, minPrice, maxPrice,
            priority, isActive
       FROM ExpenseRule WHERE isActive = 1`
  );
}

/** Tüm uygulama ayarları → key/value haritası (KDV oranı, paketleme fiyatları vb.). */
export async function getSettingsMap(): Promise<Record<string, string>> {
  const rows = await query<{ key: string; value: string }>(
    `SELECT key, value FROM AppSetting`
  );
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}
