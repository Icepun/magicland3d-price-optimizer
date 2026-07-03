import { batch, query } from "@/lib/turso";
import type {
  CommissionRuleInput,
  CargoRuleInput,
  ExpenseRuleInput,
} from "@core/types";
import type { Rules } from "@/lib/profit";

/**
 * Üç kural setini TEK round-trip'te getir (batch). Ekranlardaki ["rules"] sorgusu bunu kullanır —
 * eski hali 3 ARDIŞIK round-trip'ti (~100-400ms boşa; açılışın kritik yolunda).
 */
export async function getRules(): Promise<Rules> {
  const [c, k, e] = await batch([
    {
      sql: `SELECT id, name, categoryName, minPrice, maxPrice, commissionRate,
                   fixedCommission, validFrom, validTo, priority, isActive
              FROM CommissionRule WHERE isActive = 1
             ORDER BY priority DESC, name ASC`,
    },
    {
      sql: `SELECT id, name, platform, cargoProvider, categoryName, minPrice, maxPrice,
                   minDesi, maxDesi, cargoCost, validFrom, validTo, priority, isActive
              FROM CargoRule WHERE isActive = 1`,
    },
    {
      sql: `SELECT id, name, platform, type, value, categoryName, minPrice, maxPrice,
                   priority, isActive
              FROM ExpenseRule WHERE isActive = 1`,
    },
  ]);
  return {
    commission: c.rows as unknown as CommissionRuleInput[],
    cargo: k.rows as unknown as CargoRuleInput[],
    expense: e.rows as unknown as ExpenseRuleInput[],
  };
}

/** Aktif komisyon kuralları (öncelik sırasıyla). */
export async function getCommissionRules(): Promise<CommissionRuleInput[]> {
  return query<CommissionRuleInput>(
    `SELECT id, name, categoryName, minPrice, maxPrice, commissionRate,
            fixedCommission, validFrom, validTo, priority, isActive
       FROM CommissionRule WHERE isActive = 1
      ORDER BY priority DESC, name ASC`
  );
}

/** Aktif kargo kuralları. */
export async function getCargoRules(): Promise<CargoRuleInput[]> {
  return query<CargoRuleInput>(
    `SELECT id, name, platform, cargoProvider, categoryName, minPrice, maxPrice,
            minDesi, maxDesi, cargoCost, validFrom, validTo, priority, isActive
       FROM CargoRule WHERE isActive = 1`
  );
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
