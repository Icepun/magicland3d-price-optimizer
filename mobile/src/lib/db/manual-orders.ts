import {
  MANUAL_ORDER_CALCULATION_VERSION,
  calculateManualOrder,
  type ManualOrderBreakdown,
  type ManualOrderCalculationInput,
  type ManualOrderMode,
  type ManualOrderMoneyCost,
  type ManualOrderResolvedItem,
  type ManualOrderStatusKind,
} from "@core/manual-order";
import { computeFullProductCost } from "@core/cost-calculator";
import { filterRulesByPlatform, findCargoRule } from "@core/cargo-calculator";
import { resolveVatableCost } from "@core/pricing-engine";
import type { CargoRuleInput } from "@core/types";

import { ensureCargoVatSchema, ensureManualOrderSchema } from "@/lib/db/schema";
import { tlToKurus } from "@/lib/db/finance";
import { batch, execute, query, type SqlValue } from "@/lib/turso";

interface ManualOrderRow {
  id: string;
  orderNumber: string;
  mode: string;
  orderedAt: string | number;
  statusKind: string;
  customerName: string | null;
  currency: string;
  revenueKurus: number;
  netRevenueKurus: number;
  totalCostKurus: number;
  inputVatCreditKurus: number;
  profitKurus: number | null;
  profitPartial: number | boolean;
  itemsJson: string;
  breakdownJson: string;
  calculationVersion: number;
  note: string | null;
  createdAt: string | number;
  updatedAt: string | number;
}

/**
 * Serbest kalemin üretim girdileri. Masaüstündeki `FreeformProductionSchema` ile BİREBİR
 * aynı alanlar — iki cihaz aynı satırı okuyup yazdığı için şekil sabittir.
 */
export interface ManualOrderProduction {
  filamentTypeId: string | null;
  filamentWeight: number | null;
  printTimeHours: number | null;
  wasteRate: number | null;
}

export type ManualOrderItem = ManualOrderResolvedItem & {
  kind?: ManualOrderMode;
  production?: ManualOrderProduction | null;
};

/** Çekirdek girdisinin kalem tipi genişletilmiş hâli (kayıtta `production` da taşınır). */
export type ManualOrderDraft = Omit<ManualOrderCalculationInput, "items"> & {
  items: ManualOrderItem[];
};

interface ItemsEnvelope {
  version: 1;
  items: ManualOrderItem[];
}

interface BreakdownEnvelope {
  version: 1;
  draft: ManualOrderDraft;
  breakdown: ManualOrderBreakdown;
}

