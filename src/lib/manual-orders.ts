import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { resolveProductCost } from "@/core/product-cost";
import {
  calculateManualOrder,
  MANUAL_ORDER_CALCULATION_VERSION,
  type ManualOrderCalculationInput,
  type ManualOrderBreakdown,
  type ManualOrderCustomExpense,
  type ManualOrderResolvedItem,
  type ManualOrderSelectedExpense,
  type ManualOrderStatusKind,
} from "@/core/manual-order";
import { kurusToTl, tlToKurus } from "@/lib/monthly-finance";
import type { PackagingBreakdown } from "@/core/packaging";

const MAX_TL = 21_474_836.47;
const money = z.number().finite().min(0).max(MAX_TL);
const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional();

const ManualMoneyCostSchema = z.object({
  amount: money,
  hasVatInvoice: z.boolean(),
});

const ManualExpenseSelectionSchema = z.object({
  ruleId: z.string().trim().min(1),
  hasVatInvoice: z.boolean(),
});

const ManualCustomExpenseSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).max(120),
  amount: money,
  hasVatInvoice: z.boolean(),
});

const CatalogItemSchema = z.object({
  id: z.string().trim().min(1).optional(),
  productId: z.string().trim().min(1),
  quantity: z.number().int().min(1).max(10_000),
});

const FreeformItemSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(1).max(10_000),
  unitCost: money.nullable(),
  manualCostHasVatInvoice: z.boolean().optional().default(false),
});

const StoredPackagingComponentSchema = z.object({
  key: z.enum(["option", "nylon", "tape", "card", "sticker", "sakiz"]),
  scope: z.enum(["per_unit", "per_order", "per_shipment"]),
  cost: money,
});

/**
 * Mobile v1 rows intentionally do not require `kind`. The row mode and
 * productId are sufficient to distinguish catalog/freeform items.
 */
const ManualOrderStoredItemSchema = z
  .object({
    id: z.string().trim().min(1),
    productId: z.string().trim().min(1).nullable(),
    name: z.string().trim().min(1).max(200),
    imageUrl: z.string().nullable(),
    quantity: z.number().int().min(1).max(10_000),
    costKnown: z.boolean(),
    productionCost: money,
    packagingCost: money,
    filamentCost: money,
    packagingComponents: z
      .array(StoredPackagingComponentSchema)
      .max(100)
      .nullable()
      .optional(),
    manualUnitCost: money.nullable().optional(),
    manualCostHasVatInvoice: z.boolean().optional(),
    kind: z.enum(["catalog", "freeform"]).optional(),
    alias: z.string().nullable().optional(),
    variantLabel: z.string().nullable().optional(),
    currentSalePrice: money.nullable().optional(),
  })
  .passthrough();

const StoredSelectedExpenseSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).max(120),
    type: z.enum(["fixed", "percentage", "per_order"]),
    value: money,
    amount: money.optional(),
    hasVatInvoice: z.boolean(),
  })
  .passthrough();

const StoredCustomExpenseSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).max(120),
    amount: money,
    hasVatInvoice: z.boolean(),
  })
  .passthrough();

const ManualOrderCalculationInputSchema = z
  .object({
    saleTotal: money,
    vatRate: z.number().finite().min(0).max(100),
    mode: z.enum(["catalog", "freeform"]),
    items: z.array(ManualOrderStoredItemSchema).min(1).max(250),
    includeProductCost: z.boolean(),
    includePackaging: z.boolean(),
    commission: ManualMoneyCostSchema,
    cargo: ManualMoneyCostSchema,
    expenseRules: z.array(StoredSelectedExpenseSchema).max(100),
    customExpenses: z.array(StoredCustomExpenseSchema).max(100),
  })
  .passthrough();

