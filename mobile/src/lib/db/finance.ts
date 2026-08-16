import { batch, execute, query } from "@/lib/turso";
import { ensureFinanceSchema, ensureManualOrderSchema } from "@/lib/db/schema";
import { FINANCE_CALCULATION_VERSION } from "@core/finance-version";

const ISTANBUL_TZ = "Europe/Istanbul";

export interface OrderFinanceSnapshotInput {
  platform: string;
  externalOrderId: string;
  orderNumber: string;
  orderedAt: number | string | Date;
  revenue: number;
  profit: number | null;
  profitPartial: boolean;
  statusKind: string;
  currency?: string;
  /** "platform" = Trendyol GERÇEK komisyonuyla düzeltilmiş kâr (masaüstüyle aynı anlam). */
  profitSource?: "calculated" | "platform";
  estimatedCommission?: number;
  actualCommission?: number | null;
}

export interface ActualExpense {
  id: string;
  name: string;
  category: string | null;
  amountKurus: number;
  paidAt: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActualExpenseInput {
  name: string;
  category?: string | null;
  amountKurus: number;
  paidAt: string;
  note?: string | null;
}

export interface MonthlyFinance {
  month: string;
  label: string;
  revenueKurus: number;
  orderProfitKurus: number;
  expensesKurus: number;
  netProfitKurus: number;
  orderCount: number;
  unknownProfitOrders: number;
  partialProfitOrders: number;
  incompleteOrders: number;
  unsupportedCurrencyOrders: number;
}

export interface MonthlyFinanceSummary {
  periods: MonthlyFinance[];
  historyStartedAt: string | null;
  lastSyncedAt: string | null;
}

interface SnapshotRow {
  orderedAt: string | number;
  revenueKurus: number;
  profitKurus: number | null;
  profitPartial: number | boolean;
  statusKind: string;
  currency: string;
  syncedAt: string | number;
}

interface ExpenseRow {
  paidAt: string | number;
  amountKurus: number;
}

interface ManualFinanceRow extends SnapshotRow {
  syncedAt: string | number;
}

function genId(prefix: string): string {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function tlToKurus(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Geçersiz para tutarı.");
  const sign = value < 0 ? -1 : 1;
  const [coefficient, exponent = "0"] = Math.abs(value).toString().split("e");
  const shifted = Number(`${coefficient}e${Number(exponent) + 2}`);
  const rounded = Math.round(shifted);
  const maxMagnitude = sign < 0 ? 2_147_483_648 : 2_147_483_647;
  if (!Number.isSafeInteger(rounded) || rounded > maxMagnitude) {
    throw new Error("Para tutarı desteklenen sınırı aşıyor.");
  }
  return sign * rounded;
}

function validateExpenseInput(input: ActualExpenseInput): void {
  if (!input.name.trim() || input.name.trim().length > 120) {
    throw new Error("Gider adı 1-120 karakter olmalı.");
  }
  if (
    !Number.isSafeInteger(input.amountKurus) ||
    input.amountKurus <= 0 ||
    input.amountKurus > 2_147_483_647
  ) {
    throw new Error("Gider tutarı geçersiz.");
  }
  if (!Number.isFinite(asDate(input.paidAt).getTime())) {
    throw new Error("Ödeme tarihi geçersiz.");
  }
  if ((input.category?.trim().length ?? 0) > 60) {
    throw new Error("Kategori en fazla 60 karakter olabilir.");
  }
  if ((input.note?.trim().length ?? 0) > 500) {
    throw new Error("Not en fazla 500 karakter olabilir.");
  }
}

function asDate(value: string | number | Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") {
    return new Date(value < 100_000_000_000 ? value * 1000 : value);
  }
  const numeric = /^\d+$/.test(value) ? Number(value) : null;
  return new Date(
    numeric == null ? value : numeric < 100_000_000_000 ? numeric * 1000 : numeric
  );
}

function monthKey(value: string | number | Date): string | null {
  const date = asDate(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ISTANBUL_TZ,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : null;
}

function currentMonthParts(now: Date): { year: number; month: number } {
  const key = monthKey(now) ?? now.toISOString().slice(0, 7);
  const [year, month] = key.split("-").map(Number);
  return { year, month };
}

function lastMonthKeys(count: number, now = new Date()): string[] {
  const { year, month } = currentMonthParts(now);
  const keys: string[] = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const serial = year * 12 + (month - 1) - offset;
    keys.push(`${Math.floor(serial / 12)}-${String((serial % 12) + 1).padStart(2, "0")}`);
  }
  return keys;
}

function monthLabel(key: string): string {
  return new Intl.DateTimeFormat("tr-TR", {
    month: "short",
    year: "2-digit",
    timeZone: ISTANBUL_TZ,
  }).format(new Date(`${key}-15T12:00:00.000Z`));
}

function isoOrNull(value: string | number | undefined): string | null {
  if (value == null) return null;
  const date = asDate(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * "Yakalanmış kârın üzerine yaz" koşulu — masaüstündeki shouldReplaceCapturedProfit
 * (src/lib/order-finance-snapshots.ts) ile BİREBİR aynı 4 madde:
 *   1) gelir değişti (iade / sipariş düzenleme)
 *   2) kâr ilk kez hesaplanabildi (NULL → değer)
 *   3) platform GERÇEK komisyonu geldi ya da tutarı değişti  ← mobilde EKSİKTİ
 *   4) kısmi hesap tamamlandı
 *   5) satır ESKİ hesap sürümüyle yazılmış — v4: telefonun reklam payı DÜŞÜLMEDEN kaydettiği
 *      kârlar yukarıdaki dört koşulun hiçbirine girmediği için asla düzelmiyordu
 *      (bkz. core/finance-version.ts). Tek seferlik yeniden yazmayı bu madde açar.
 * Değiştirirken masaüstü karşılığını da güncelle; parite testi ikisini karşılaştırır.
 */