export interface ManualOrder {
  id: string;
  orderNumber: string;
  mode: ManualOrderMode;
  orderedAt: string;
  statusKind: ManualOrderStatusKind;
  customerName: string | null;
  currency: "TRY";
  revenueKurus: number;
  netRevenueKurus: number;
  totalCostKurus: number;
  inputVatCreditKurus: number;
  profitKurus: number | null;
  profitPartial: boolean;
  items: ManualOrderItem[];
  draft: ManualOrderDraft;
  breakdown: ManualOrderBreakdown;
  calculationVersion: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManualOrderWriteInput {
  orderNumber?: string | null;
  orderedAt: string;
  statusKind: ManualOrderStatusKind;
  customerName?: string | null;
  note?: string | null;
  draft: ManualOrderDraft;
}

const STATUS_KINDS = new Set<ManualOrderStatusKind>([
  "pending",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
]);

const SELECT_COLUMNS = `
  "id", "orderNumber", "mode", "orderedAt", "statusKind", "customerName",
  "currency", "revenueKurus", "netRevenueKurus", "totalCostKurus",
  "inputVatCreditKurus", "profitKurus", "profitPartial", "itemsJson",
  "breakdownJson", "calculationVersion", "note", "createdAt", "updatedAt"
`;

function newId(prefix: string): string {
  return (
    prefix +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  );
}

function generatedOrderNumber(): string {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .replaceAll("-", "");
  return `M-${date}-${newId("").slice(-6).toUpperCase()}`;
}

function asIso(value: string | number): string {
  const numeric =
    typeof value === "number" ? value : /^\d+$/.test(String(value)) ? Number(value) : null;
  const date = new Date(
    numeric == null ? String(value) : numeric < 100_000_000_000 ? numeric * 1000 : numeric
  );
  if (!Number.isFinite(date.getTime())) throw new Error("Manuel sipariş tarihi geçersiz.");
  return date.toISOString();
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Manuel siparişin ${label} verisi okunamadı.`);
  }
}

function normalizeText(
  value: string | null | undefined,
  maxLength: number,
  label: string
): string | null {
  const normalized = value?.trim() || null;
  if (normalized && normalized.length > maxLength) {
    throw new Error(`${label} en fazla ${maxLength} karakter olabilir.`);
  }
  return normalized;
}

/* ------------------------------------------------------------------ *
 * Serbest (ürünsüz) siparişin maliyet + kargo çözümü
 *
 * Masaüstünde bunu sunucu yapıyor (lib/manual-orders.ts). Mobil doğrudan Turso'ya
 * yazdığı için AYNI çözümü burada tekrar eder; ekran da aynı yardımcıları çağırır,
 * böylece canlı önizleme ile kaydedilen rakam birebir aynıdır.
 * ------------------------------------------------------------------ */

export interface FreeformFilament {
  id: string;
  name: string;
  costPerGram: number;
  isActive: boolean;
}

export interface FreeformCostContext {
  settings: Record<string, string>;
  /** Tüm filament türleri; seçim listesi yalnız `isActive` olanları göstermeli. */
  filaments: FreeformFilament[];
  cargoRules: CargoRuleInput[];
}

function ruleDate(value: SqlValue): Date | null {
  if (value == null || value === "") return null;
  const numeric =
    typeof value === "number" ? value : /^\d+$/.test(String(value)) ? Number(value) : null;
  const date = new Date(
    numeric == null ? String(value) : numeric < 100_000_000_000 ? numeric * 1000 : numeric
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Ayarlar + filament fiyatları + kargo baremi: TEK round-trip. */
export async function getFreeformCostContext(): Promise<FreeformCostContext> {
  await ensureCargoVatSchema();
  const [settingRows, filamentRows, cargoRows] = await batch([
    { sql: `SELECT key, value FROM AppSetting` },
    { sql: `SELECT id, name, costPerGram, isActive FROM FilamentType ORDER BY name ASC` },
    {
      sql: `SELECT id, name, platform, cargoProvider, categoryName, minPrice, maxPrice,
                   minDesi, maxDesi, cargoCost, vatIncluded, validFrom, validTo, priority, isActive
              FROM CargoRule WHERE isActive = 1`,
    },
  ]);

  const settings: Record<string, string> = {};
  for (const row of settingRows.rows as unknown as { key: string; value: string }[]) {
    settings[row.key] = row.value;
  }

  const filaments = (
    filamentRows.rows as unknown as {
      id: string;
      name: string;
      costPerGram: number;
      isActive: number | boolean;
    }[]
  ).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    costPerGram: Number(row.costPerGram) || 0,
    isActive: Boolean(row.isActive),
  }));

  const cargoRules = (
    cargoRows.rows as unknown as (CargoRuleInput & {
      validFrom: SqlValue;
      validTo: SqlValue;
      vatIncluded: SqlValue;
    })[]
  ).map((row) => ({
    ...row,
    validFrom: ruleDate(row.validFrom),
    validTo: ruleDate(row.validTo),
    vatIncluded: row.vatIncluded == null ? true : Number(row.vatIncluded) !== 0,
  })) as CargoRuleInput[];

  return { settings, filaments, cargoRules };
}

/** Gramaj veya süre girilmişse maliyet motordan hesaplanır; aksi halde elle girilen tutar geçerlidir. */
export function hasProductionInput(
  production: ManualOrderProduction | null | undefined
): boolean {
  if (!production) return false;
  return (production.filamentWeight ?? 0) > 0 || (production.printTimeHours ?? 0) > 0;
}

/**
 * Serbest kalemin maliyeti — katalog ürünüyle AYNI motor
 * (filament ₺/g × gram + süre × [elektrik + makine aşınması + işçilik], üstüne fire payı).
 * Paketleme serbest kalemde hesaba katılmaz (katalog kalemine özel kapsam mantığı).
 */
export function resolveFreeformProduction(
  production: ManualOrderProduction | null | undefined,
  context: Pick<FreeformCostContext, "settings" | "filaments">
): { productionCost: number; filamentCost: number; costKnown: boolean } {
  if (!hasProductionInput(production)) {
    return { productionCost: 0, filamentCost: 0, costKnown: false };
  }
  const settings = context.settings;
  const costPerGram =
    context.filaments.find((item) => item.id === production!.filamentTypeId)?.costPerGram ?? 0;
  const calc = computeFullProductCost({
    filamentWeight: production!.filamentWeight ?? 0,
    costPerGram,
    printTimeHours: production!.printTimeHours ?? 0,
    electricityCostPerHour:
      settings.costElectricityIncluded === "true"
        ? Number(settings.costElectricityPerHour ?? 0)
        : 0,
    machineWearCostPerHour: Number(settings.costMachineWearPerHour ?? 0),
    laborCostPerHour: Number(settings.costLaborPerHour ?? 0),
    wasteRate: production!.wasteRate ?? 0,
    packagingCost: 0,
  });
  return {
    productionCost: calc.productionCost,
    filamentCost: calc.filamentCost,
    // Çekirdekteki `productionCostKnown` ile AYNI ölçüt (@core/product-cost): malzeme payı
    // yoksa maliyet BİLİNMİYOR. Masaüstüyle aynı kâr çıksın diye burada da uygulanır.
    costKnown: calc.productionCost > 0 && calc.filamentCost > 0,
  };
}

/**
 * Serbest siparişin kargosu: kalemlerin toplam desisinden (desi × adet) Shopify baremiyle çözülür.
 * Barem sipariş başına BİR KEZ uygulanır; çözülen tutar normal bir kargo bedeli olarak kaydedilir,
 * böylece o günkü tarife kayda donar.
 */
export function resolveFreeformCargo(
  items: ManualOrderItem[],
  saleTotal: number,
  vatRate: number,
  cargoRules: CargoRuleInput[],
  /** Siparişin KENDİ tarihi — kargo tarifesi buna göre seçilir (masaüstüyle aynı davranış). */
  orderedAt?: Date | null
): { cargo: ManualOrderMoneyCost; cargoDesi: number; cargoRuleMissing: boolean } {
  let totalDesi = 0;
  for (const item of items) {
    const desi = item.desi;
    if (desi != null && Number.isFinite(desi) && desi >= 0) {
      totalDesi += desi * Math.max(1, Math.trunc(item.quantity));
    }
  }
  const rule = findCargoRule(
    filterRulesByPlatform(cargoRules, "shopify"),
    Math.max(0, saleTotal),
    "",
    totalDesi || 1,
    orderedAt ?? undefined
  );
  const resolved = rule
    ? resolveVatableCost(rule.cargoCost, rule.vatIncluded !== false, vatRate)
    : { gross: 0, inputVat: 0 };
  return {
    cargo: { amount: resolved.gross, hasVatInvoice: !!rule },
    cargoDesi: totalDesi,
    cargoRuleMissing: !rule,
  };
}

/**
 * Serbest siparişin kalem maliyetlerini ve kargosunu güncel ayarlara göre yeniden çözer.
 * Ekran canlı önizlemede, kayıt yolu da yazmadan hemen önce bunu çağırır.
 */
export function applyFreeformResolution(
  draft: ManualOrderDraft,
  context: FreeformCostContext,
  /** Siparişin KENDİ tarihi — kargo tarifesi buna göre seçilir. Boşsa bugüne düşer. */
  orderedAt?: Date | null
): ManualOrderDraft {
  if (draft.mode !== "freeform") return draft;

  const items = draft.items.map((item): ManualOrderItem => {
    const production = item.production ?? null;
    if (hasProductionInput(production)) {
      const calc = resolveFreeformProduction(production, context);
      return {
        ...item,
        productId: null,
        imageUrl: null,
        costKnown: calc.costKnown,
        productionCost: calc.productionCost,
        packagingCost: 0,
        filamentCost: calc.filamentCost,
        packagingComponents: null,
        costSource: "detailed",
        desi: item.desi ?? null,
        production: {
          filamentTypeId: production!.filamentTypeId ?? null,
          filamentWeight: production!.filamentWeight ?? null,
          printTimeHours: production!.printTimeHours ?? null,
          wasteRate: production!.wasteRate ?? null,
        },
        manualUnitCost: null,
        manualCostHasVatInvoice: false,
      };
    }
    return {
      ...item,
      productId: null,
      imageUrl: null,
      costKnown: item.manualUnitCost != null,
      productionCost: 0,
      packagingCost: 0,
      filamentCost: 0,
      packagingComponents: null,
      costSource: "manual",
      desi: item.desi ?? null,
      production: null,
      manualUnitCost: item.manualUnitCost ?? null,
      manualCostHasVatInvoice: item.manualCostHasVatInvoice ?? false,
    };
  });

  const cargo = resolveFreeformCargo(
    items,
    draft.saleTotal,
    draft.vatRate,
    context.cargoRules,
    orderedAt ?? null
  );
  return {
    ...draft,
    items,
    cargo: cargo.cargo,
    cargoAuto: true,
    cargoDesi: cargo.cargoDesi,
    cargoRuleMissing: cargo.cargoRuleMissing,
  };
}

function validateProduction(production: ManualOrderProduction, itemName: string): void {
  const checks: [number | null | undefined, number, string][] = [
    [production.filamentWeight, 100_000, "filament gramajı"],
    [production.printTimeHours, 10_000, "baskı süresi"],
    [production.wasteRate, 1, "fire payı"],
  ];
  for (const [value, max, label] of checks) {
    if (value == null) continue;
    if (!Number.isFinite(value) || value < 0 || value > max) {
      throw new Error(`${itemName}: ${label} değerini kontrol edin.`);
    }
  }
}

function validateDraft(draft: ManualOrderDraft): void {
  if (draft.mode !== "catalog" && draft.mode !== "freeform") {
    throw new Error("Sipariş türü geçersiz.");
  }
  if (!Number.isFinite(draft.saleTotal) || draft.saleTotal < 0) {
    throw new Error("Satış tutarı negatif olamaz.");
  }
  if (!Number.isFinite(draft.vatRate) || draft.vatRate < 0 || draft.vatRate > 100) {
    throw new Error("KDV oranı 0 ile 100 arasında olmalı.");
  }
  for (const [label, amount] of [
    ["Komisyon", draft.commission.amount],
    ["Kargo", draft.cargo.amount],
  ] as const) {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`${label} tutarı negatif olamaz.`);
    }
  }
  if (draft.expenseRules.length > 100 || draft.customExpenses.length > 100) {
    throw new Error("Bir siparişte en fazla 100 ek gider olabilir.");
  }
  for (const expense of draft.expenseRules) {
    if (
      !expense.id.trim() ||
      !expense.name.trim() ||
      !Number.isFinite(expense.value) ||
      expense.value < 0 ||
      (expense.amount != null &&
        (!Number.isFinite(expense.amount) || expense.amount < 0))
    ) {
      throw new Error("Seçili gider kurallarından biri geçersiz.");
    }
  }
  for (const expense of draft.customExpenses) {
    if (
      !expense.id.trim() ||
      !expense.name.trim() ||
      !Number.isFinite(expense.amount) ||
      expense.amount < 0
    ) {
      throw new Error("Özel giderlerden biri geçersiz.");
    }
  }
  if (draft.items.length === 0) throw new Error("En az bir sipariş kalemi ekleyin.");
  if (draft.items.length > 250) throw new Error("Bir siparişte en fazla 250 kalem olabilir.");

  for (const item of draft.items) {
    if (!item.name.trim() || item.name.trim().length > 200) {
      throw new Error("Kalem adı 1-200 karakter olmalı.");
    }
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10_000) {
      throw new Error(`${item.name}: adet 1 ile 10.000 arasında olmalı.`);
    }
    const costs = [
      item.productionCost,
      item.packagingCost,
      item.filamentCost,
      ...(item.packagingComponents?.map((component) => component.cost) ?? []),
    ];
    if (costs.some((cost) => !Number.isFinite(cost) || cost < 0)) {
      throw new Error(`${item.name}: maliyet negatif olamaz.`);
    }
    if (
      item.manualUnitCost != null &&
      (!Number.isFinite(item.manualUnitCost) || item.manualUnitCost < 0)
    ) {
      throw new Error(`${item.name}: birim maliyet negatif olamaz.`);
    }
    if (
      item.desi != null &&
      (!Number.isFinite(item.desi) || item.desi < 0 || item.desi > 999)
    ) {
      throw new Error(`${item.name}: desi 0 ile 999 arasında olmalı.`);
    }
    if (item.production) validateProduction(item.production, item.name.trim() || "Sipariş kalemi");
  }
}

function rowToManualOrder(row: ManualOrderRow): ManualOrder {
  const itemsEnvelope = parseJson<ItemsEnvelope>(row.itemsJson, "kalem");
  const breakdownEnvelope = parseJson<BreakdownEnvelope>(row.breakdownJson, "hesap");
  if (
    itemsEnvelope.version !== 1 ||
    !Array.isArray(itemsEnvelope.items) ||
    breakdownEnvelope.version !== 1 ||
    !breakdownEnvelope.draft ||
    !breakdownEnvelope.breakdown
  ) {
    throw new Error("Manuel sipariş veri sürümü desteklenmiyor.");
  }
  if (row.mode !== "catalog" && row.mode !== "freeform") {
    throw new Error("Manuel sipariş türü desteklenmiyor.");
  }
  if (!STATUS_KINDS.has(row.statusKind as ManualOrderStatusKind)) {
    throw new Error("Manuel sipariş durumu desteklenmiyor.");
  }

  return {
    id: row.id,
    orderNumber: row.orderNumber,
    mode: row.mode,
    orderedAt: asIso(row.orderedAt),
    statusKind: row.statusKind as ManualOrderStatusKind,
    customerName: row.customerName,
    currency: "TRY",
    revenueKurus: Number(row.revenueKurus) || 0,
    netRevenueKurus: Number(row.netRevenueKurus) || 0,
    totalCostKurus: Number(row.totalCostKurus) || 0,
    inputVatCreditKurus: Number(row.inputVatCreditKurus) || 0,
    profitKurus: row.profitKurus == null ? null : Number(row.profitKurus),
    profitPartial: Boolean(row.profitPartial),
    items: itemsEnvelope.items,
    draft: breakdownEnvelope.draft,
    breakdown: breakdownEnvelope.breakdown,
    calculationVersion: Number(row.calculationVersion) || 1,
    note: row.note,
    createdAt: asIso(row.createdAt),
    updatedAt: asIso(row.updatedAt),
  };
}

async function normalizedWrite(input: ManualOrderWriteInput) {
  validateDraft(input.draft);
  if (!STATUS_KINDS.has(input.statusKind)) throw new Error("Sipariş durumu geçersiz.");
  const orderedAt = asIso(input.orderedAt);
  const customerName = normalizeText(input.customerName, 160, "Müşteri adı");
  const note = normalizeText(input.note, 1_000, "Not");
  const requestedOrderNumber = normalizeText(input.orderNumber, 80, "Sipariş numarası");
  // Serbest siparişte maliyet ve kargo, yazmadan hemen önce güncel ayar/barem ile çözülür.
  const resolvedDraft =
    input.draft.mode === "freeform"
      ? applyFreeformResolution(input.draft, await getFreeformCostContext(), new Date(orderedAt))
      : input.draft;
  const storedItems: ManualOrderItem[] = resolvedDraft.items.map((item) => ({
    ...item,
    kind: resolvedDraft.mode,
  }));
  const storedDraft: ManualOrderDraft = {
    ...resolvedDraft,
    items: storedItems,
  };
  const breakdown = calculateManualOrder(storedDraft);
  const itemsJson = JSON.stringify({
    version: 1,
    items: storedItems,
  } satisfies ItemsEnvelope);
  const breakdownJson = JSON.stringify({
    version: 1,
    draft: storedDraft,
    breakdown,
  } satisfies BreakdownEnvelope);

  return {
    orderedAt,
    customerName,
    note,
    orderNumber: requestedOrderNumber,
    breakdown,
    itemsJson,
    breakdownJson,
  };
}

export async function getManualOrdersSince(cutoffMs: number): Promise<ManualOrder[]> {
  await ensureManualOrderSchema();
  const cutoff = new Date(cutoffMs).toISOString();
  const rows = await query<ManualOrderRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM "ManualOrder"
      WHERE "orderedAt" >= ?
      ORDER BY "orderedAt" DESC, "createdAt" DESC`,
    [cutoff]
  );
  const orders: ManualOrder[] = [];
  for (const row of rows) {
    try {
      orders.push(rowToManualOrder(row));
    } catch (error) {
      console.warn(`Bozuk manuel sipariş atlandı (${row.id}).`, error);
    }
  }
  return orders;
}