const nullableFinite = z.number().finite().nullable();
const ManualOrderBreakdownSchema = z
  .object({
    grossRevenue: money,
    netRevenue: money,
    outputVat: money,
    productCost: money,
    packagingCost: money,
    commissionCost: money,
    cargoCost: money,
    expenseRulesCost: money,
    customExpensesCost: money,
    totalCost: money,
    inputVatCredit: money,
    netProfit: nullableFinite,
    profitPartial: z.boolean(),
    missingCostItems: z.number().int().min(0).max(250),
    profitMargin: nullableFinite,
  })
  .passthrough();

const ManualOrderItemsEnvelopeSchema = z.object({
  version: z.literal(1),
  items: z.array(ManualOrderStoredItemSchema).min(1).max(250),
});

const ManualOrderBreakdownEnvelopeSchema = z.object({
  version: z.literal(1),
  draft: ManualOrderCalculationInputSchema,
  breakdown: ManualOrderBreakdownSchema,
});

export const ManualOrderInputSchema = z
  .object({
    orderedAt: z.coerce.date(),
    orderNumber: optionalText(80),
    customerName: optionalText(160),
    statusKind: z
      .enum(["pending", "processing", "shipped", "delivered", "cancelled"])
      .default("processing"),
    currency: z.literal("TRY").default("TRY"),
    saleTotal: money,
    note: optionalText(1_000),
    mode: z.enum(["catalog", "freeform"]),
    includeProductCost: z.boolean(),
    includePackaging: z.boolean(),
    commission: ManualMoneyCostSchema,
    cargo: ManualMoneyCostSchema,
    expenseRules: z.array(ManualExpenseSelectionSchema).max(100).default([]),
    customExpenses: z.array(ManualCustomExpenseSchema).max(100).default([]),
    items: z.array(z.union([CatalogItemSchema, FreeformItemSchema])).min(1).max(250),
  })
  .superRefine((value, ctx) => {
    const seenRules = new Set<string>();
    for (const rule of value.expenseRules) {
      if (seenRules.has(rule.ruleId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Aynı gider kuralı birden fazla seçilemez.",
          path: ["expenseRules"],
        });
      }
      seenRules.add(rule.ruleId);
    }

    const seenItemIds = new Set<string>();
    value.items.forEach((item, index) => {
      const isCatalog = "productId" in item;
      if (item.id && seenItemIds.has(item.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Aynı sipariş kalemi kimliği birden fazla kullanılamaz.",
          path: ["items", index, "id"],
        });
      }
      if (item.id) seenItemIds.add(item.id);
      if (value.mode === "catalog" && !isCatalog) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Katalog siparişinde her kalem bir ürüne bağlı olmalıdır.",
          path: ["items", index],
        });
      }
      if (value.mode === "freeform" && isCatalog) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Serbest sipariş kaleminde ürün seçilemez.",
          path: ["items", index],
        });
      }
    });

    const seenCustomExpenseIds = new Set<string>();
    value.customExpenses.forEach((expense, index) => {
      if (expense.id && seenCustomExpenseIds.has(expense.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Aynı ek gider kimliği birden fazla kullanılamaz.",
          path: ["customExpenses", index, "id"],
        });
      }
      if (expense.id) seenCustomExpenseIds.add(expense.id);
    });
  });

export type ManualOrderInput = z.infer<typeof ManualOrderInputSchema>;
export type ManualOrderCatalogInputItem = z.infer<typeof CatalogItemSchema>;
export type ManualOrderFreeformInputItem = z.infer<typeof FreeformItemSchema>;

export interface ManualOrderStoredItem extends ManualOrderResolvedItem {
  /** Mobil v1 kayıtları bu alanı yazmayabilir; mode/productId üzerinden anlaşılır. */
  kind?: "catalog" | "freeform";
  alias?: string | null;
  variantLabel?: string | null;
  currentSalePrice?: number | null;
}

export interface ManualOrderItemsEnvelope {
  version: 1;
  items: ManualOrderStoredItem[];
}

export interface ManualOrderBreakdownEnvelope {
  version: 1;
  draft: ManualOrderCalculationInput;
  breakdown: ManualOrderBreakdown;
}

