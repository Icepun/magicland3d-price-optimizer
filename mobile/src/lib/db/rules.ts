import { batch, query } from "@/lib/turso";
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
export async function getRules(): Promise<Rules> {
  await ensureCargoVatSchema();
  const [c, k, e] = await batch([
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
  ]);
  return {
    commission: (c.rows as unknown as CommissionRuleInput[]).map(normalizeRuleDates),
    cargo: (k.rows as unknown as CargoRuleInput[]).map(normalizeRuleDates),
    expense: e.rows as unknown as ExpenseRuleInput[],
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