export async function getManualOrder(id: string): Promise<ManualOrder | null> {
  await ensureManualOrderSchema();
  const rows = await query<ManualOrderRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM "ManualOrder"
      WHERE "id" = ?
      LIMIT 1`,
    [id]
  );
  return rows[0] ? rowToManualOrder(rows[0]) : null;
}

export async function createManualOrder(input: ManualOrderWriteInput): Promise<string> {
  await ensureManualOrderSchema();
  const normalized = await normalizedWrite(input);
  const id = newId("mo_");
  const orderNumber = normalized.orderNumber ?? generatedOrderNumber();
  const now = new Date().toISOString();
  await execute(
    `INSERT INTO "ManualOrder" (
       "id", "orderNumber", "mode", "orderedAt", "statusKind", "customerName",
       "currency", "revenueKurus", "netRevenueKurus", "totalCostKurus",
       "inputVatCreditKurus", "profitKurus", "profitPartial", "itemsJson",
       "breakdownJson", "calculationVersion", "note", "createdAt", "updatedAt"
     ) VALUES (?, ?, ?, ?, ?, ?, 'TRY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      orderNumber,
      input.draft.mode,
      normalized.orderedAt,
      input.statusKind,
      normalized.customerName,
      tlToKurus(normalized.breakdown.grossRevenue),
      tlToKurus(normalized.breakdown.netRevenue),
      tlToKurus(normalized.breakdown.totalCost),
      tlToKurus(normalized.breakdown.inputVatCredit),
      normalized.breakdown.netProfit == null
        ? null
        : tlToKurus(normalized.breakdown.netProfit),
      normalized.breakdown.profitPartial,
      normalized.itemsJson,
      normalized.breakdownJson,
      MANUAL_ORDER_CALCULATION_VERSION,
      normalized.note,
      now,
      now,
    ]
  );
  return id;
}