export interface ManualOrderRecordShape {
  id: string;
  orderNumber: string;
  mode: string;
  orderedAt: Date;
  statusKind: string;
  customerName: string | null;
  currency: string;
  revenueKurus: number;
  netRevenueKurus: number;
  totalCostKurus: number;
  inputVatCreditKurus: number;
  profitKurus: number | null;
  profitPartial: boolean;
  itemsJson: string;
  breakdownJson: string;
  calculationVersion: number;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class ManualOrderValidationError extends Error {}

function optionalValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function lineId(value: string | undefined): string {
  return value?.trim() || `mol:${randomUUID()}`;
}

function generateOrderNumber(orderedAt: Date): string {
  const date = orderedAt.toISOString().slice(0, 10).replaceAll("-", "");
  return `MAN-${date}-${randomUUID().slice(0, 6).toUpperCase()}`;
}

function isCatalogItem(
  item: ManualOrderInput["items"][number]
): item is ManualOrderCatalogInputItem {
  return "productId" in item;
}

export function parseManualOrderItems(value: string): ManualOrderItemsEnvelope {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new ManualOrderValidationError(
      "Manuel sipariş kalem verisi geçerli JSON değil."
    );
  }
  const parsed = ManualOrderItemsEnvelopeSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ManualOrderValidationError(
      `Desteklenmeyen manuel sipariş kalem formatı: ${parsed.error.issues[0]?.message ?? "geçersiz veri"}`
    );
  }
  return parsed.data as ManualOrderItemsEnvelope;
}

export function parseManualOrderBreakdown(
  value: string
): ManualOrderBreakdownEnvelope {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new ManualOrderValidationError(
      "Manuel sipariş hesap verisi geçerli JSON değil."
    );
  }
  const parsed = ManualOrderBreakdownEnvelopeSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ManualOrderValidationError(
      `Desteklenmeyen manuel sipariş hesap formatı: ${parsed.error.issues[0]?.message ?? "geçersiz veri"}`
    );
  }
  return parsed.data as ManualOrderBreakdownEnvelope;
}

type CapturedFinanceFields = Pick<
  ManualOrderRecordShape,
  | "mode"
  | "revenueKurus"
  | "netRevenueKurus"
  | "totalCostKurus"
  | "inputVatCreditKurus"
  | "profitKurus"
  | "profitPartial"
  | "itemsJson"
  | "breakdownJson"
  | "calculationVersion"
>;

const BREAKDOWN_NUMBERS = [
  "grossRevenue",
  "netRevenue",
  "outputVat",
  "productCost",
  "packagingCost",
  "commissionCost",
  "cargoCost",
  "expenseRulesCost",
  "customExpensesCost",
  "totalCost",
  "inputVatCredit",
  "netProfit",
  "profitMargin",
] as const;

function almostEqual(
  first: number | null,
  second: number | null,
  tolerance = 1e-7
): boolean {
  if (first === null || second === null) return first === second;
  return Math.abs(first - second) <= tolerance;
}

/**
 * Portable backups are an input boundary. Verify that their captured row,
 * versioned draft and stored breakdown all describe the same calculation.
 */