const REPLACE_PROFIT_SQL = `
  "OrderFinanceSnapshot"."revenueKurus" <> excluded."revenueKurus"
  OR ("OrderFinanceSnapshot"."profitKurus" IS NULL AND excluded."profitKurus" IS NOT NULL)
  OR (excluded."profitSource" = 'platform'
      AND (COALESCE("OrderFinanceSnapshot"."profitSource", 'calculated') <> 'platform'
           OR "OrderFinanceSnapshot"."actualCommissionKurus" IS NOT excluded."actualCommissionKurus"))
  OR ("OrderFinanceSnapshot"."profitPartial" = 1
      AND excluded."profitPartial" = 0
      AND excluded."profitKurus" IS NOT NULL)
  OR COALESCE("OrderFinanceSnapshot"."calculationVersion", 0) < ${FINANCE_CALCULATION_VERSION}
`;

/** Erişilebilen platform verisini kuruş cinsinden kalıcı finans geçmişine işler. */
export async function syncOrderFinanceSnapshots(
  snapshots: OrderFinanceSnapshotInput[]
): Promise<void> {
  await ensureFinanceSchema();
  if (snapshots.length === 0) return;

  // DEĞİŞEN-ONLY: Raporlar ekranı her açılışta (ve her kural/ayar tazelemesinde) 60 GÜNLÜK
  // tüm siparişleri yeniden yazıyordu — telefondan uzak Turso'ya yüzlerce gereksiz yazma.
  // Önce mevcut satırları TEK sorguda oku, birebir aynı olanları atla.
  // (Masaüstündeki persistOrderFinanceSnapshots ile aynı yaklaşım.)
  const existing = new Map<string, { rev: number; profit: number | null; partial: number; status: string; cur: string; src: string; est: number | null; act: number | null }>();
  try {
    const rows = await query<{
      platform: string; externalOrderId: string; revenueKurus: number; profitKurus: number | null;
      profitPartial: number; statusKind: string; currency: string;
      profitSource: string | null; estimatedCommissionKurus: number | null; actualCommissionKurus: number | null;
    }>(
      `SELECT platform, externalOrderId, revenueKurus, profitKurus, profitPartial, statusKind,
              currency, profitSource, estimatedCommissionKurus, actualCommissionKurus
         FROM "OrderFinanceSnapshot"`
    );
    for (const r of rows) {
      existing.set(`${r.platform}\u0000${r.externalOrderId}`, {
        rev: Number(r.revenueKurus), profit: r.profitKurus == null ? null : Number(r.profitKurus),
        partial: Number(r.profitPartial), status: String(r.statusKind), cur: String(r.currency),
        src: String(r.profitSource ?? "calculated"),
        est: r.estimatedCommissionKurus == null ? null : Number(r.estimatedCommissionKurus),
        act: r.actualCommissionKurus == null ? null : Number(r.actualCommissionKurus),
      });
    }
  } catch {
    // Okuma başarısızsa (ör. kolon henüz yok) hepsini yaz — eski davranış, veri kaybı yok.
  }

  const changed = snapshots.filter((s) => {
    const e = existing.get(`${s.platform}\u0000${s.externalOrderId}`);
    if (!e) return true;
    return (
      e.rev !== tlToKurus(s.revenue) ||
      e.profit !== (s.profit == null ? null : tlToKurus(s.profit)) ||
      e.partial !== (s.profitPartial ? 1 : 0) ||
      e.status !== s.statusKind ||
      e.cur !== (s.currency ?? "TRY") ||
      e.src !== (s.profitSource ?? "calculated") ||
      e.est !== (s.estimatedCommission == null ? null : tlToKurus(s.estimatedCommission)) ||
      e.act !== (s.actualCommission == null ? null : tlToKurus(s.actualCommission))
    );
  });
  if (changed.length === 0) return;

  const now = new Date().toISOString();
  const statements = changed
    .filter((snapshot) => snapshot.platform !== "manual")
    .filter((snapshot) => Number.isFinite(asDate(snapshot.orderedAt).getTime()))
    .map((snapshot) => ({
      // DEĞİŞTİRME KOŞULU masaüstündeki shouldReplaceCapturedProfit ile BİREBİR olmalı
      // (src/lib/order-finance-snapshots.ts). Eskiden mobilde "platform kaynaklı kâr" maddesi
      // YOKTU ve profitSource/komisyon kolonlarına hiç yazılmıyordu → mobil, masaüstünün gerçek
      // komisyonlu kârını sessizce tahminî değerle ezebiliyordu. Tek yerde tanımlı REPLACE ifadesi:
      sql: `INSERT INTO "OrderFinanceSnapshot"
              ("id", "platform", "externalOrderId", "orderNumber", "orderedAt",
               "revenueKurus", "profitKurus", "profitPartial", "statusKind",
               "currency", "syncedAt", "calculationVersion",
               "profitSource", "estimatedCommissionKurus", "actualCommissionKurus")
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT ("platform", "externalOrderId") DO UPDATE SET
              "orderNumber" = excluded."orderNumber",
              "orderedAt" = excluded."orderedAt",
              "profitKurus" = CASE WHEN ${REPLACE_PROFIT_SQL}
                THEN excluded."profitKurus" ELSE "OrderFinanceSnapshot"."profitKurus" END,
              "profitPartial" = CASE WHEN ${REPLACE_PROFIT_SQL}
                THEN excluded."profitPartial" ELSE "OrderFinanceSnapshot"."profitPartial" END,
              "calculationVersion" = CASE WHEN ${REPLACE_PROFIT_SQL}
                THEN excluded."calculationVersion" ELSE "OrderFinanceSnapshot"."calculationVersion" END,
              "profitSource" = CASE WHEN ${REPLACE_PROFIT_SQL}
                THEN excluded."profitSource" ELSE "OrderFinanceSnapshot"."profitSource" END,
              "estimatedCommissionKurus" = CASE WHEN ${REPLACE_PROFIT_SQL}
                THEN excluded."estimatedCommissionKurus" ELSE "OrderFinanceSnapshot"."estimatedCommissionKurus" END,
              "actualCommissionKurus" = CASE WHEN ${REPLACE_PROFIT_SQL}
                THEN excluded."actualCommissionKurus" ELSE "OrderFinanceSnapshot"."actualCommissionKurus" END,
              "revenueKurus" = excluded."revenueKurus",
              "statusKind" = excluded."statusKind",
              "currency" = excluded."currency",
              "syncedAt" = excluded."syncedAt"`,
      args: [
        `ofs:${snapshot.platform}:${snapshot.externalOrderId}`,
        snapshot.platform,
        snapshot.externalOrderId,
        snapshot.orderNumber,
        // ⚠️ TARİHLER DAİMA ISO-8601 METİN. Masaüstü de aynı biçimi yazar (src/lib/sqlite-date.ts).
        // Buraya epoch-ms sayı yazılırsa SQLite'ta tamsayı < metin olduğu için masaüstünün
        // `orderedAt >= …` filtresi bu satırları sessizce eler ve Raporlar eksik çıkar.
        asDate(snapshot.orderedAt).toISOString(),
        tlToKurus(snapshot.revenue),
        snapshot.profit == null ? null : tlToKurus(snapshot.profit),
        snapshot.profitPartial,
        snapshot.statusKind,
        snapshot.currency ?? "TRY",
        now,
        FINANCE_CALCULATION_VERSION,
        snapshot.profitSource ?? "calculated",
        snapshot.estimatedCommission == null ? null : tlToKurus(snapshot.estimatedCommission),
        snapshot.actualCommission == null ? null : tlToKurus(snapshot.actualCommission),
      ],
    }));
  for (let offset = 0; offset < statements.length; offset += 50) {
    await batch(statements.slice(offset, offset + 50));
  }
}

