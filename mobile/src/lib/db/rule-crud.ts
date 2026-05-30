import { execute, query } from "@/lib/turso";

function newId(): string {
  return (
    "c" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  );
}

export type ExpenseType = "fixed" | "percentage" | "per_order";

export interface ExpenseRuleFull {
  id: string;
  name: string;
  platform: string | null;
  type: ExpenseType;
  value: number; // percentage ise kesir (0.20), değilse TL
  categoryName: string | null;
  minPrice: number;
  maxPrice: number;
  priority: number;
  isActive: number;
}

/** Tüm ek gider kuralları (pasifler dahil — yönetim listesi). */
export async function getAllExpenseRules(): Promise<ExpenseRuleFull[]> {
  return query<ExpenseRuleFull>(
    `SELECT id, name, platform, type, value, categoryName, minPrice, maxPrice, priority, isActive
       FROM ExpenseRule ORDER BY priority DESC, name ASC`
  );
}

export interface ExpenseRuleDraft {
  name: string;
  platform: string | null;
  type: ExpenseType;
  value: number; // percentage ise kesir
  categoryName: string | null;
  minPrice: number;
  maxPrice: number;
}

export async function createExpenseRule(d: ExpenseRuleDraft): Promise<void> {
  await execute(
    `INSERT INTO ExpenseRule (id, name, platform, type, value, categoryName, minPrice, maxPrice, priority, isActive)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 10, 1)`,
    [newId(), d.name, d.platform, d.type, d.value, d.categoryName, d.minPrice, d.maxPrice]
  );
}

export async function updateExpenseRule(id: string, d: ExpenseRuleDraft): Promise<void> {
  await execute(
    `UPDATE ExpenseRule SET name=?, platform=?, type=?, value=?, categoryName=?, minPrice=?, maxPrice=? WHERE id=?`,
    [d.name, d.platform, d.type, d.value, d.categoryName, d.minPrice, d.maxPrice, id]
  );
}

export async function deleteExpenseRule(id: string): Promise<void> {
  await execute(`DELETE FROM ExpenseRule WHERE id=?`, [id]);
}

export async function setExpenseRuleActive(id: string, active: boolean): Promise<void> {
  await execute(`UPDATE ExpenseRule SET isActive=? WHERE id=?`, [active ? 1 : 0, id]);
}

/** AppSetting key güncelle/ekle (KDV oranı, komisyon vb.). */
export async function updateSetting(key: string, value: string): Promise<void> {
  await execute(
    `INSERT INTO AppSetting (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

// ===================== KOMİSYON KURALLARI =====================

export interface CommissionRuleFull {
  id: string;
  name: string;
  categoryName: string | null;
  minPrice: number;
  maxPrice: number;
  commissionRate: number; // kesir (0.21)
  fixedCommission: number;
  priority: number;
  isActive: number;
}

export interface CommissionDraft {
  name: string;
  categoryName: string | null;
  commissionRate: number; // kesir
  fixedCommission: number;
  minPrice: number;
  maxPrice: number;
}

export async function getAllCommissionRules(): Promise<CommissionRuleFull[]> {
  return query<CommissionRuleFull>(
    `SELECT id, name, categoryName, minPrice, maxPrice, commissionRate, fixedCommission, priority, isActive
       FROM CommissionRule ORDER BY priority DESC, name ASC`
  );
}

export async function createCommissionRule(d: CommissionDraft): Promise<void> {
  await execute(
    `INSERT INTO CommissionRule (id, name, categoryName, minPrice, maxPrice, commissionRate, fixedCommission, priority, isActive)
     VALUES (?, ?, ?, ?, ?, ?, ?, 10, 1)`,
    [newId(), d.name, d.categoryName, d.minPrice, d.maxPrice, d.commissionRate, d.fixedCommission]
  );
}

export async function updateCommissionRule(id: string, d: CommissionDraft): Promise<void> {
  await execute(
    `UPDATE CommissionRule SET name=?, categoryName=?, minPrice=?, maxPrice=?, commissionRate=?, fixedCommission=? WHERE id=?`,
    [d.name, d.categoryName, d.minPrice, d.maxPrice, d.commissionRate, d.fixedCommission, id]
  );
}

export async function deleteCommissionRule(id: string): Promise<void> {
  await execute(`DELETE FROM CommissionRule WHERE id=?`, [id]);
}

export async function setCommissionRuleActive(id: string, active: boolean): Promise<void> {
  await execute(`UPDATE CommissionRule SET isActive=? WHERE id=?`, [active ? 1 : 0, id]);
}

// ===================== KARGO KURALLARI =====================

export interface CargoRuleFull {
  id: string;
  name: string;
  platform: string | null;
  categoryName: string | null;
  minPrice: number;
  maxPrice: number;
  minDesi: number;
  maxDesi: number;
  cargoCost: number;
  priority: number;
  isActive: number;
}

export interface CargoDraft {
  name: string;
  platform: string | null;
  minDesi: number;
  maxDesi: number;
  minPrice: number;
  maxPrice: number;
  cargoCost: number;
}

export async function getAllCargoRules(): Promise<CargoRuleFull[]> {
  return query<CargoRuleFull>(
    `SELECT id, name, platform, categoryName, minPrice, maxPrice, minDesi, maxDesi, cargoCost, priority, isActive
       FROM CargoRule ORDER BY platform, minDesi ASC`
  );
}

export async function createCargoRule(d: CargoDraft): Promise<void> {
  await execute(
    `INSERT INTO CargoRule (id, name, platform, minPrice, maxPrice, minDesi, maxDesi, cargoCost, priority, isActive)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 10, 1)`,
    [newId(), d.name, d.platform, d.minPrice, d.maxPrice, d.minDesi, d.maxDesi, d.cargoCost]
  );
}

export async function updateCargoRule(id: string, d: CargoDraft): Promise<void> {
  await execute(
    `UPDATE CargoRule SET name=?, platform=?, minPrice=?, maxPrice=?, minDesi=?, maxDesi=?, cargoCost=? WHERE id=?`,
    [d.name, d.platform, d.minPrice, d.maxPrice, d.minDesi, d.maxDesi, d.cargoCost, id]
  );
}

export async function deleteCargoRule(id: string): Promise<void> {
  await execute(`DELETE FROM CargoRule WHERE id=?`, [id]);
}

export async function setCargoRuleActive(id: string, active: boolean): Promise<void> {
  await execute(`UPDATE CargoRule SET isActive=? WHERE id=?`, [active ? 1 : 0, id]);
}