export function validateManualOrderCapturedFinance(
  order: CapturedFinanceFields
): void {
  const itemsEnvelope = parseManualOrderItems(order.itemsJson);
  const breakdownEnvelope = parseManualOrderBreakdown(order.breakdownJson);
  if (
    order.calculationVersion !== MANUAL_ORDER_CALCULATION_VERSION ||
    breakdownEnvelope.version !== MANUAL_ORDER_CALCULATION_VERSION
  ) {
    throw new ManualOrderValidationError(
      "Manuel sipariş hesap sürümü desteklenmiyor."
    );
  }
  if (breakdownEnvelope.draft.mode !== order.mode) {
    throw new ManualOrderValidationError(
      "Manuel sipariş türü ile hesap kaydı uyuşmuyor."
    );
  }
  if (
    JSON.stringify(itemsEnvelope.items) !==
    JSON.stringify(breakdownEnvelope.draft.items)
  ) {
    throw new ManualOrderValidationError(
      "Manuel sipariş kalemleri ile hesap kaydı uyuşmuyor."
    );
  }

  const recalculated = calculateManualOrder(breakdownEnvelope.draft);
  for (const key of BREAKDOWN_NUMBERS) {
    if (!almostEqual(recalculated[key], breakdownEnvelope.breakdown[key])) {
      throw new ManualOrderValidationError(
        `Manuel sipariş hesap dökümü geçersiz: ${key}.`
      );
    }
  }
  if (
    recalculated.profitPartial !== breakdownEnvelope.breakdown.profitPartial ||
    recalculated.missingCostItems !==
      breakdownEnvelope.breakdown.missingCostItems
  ) {
    throw new ManualOrderValidationError(
      "Manuel sipariş hesap durumu geçersiz."
    );
  }

  const expectedProfit =
    recalculated.netProfit == null ? null : tlToKurus(recalculated.netProfit);
  if (
    order.revenueKurus !== tlToKurus(recalculated.grossRevenue) ||
    order.netRevenueKurus !== tlToKurus(recalculated.netRevenue) ||
    order.totalCostKurus !== tlToKurus(recalculated.totalCost) ||
    order.inputVatCreditKurus !== tlToKurus(recalculated.inputVatCredit) ||
    order.profitKurus !== expectedProfit ||
    order.profitPartial !== recalculated.profitPartial
  ) {
    throw new ManualOrderValidationError(
      "Manuel sipariş satırındaki para alanları hesap kaydıyla uyuşmuyor."
    );
  }
}

function inputFinancialSignature(input: ManualOrderInput): string {
  return JSON.stringify({
    mode: input.mode,
    saleTotal: input.saleTotal,
    includeProductCost: input.includeProductCost,
    includePackaging: input.includePackaging,
    commission: input.commission,
    cargo: input.cargo,
    expenseRules: input.expenseRules,
    customExpenses: input.customExpenses,
    items: input.items,
  });
}

function storedFinancialSignature(order: ManualOrderRecordShape): string {
  const items = parseManualOrderItems(order.itemsJson).items;
  const draft = parseManualOrderBreakdown(order.breakdownJson).draft;
  return JSON.stringify({
    mode: draft.mode,
    saleTotal: draft.saleTotal,
    includeProductCost: draft.includeProductCost,
    includePackaging: draft.includePackaging,
    commission: draft.commission,
    cargo: draft.cargo,
    expenseRules: draft.expenseRules.map((rule) => ({
      ruleId: rule.id,
      hasVatInvoice: rule.hasVatInvoice,
    })),
    customExpenses: draft.customExpenses,
    items:
      draft.mode === "catalog"
        ? items.map((item) => ({
            id: item.id,
            productId: item.productId,
            quantity: item.quantity,
          }))
        : items.map((item) => ({
            id: item.id,
            name: item.name,
            quantity: item.quantity,
            unitCost: item.manualUnitCost ?? null,
            manualCostHasVatInvoice:
              item.manualCostHasVatInvoice ?? false,
          })),
  });
}