export async function getActualExpenses(): Promise<ActualExpense[]> {
  await ensureFinanceSchema();
  return query<ActualExpense>(
    `SELECT "id", "name", "category", "amountKurus", "paidAt", "note", "createdAt", "updatedAt"
       FROM "ActualExpense"
      ORDER BY "paidAt" DESC, "createdAt" DESC`
  );
}

export async function createActualExpense(input: ActualExpenseInput): Promise<void> {
  await ensureFinanceSchema();
  validateExpenseInput(input);
  const now = new Date().toISOString();
  await execute(
    `INSERT INTO "ActualExpense"
       ("id", "name", "category", "amountKurus", "paidAt", "note", "createdAt", "updatedAt")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      genId("ae:"),
      input.name.trim(),
      input.category?.trim() || null,
      Math.round(input.amountKurus),
      input.paidAt,
      input.note?.trim() || null,
      now,
      now,
    ]
  );
}

export async function updateActualExpense(
  id: string,
  input: ActualExpenseInput
): Promise<void> {
  await ensureFinanceSchema();
  validateExpenseInput(input);
  await execute(
    `UPDATE "ActualExpense"
        SET "name" = ?, "category" = ?, "amountKurus" = ?, "paidAt" = ?,
            "note" = ?, "updatedAt" = ?
      WHERE "id" = ?`,
    [
      input.name.trim(),
      input.category?.trim() || null,
      Math.round(input.amountKurus),
      input.paidAt,
      input.note?.trim() || null,
      new Date().toISOString(),
      id,
    ]
  );
}

export async function deleteActualExpense(id: string): Promise<void> {
  await ensureFinanceSchema();
  await execute(`DELETE FROM "ActualExpense" WHERE "id" = ?`, [id]);
}

export async function getMonthlyFinanceSummary(
  monthCount = 12,
  now = new Date()
): Promise<MonthlyFinanceSummary> {
  await Promise.all([ensureFinanceSchema(), ensureManualOrderSchema()]);
  const [snapshots, manualOrders, expenses] = await Promise.all([
    query<SnapshotRow>(
      `SELECT "orderedAt", "revenueKurus", "profitKurus", "profitPartial",
              "statusKind", "currency", "syncedAt"
         FROM "OrderFinanceSnapshot"
        WHERE "platform" <> 'manual'
        ORDER BY "orderedAt" ASC`
    ),
    query<ManualFinanceRow>(
      `SELECT "orderedAt", "revenueKurus", "profitKurus", "profitPartial",
              "statusKind", "currency", "updatedAt" AS "syncedAt"
         FROM "ManualOrder"
        ORDER BY "orderedAt" ASC`
    ),
    query<ExpenseRow>(
      `SELECT "paidAt", "amountKurus"
         FROM "ActualExpense"
        ORDER BY "paidAt" ASC`
    ),
  ]);

  const keys = lastMonthKeys(Math.max(1, Math.min(24, monthCount)), now);
  const byMonth = new Map<string, MonthlyFinance>(
    keys.map((key) => [
      key,
      {
        month: key,
        label: monthLabel(key),
        revenueKurus: 0,
        orderProfitKurus: 0,
        expensesKurus: 0,
        netProfitKurus: 0,
        orderCount: 0,
        unknownProfitOrders: 0,
        partialProfitOrders: 0,
        incompleteOrders: 0,
        unsupportedCurrencyOrders: 0,
      },
    ])
  );

  const financeOrders: SnapshotRow[] = [...snapshots, ...manualOrders];
  for (const snapshot of financeOrders) {
    if (snapshot.statusKind === "cancelled") continue;
    const bucket = byMonth.get(monthKey(snapshot.orderedAt) ?? "");
    if (!bucket) continue;
    if ((snapshot.currency || "TRY").trim().toUpperCase() !== "TRY") {
      bucket.unsupportedCurrencyOrders++;
      continue;
    }
    bucket.revenueKurus += Number(snapshot.revenueKurus) || 0;
    bucket.orderCount++;
    if (snapshot.profitKurus == null) bucket.unknownProfitOrders++;
    else bucket.orderProfitKurus += Number(snapshot.profitKurus) || 0;
    if (!!snapshot.profitPartial) bucket.partialProfitOrders++;
    if (snapshot.profitKurus == null || !!snapshot.profitPartial) bucket.incompleteOrders++;
  }
  for (const expense of expenses) {
    const bucket = byMonth.get(monthKey(expense.paidAt) ?? "");
    if (bucket) bucket.expensesKurus += Number(expense.amountKurus) || 0;
  }

  const periods = keys.map((key) => {
    const bucket = byMonth.get(key)!;
    bucket.netProfitKurus = bucket.orderProfitKurus - bucket.expensesKurus;
    return bucket;
  });
  return {
    periods,
    historyStartedAt:
      financeOrders.reduce<string | null>((earliest, snapshot) => {
        const iso = isoOrNull(snapshot.orderedAt);
        return !iso || (earliest && earliest <= iso) ? earliest : iso;
      }, null),
    lastSyncedAt:
      financeOrders.reduce<string | null>((latest, snapshot) => {
        const iso = isoOrNull(snapshot.syncedAt);
        return !iso || (latest && latest >= iso) ? latest : iso;
      }, null),
  };
}