export async function updateManualOrder(
  id: string,
  input: ManualOrderWriteInput
): Promise<void> {
  await ensureManualOrderSchema();
  const normalized = await normalizedWrite(input);
  const current = await getManualOrder(id);
  if (!current) throw new Error("Manuel sipariş bulunamadı.");
  const result = await execute(
    `UPDATE "ManualOrder"
        SET "orderNumber" = ?, "mode" = ?, "orderedAt" = ?, "statusKind" = ?,
            "customerName" = ?, "currency" = 'TRY', "revenueKurus" = ?,
            "netRevenueKurus" = ?, "totalCostKurus" = ?, "inputVatCreditKurus" = ?,
            "profitKurus" = ?, "profitPartial" = ?, "itemsJson" = ?,
            "breakdownJson" = ?, "calculationVersion" = ?, "note" = ?, "updatedAt" = ?
      WHERE "id" = ?`,
    [
      normalized.orderNumber ?? current.orderNumber,
      input.draft.mode,
      normalized.orderedAt,
      input.statusKind,
      normalized.customerName,
      tlToKurus(normalized.breakdown.grossRevenue),
      tlToKurus(normalized.breakdown.netRevenue),
      tlToKurus(normalized.breakdown.totalCost),
      tlToKurus(normalized.breakdown.inputVatCredit),
      normalized.breakdown.netProfit == null
        ? null
        : tlToKurus(normalized.breakdown.netProfit),
      normalized.breakdown.profitPartial,
      normalized.itemsJson,
      normalized.breakdownJson,
      MANUAL_ORDER_CALCULATION_VERSION,
      normalized.note,
      new Date().toISOString(),
      id,
    ]
  );
  if (result.rowsAffected === 0) throw new Error("Manuel sipariş bulunamadı.");
}

export async function deleteManualOrder(id: string): Promise<void> {
  await ensureManualOrderSchema();
  const result = await execute(`DELETE FROM "ManualOrder" WHERE "id" = ?`, [id]);
  if (result.rowsAffected === 0) throw new Error("Manuel sipariş bulunamadı.");
}