async function resolveManualOrderInput(
  input: ManualOrderInput,
  existing?: ManualOrderRecordShape
) {
  const existingItems = existing
    ? parseManualOrderItems(existing.itemsJson).items
    : [];
  const existingById = new Map(existingItems.map((item) => [item.id, item]));
  const existingDraft = existing
    ? parseManualOrderBreakdown(existing.breakdownJson).draft
    : null;
  const capturedRulesById = new Map(
    (existingDraft?.expenseRules ?? []).map((rule) => [rule.id, rule])
  );
  const productIds =
    input.mode === "catalog"
      ? input.items
          .filter(isCatalogItem)
          .filter((item) => {
            const captured = item.id ? existingById.get(item.id) : null;
            return !(
              captured?.productId != null &&
              captured.productId === item.productId
            );
          })
          .map((item) => item.productId)
      : [];
  const ruleIds = input.expenseRules
    .filter((selection) => !capturedRulesById.has(selection.ruleId))
    .map((selection) => selection.ruleId);

  const [products, rules, settings] = await Promise.all([
    productIds.length
      ? prisma.product.findMany({
          where: { id: { in: productIds } },
          include: {
            cost: {
              include: {
                filamentType: { select: { costPerGram: true } },
              },
            },
            variantGroup: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
    ruleIds.length
      ? prisma.expenseRule.findMany({
          where: { id: { in: ruleIds }, isActive: true },
        })
      : Promise.resolve([]),
    prisma.appSetting.findMany(),
  ]);

  const productsById = new Map(products.map((product) => [product.id, product]));
  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  const settingsMap = Object.fromEntries(
    settings.map((setting) => [setting.key, setting.value])
  );
  // A manual order's VAT rate is part of its captured financial history.
  // Financial edits may change amounts, but must not silently reprice the
  // original sale when the global VAT setting has changed since creation.
  const vatRate =
    existingDraft?.vatRate ?? Number(settingsMap.vatRate ?? 0);
  if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 100) {
    throw new ManualOrderValidationError("Global KDV oranı geçersiz.");
  }

  const resolvedItems: ManualOrderStoredItem[] = input.items.map((item) => {
    if (input.mode === "catalog") {
      if (!isCatalogItem(item)) {
        throw new ManualOrderValidationError(
          "Katalog siparişinde serbest kalem kullanılamaz."
        );
      }
      const captured = item.id ? existingById.get(item.id) : null;
      if (
        captured?.productId != null &&
        captured.productId === item.productId
      ) {
        return {
          ...captured,
          kind: "catalog",
          quantity: item.quantity,
        };
      }
      const product = productsById.get(item.productId);
      if (!product) {
        throw new ManualOrderValidationError(
          `Seçilen ürün bulunamadı: ${item.productId}`
        );
      }
      const resolved = resolveProductCost(
        product.cost,
        settingsMap,
        product.cost?.filamentType?.costPerGram ?? 0
      );
      const costKnown = product.cost != null;
      return {
        kind: "catalog",
        id: lineId(item.id),
        productId: product.id,
        name: product.name,
        alias: product.alias,
        variantLabel: product.variantLabel,
        currentSalePrice: product.currentSalePrice,
        imageUrl: product.imageUrl,
        quantity: item.quantity,
        costKnown,
        productionCost: resolved?.productionCost ?? 0,
        packagingCost: resolved?.packagingCost ?? 0,
        filamentCost: resolved?.filamentCost ?? 0,
        packagingComponents:
          resolved?.packagingBreakdown?.components ?? null,
      };
    }

    if (isCatalogItem(item)) {
      throw new ManualOrderValidationError(
        "Serbest siparişte katalog kalemi kullanılamaz."
      );
    }
    return {
      kind: "freeform",
      id: lineId(item.id),
      productId: null,
      name: item.name,
      imageUrl: null,
      quantity: item.quantity,
      costKnown: item.unitCost != null,
      productionCost: 0,
      packagingCost: 0,
      filamentCost: 0,
      packagingComponents: null,
      manualUnitCost: item.unitCost,
      manualCostHasVatInvoice: item.manualCostHasVatInvoice,
    };
  });

  const resolvedExpenseRules: ManualOrderSelectedExpense[] =
    input.expenseRules.map((selection) => {
      const rule =
        capturedRulesById.get(selection.ruleId) ??
        rulesById.get(selection.ruleId);
      if (!rule) {
        throw new ManualOrderValidationError(
          `Aktif gider kuralı bulunamadı: ${selection.ruleId}`
        );
      }
      const amount =
        rule.type === "percentage"
          ? input.saleTotal * rule.value
          : rule.value;
      return {
        id: rule.id,
        name: rule.name,
        type: rule.type as ManualOrderSelectedExpense["type"],
        value: rule.value,
        amount,
        hasVatInvoice: selection.hasVatInvoice,
      };
    });

  const customExpenses: ManualOrderCustomExpense[] =
    input.customExpenses.map((expense) => ({
      id: lineId(expense.id),
      name: expense.name,
      amount: expense.amount,
      hasVatInvoice: expense.hasVatInvoice,
    }));
  const calculationInput: ManualOrderCalculationInput = {
    saleTotal: input.saleTotal,
    vatRate,
    mode: input.mode,
    items: resolvedItems,
    includeProductCost: input.includeProductCost,
    includePackaging: input.includePackaging,
    commission: input.commission,
    cargo: input.cargo,
    expenseRules: resolvedExpenseRules,
    customExpenses,
  };
  const breakdown = calculateManualOrder(calculationInput);
  const itemsEnvelope: ManualOrderItemsEnvelope = {
    version: 1,
    items: resolvedItems,
  };
  const breakdownEnvelope: ManualOrderBreakdownEnvelope = {
    version: 1,
    draft: calculationInput,
    breakdown,
  };

  return { itemsEnvelope, breakdownEnvelope, breakdown };
}

function financialFields(
  input: ManualOrderInput,
  resolved: Awaited<ReturnType<typeof resolveManualOrderInput>>
) {
  return {
    mode: input.mode,
    orderedAt: input.orderedAt,
    statusKind: input.statusKind,
    customerName: optionalValue(input.customerName),
    currency: input.currency,
    revenueKurus: tlToKurus(resolved.breakdown.grossRevenue),
    netRevenueKurus: tlToKurus(resolved.breakdown.netRevenue),
    totalCostKurus: tlToKurus(resolved.breakdown.totalCost),
    inputVatCreditKurus: tlToKurus(resolved.breakdown.inputVatCredit),
    profitKurus:
      resolved.breakdown.netProfit == null
        ? null
        : tlToKurus(resolved.breakdown.netProfit),
    profitPartial: resolved.breakdown.profitPartial,
    itemsJson: JSON.stringify(resolved.itemsEnvelope),
    breakdownJson: JSON.stringify(resolved.breakdownEnvelope),
    calculationVersion: MANUAL_ORDER_CALCULATION_VERSION,
    note: optionalValue(input.note),
  };
}

export async function createManualOrder(input: ManualOrderInput) {
  const resolved = await resolveManualOrderInput(input);
  return prisma.manualOrder.create({
    data: {
      orderNumber:
        optionalValue(input.orderNumber) ?? generateOrderNumber(input.orderedAt),
      ...financialFields(input, resolved),
    },
  });
}

export async function updateManualOrder(id: string, input: ManualOrderInput) {
  const existing = await prisma.manualOrder.findUnique({ where: { id } });
  if (!existing) {
    throw Object.assign(new Error("Manuel sipariş bulunamadı."), {
      code: "P2025",
    });
  }
  const common = {
    ...(optionalValue(input.orderNumber)
      ? { orderNumber: optionalValue(input.orderNumber)! }
      : {}),
    orderedAt: input.orderedAt,
    statusKind: input.statusKind,
    customerName: optionalValue(input.customerName),
    currency: input.currency,
    note: optionalValue(input.note),
  };
  if (inputFinancialSignature(input) === storedFinancialSignature(existing)) {
    return prisma.manualOrder.update({
      where: { id },
      data: common,
    });
  }

  const resolved = await resolveManualOrderInput(input, existing);
  return prisma.manualOrder.update({
    where: { id },
    data: {
      ...common,
      ...financialFields(input, resolved),
    },
  });
}

export function manualOrderDetailResponse(order: ManualOrderRecordShape) {
  const itemsEnvelope = parseManualOrderItems(order.itemsJson);
  const breakdownEnvelope = parseManualOrderBreakdown(order.breakdownJson);
  const mode = order.mode as "catalog" | "freeform";
  const editItems =
    mode === "catalog"
      ? itemsEnvelope.items.map((item) => ({
          id: item.id,
          productId: item.productId,
          quantity: item.quantity,
        }))
      : itemsEnvelope.items.map((item) => ({
          id: item.id,
          name: item.name,
          quantity: item.quantity,
          unitCost: item.manualUnitCost ?? null,
          manualCostHasVatInvoice:
            item.manualCostHasVatInvoice ?? false,
        }));
  const draft = {
    orderedAt: order.orderedAt.toISOString(),
    orderNumber: order.orderNumber,
    customerName: order.customerName,
    statusKind: order.statusKind as ManualOrderStatusKind,
    currency: order.currency,
    saleTotal: kurusToTl(order.revenueKurus),
    note: order.note,
    mode,
    includeProductCost: breakdownEnvelope.draft.includeProductCost,
    includePackaging: breakdownEnvelope.draft.includePackaging,
    commission: breakdownEnvelope.draft.commission,
    cargo: breakdownEnvelope.draft.cargo,
    expenseRules: breakdownEnvelope.draft.expenseRules.map((rule) => ({
      ruleId: rule.id,
      hasVatInvoice: rule.hasVatInvoice,
    })),
    customExpenses: breakdownEnvelope.draft.customExpenses,
    items: editItems,
  };
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    mode,
    orderedAt: order.orderedAt.toISOString(),
    statusKind: order.statusKind,
    customerName: order.customerName,
    currency: order.currency,
    saleTotal: kurusToTl(order.revenueKurus),
    vatRate: breakdownEnvelope.draft.vatRate,
    netRevenue: kurusToTl(order.netRevenueKurus),
    totalCost: kurusToTl(order.totalCostKurus),
    inputVatCredit: kurusToTl(order.inputVatCreditKurus),
    profit:
      order.profitKurus == null ? null : kurusToTl(order.profitKurus),
    profitPartial: order.profitPartial,
    note: order.note,
    calculationVersion: order.calculationVersion,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    items: itemsEnvelope.items,
    breakdown: breakdownEnvelope.breakdown,
    resolvedExpenseRules: breakdownEnvelope.draft.expenseRules,
    draft,
  };
}

export async function getManualOrderOptions() {
  const [products, expenseRules, settings] = await Promise.all([
    prisma.product.findMany({
      where: { isActive: true, hidden: false },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      include: {
        cost: {
          include: {
            filamentType: { select: { costPerGram: true } },
          },
        },
        variantGroup: { select: { name: true } },
      },
    }),
    prisma.expenseRule.findMany({
      where: { isActive: true },
      orderBy: [{ priority: "desc" }, { name: "asc" }],
    }),
    prisma.appSetting.findMany(),
  ]);
  const settingsMap = Object.fromEntries(
    settings.map((setting) => [setting.key, setting.value])
  );
  const vatRate = Number(settingsMap.vatRate ?? 0);

  return {
    vatRate: Number.isFinite(vatRate) ? vatRate : 0,
    products: products.map((product) => {
      const resolved = resolveProductCost(
        product.cost,
        settingsMap,
        product.cost?.filamentType?.costPerGram ?? 0
      );
      return {
        id: product.id,
        name: product.name,
        alias: product.alias,
        variantLabel: product.variantLabel,
        variantGroupName: product.variantGroup?.name ?? null,
        imageUrl: product.imageUrl,
        currentSalePrice: product.currentSalePrice,
        productionCost: resolved?.productionCost ?? 0,
        packagingCost: resolved?.packagingCost ?? 0,
        filamentCost: resolved?.filamentCost ?? 0,
        packagingComponents:
          resolved?.packagingBreakdown?.components ?? null,
        costKnown: product.cost != null,
      };
    }),
    expenseRules,
  };
}

export function manualOrderValidationMessage(error: unknown): string | null {
  if (error instanceof ManualOrderValidationError) return error.message;
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Geçersiz manuel sipariş bilgisi.";
  }
  return null;
}

export type ManualOrderPackagingComponents =
  PackagingBreakdown["components"];
