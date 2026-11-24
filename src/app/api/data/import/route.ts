import { bayatOnbellegiDusur, BAYAT_ONBELLEK } from "@/core/printers/bayat-onbellek";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { batchWrite } from "@/lib/libsql-batch";
import { ensureRuntimeSchema, KARGO_PLATFORM_GOCU_ANAHTARI } from "@/lib/runtime-schema";
import { invalidateOrdersCache } from "@/lib/orders-cache";
import { bustCache } from "@/lib/route-cache";
import { validateManualOrderCapturedFinance } from "@/lib/manual-orders";
import { toDbDate } from "@/lib/sqlite-date";
import {
  backupColumns,
  backupVersionInfo,
  backupVersionVerdict,
  type BackupModel,
  YEDEK_DAHA_YENI_HATASI,
  YEDEK_ESKI_UYARISI,
} from "@/lib/backup-payload";

export const dynamic = "force-dynamic";

const id = z.string().trim().min(1);
const finite = z.number().finite();
const integer = finite.int();
const sqliteInt = integer.min(-2_147_483_648).max(2_147_483_647);
const nullableString = z.string().nullable().optional();
const nullableFinite = finite.nullable().optional();
const nullableInt = sqliteInt.nullable().optional();
const optionalDate = z.coerce.date().optional();
const nullableDate = z.coerce.date().nullable().optional();

/**
 * Tablo şeması. `.passthrough()`: burada adı geçmeyen alanlar ATILMAZ — şemaya sonradan eklenen
 * bir kolon, geri yüklemede Prisma alan listesi üzerinden (`backupColumns`) kendiliğinden yazılır.
 * Yine de bilinen her kolon burada TİPİYLE durur (doğrulama + tarih çevirisi).
 *
 * ⚠️ TARİH kolonu burada `z.coerce.date()` ile TANIMLANMALI. Tanımlanmayan tarih düz metin olarak
 * yazılır ve karışık tarih biçimi doğar (Prisma'nın `gte` filtresi o satırları sessizce eler).
 * `yedek-gidis-donus.test.ts` her tarih kolonunun depolama biçimini denetler, unutulursa kırılır.
 */
const table = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

const VariantGroupSchema = table({
  id,
  name: z.string(),
  shareModels: z.boolean().optional(),
  createdAt: optionalDate,
  updatedAt: optionalDate,
});

const ProductSchema = table({
  id,
  barcode: id,
  sku: z.string().optional(),
  name: z.string().optional(),
  alias: nullableString,
  categoryName: z.string().optional(),
  currentSalePrice: finite,
  listPrice: nullableFinite,
  stock: integer.optional(),
  desi: nullableFinite,
  weight: nullableFinite,
  imageUrl: nullableString,
  imageManual: z.boolean().optional(),
  isActive: z.boolean().optional(),
  hidden: z.boolean().optional(),
  madeToOrder: z.boolean().optional(),
  source: z.string().optional(),
  trendyolId: nullableString,
  productMainId: nullableString,
  variantGroupId: nullableString,
  variantLabel: nullableString,
  commissionRate: nullableFinite,
  commissionSource: nullableString,
  commissionUpdatedAt: nullableDate,
  createdAt: optionalDate,
  updatedAt: optionalDate,
});

const ProductCostSchema = table({
  id,
  productId: id,
  costMode: z.string().optional(),
  // Kaldırılan maliyet şablonu özelliğinin kalıntısı: eski yedeklerde durur, içe aktarılmaz.
  templateId: nullableString,
  filamentTypeId: nullableString,
  filamentWeight: nullableFinite,
  ekFilamentlerJson: nullableString,
  printTimeHours: nullableFinite,
  wasteRate: nullableFinite,
  packagingPoset: nullableFinite,
  packagingNaylon: nullableFinite,
  packagingBant: nullableFinite,
  packagingKart: nullableFinite,
  packagingOptionId: nullableString,
  nylonLevel: nullableString,
  tapeUsed: z.boolean().nullable().optional(),
  manualCost: nullableFinite,
  materialWeight: nullableFinite,
  materialCost: nullableFinite,
  electricityCost: nullableFinite,
  machineWearCost: nullableFinite,
  laborCost: nullableFinite,
  packagingCost: nullableFinite,
  otherCost: nullableFinite,
  totalCost: nullableFinite,
  updatedAt: optionalDate,
});

const ListingSchema = table({
  id,
  productId: id,
  platform: id,
  externalId: nullableString,
  externalSku: nullableString,
  barcode: nullableString,
  salePrice: finite,
  listPrice: nullableFinite,
  stock: integer.optional(),
  commissionRate: nullableFinite,
  commissionFixed: nullableFinite,
  cargoCost: nullableFinite,
  dispatchDays: nullableInt,
  vatRate: nullableFinite,
  isActive: z.boolean().optional(),
  lastSyncedAt: nullableDate,
  createdAt: optionalDate,
  updatedAt: optionalDate,
});

const FilamentTypeSchema = table({
  id,
  name: z.string(),
  costPerGram: finite,
  isActive: z.boolean().optional(),
});

const FilamentSpoolSchema = table({
  id,
  name: z.string(),
  material: z.string().optional(),
  colorName: nullableString,
  colorHex: z.string().optional(),
  brand: nullableString,
  totalGrams: finite.optional(),
  remainingGrams: finite.optional(),
  spoolCost: nullableFinite,
  reorderGrams: finite.optional(),
  vendorUrl: nullableString,
  colorKey: nullableString,
  openedAt: nullableDate,
  isActive: z.boolean().optional(),
  createdAt: optionalDate,
  updatedAt: optionalDate,
});

const FilamentUsageSchema = table({
  id,
  spoolId: id,
  productId: nullableString,
  productName: nullableString,
  grams: finite,
  note: nullableString,
  createdAt: optionalDate,
});

const AppSettingSchema = z.object({
  key: id,
  value: z.string(),
});

const CommissionRuleSchema = table({
  id,
  name: z.string(),
  categoryName: nullableString,
  minPrice: finite.optional(),
  maxPrice: finite.optional(),
  commissionRate: finite,
  fixedCommission: finite.optional(),
  validFrom: nullableDate,
  validTo: nullableDate,
  priority: integer.optional(),
  isActive: z.boolean().optional(),
  platform: nullableString,
});

const CargoRuleSchema = table({
  id,
  name: z.string(),
  platform: nullableString,
  cargoProvider: nullableString,
  categoryName: nullableString,
  minPrice: finite.optional(),
  maxPrice: finite.optional(),
  minDesi: finite.optional(),
  maxDesi: finite.optional(),
  cargoCost: finite,
  vatIncluded: z.boolean().optional(),
  validFrom: nullableDate,
  validTo: nullableDate,
  priority: integer.optional(),
  isActive: z.boolean().optional(),
});

const AdBudgetSchema = table({
  id,
  platform: id,
  dailyAmount: finite,
  validFrom: z.coerce.date(),
  validTo: nullableDate,
  isActive: z.boolean().optional(),
  createdAt: optionalDate,
});

const ExpenseRuleSchema = table({
  id,
  name: z.string(),
  platform: nullableString,
  type: z.enum(["fixed", "percentage", "per_order"]),
  value: finite,
  categoryName: nullableString,
  minPrice: finite.optional(),
  maxPrice: finite.optional(),
  priority: integer.optional(),
  isActive: z.boolean().optional(),
});

const ActualExpenseSchema = table({
  id,
  name: z.string().trim().min(1),
  category: nullableString,
  amountKurus: integer.positive().max(2_147_483_647),
  paidAt: z.coerce.date(),
  note: nullableString,
  recurringId: nullableString,
  periodKey: nullableString,
  vatRate: nullableFinite,
  createdAt: optionalDate,
  updatedAt: optionalDate,
});

const RecurringExpenseSchema = table({
  id,
  name: z.string().trim().min(1),
  category: nullableString,
  amountKurus: sqliteInt,
  dayOfMonth: integer.min(1).max(31),
  startsAt: z.coerce.date(),
  endsAt: nullableDate,
  isActive: z.boolean().optional(),
  note: nullableString,
  vatRate: nullableFinite,
  createdAt: optionalDate,
  updatedAt: optionalDate,
});

const RecurringExpenseSkipSchema = table({
  recurringId: id,
  periodKey: z.string().trim().min(1),
  createdAt: optionalDate,
});

const ExpenseCategorySchema = table({
  id,
  name: z.string().trim().min(1),
  color: nullableString,
  sortOrder: sqliteInt.optional(),
  createdAt: optionalDate,
  updatedAt: optionalDate,
});

const OrderFinanceSnapshotSchema = table({
  id,
  platform: id,
  externalOrderId: id,
  orderNumber: z.string(),
  orderedAt: z.coerce.date(),
  revenueKurus: integer.nonnegative().max(2_147_483_647),
  profitKurus: nullableInt,
  profitPartial: z.boolean().optional(),
  statusKind: z.string(),
  currency: z.string().optional(),
  syncedAt: optionalDate,
  calculationVersion: integer.positive().optional(),
  profitSource: z.enum(["calculated", "platform"]).optional(),
  estimatedCommissionKurus: nullableInt,
  actualCommissionKurus: nullableInt,
  outputVatKurus: nullableInt,
  inputVatCreditKurus: nullableInt,
  microExportCountry: nullableString,
  actualFeesKurus: nullableInt,
  cargoKurus: nullableInt,
  returnLossKurus: nullableInt,
  returnLossVatKurus: nullableInt,
  cargoContext: nullableString,
  penaltyKurus: nullableInt,
  delayInfo: nullableString,
});

/** Ürün bazlı satış geçmişi — eski yedeklerde YOK (opsiyonel). */
const OrderItemSnapshotSchema = table({
  id,
  platform: id,
  externalOrderId: id,
  lineIndex: integer.nonnegative(),
  orderedAt: z.coerce.date(),
  productId: nullableString,
  productName: z.string(),
  quantity: integer.nonnegative(),
  unitPriceKurus: sqliteInt,
  lineRevenueKurus: sqliteInt,
  statusKind: z.string(),
  currency: z.string().optional(),
  syncedAt: optionalDate,
  commissionRate: nullableFinite,
  vatRate: nullableFinite,
  dispatchDays: nullableInt,
});

/** Siparişe özel maliyet — eski yedeklerde YOK (opsiyonel). */
const OrderLineCostSchema = table({
  id,
  platform: id,
  externalOrderId: id,
  lineKey: z.string().min(1),
  lineName: z.string().optional(),
  costJson: z.string(),
  desi: nullableFinite,
  createdAt: optionalDate,
  updatedAt: optionalDate,
});

/** Elle girilen Shopify kargo desisi — eski yedeklerde YOK (opsiyonel). */
const OrderCargoDesiSchema = table({
  id,
  platform: id,
  externalOrderId: id,
  desi: z.number().positive(),
  createdAt: optionalDate,
  updatedAt: optionalDate,
});

/** Uygulamadan açılan kargo gönderisi — eski yedeklerde YOK (opsiyonel). */
const CargoShipmentSchema = table({
  id,
  platform: id,
  externalOrderId: id,
  orderNumber: z.string(),
  carrier: id,
  environment: id,
  kind: z.string().optional(),
  barcode: id,
  status: z.string().optional(),
  statusText: nullableString,
  carrierStatus: nullableString,
  lastEventAtMs: nullableFinite,
  lastCheckedAtMs: nullableFinite,
  shopifyFulfillmentId: nullableString,
  shopifyShippedAtMs: nullableFinite,
  shopifyDeliveredAtMs: nullableFinite,
  shopifyError: nullableString,
  createdAtMs: finite,
  updatedAtMs: finite,
  cancelledAtMs: nullableFinite,
  eventsJson: nullableString,
});

/** Elle ürün bağı ("Ürüne bağla") — eski yedeklerde YOK (opsiyonel). */
const OrderLineLinkSchema = table({
  id,
  platform: id,
  lineKey: z.string().min(1),
  lineName: z.string().optional(),
  productId: id,
  createdAt: optionalDate,
  updatedAt: optionalDate,
});

const PlatformOrderFinancialSchema = table({
  id,
  platform: id,
  externalOrderId: id,
  orderNumber: z.string(),
  grossRevenueKurus: integer.nonnegative().max(2_147_483_647),
  commissionKurus: integer.nonnegative().max(2_147_483_647),
  sellerRevenueKurus: integer.nonnegative().max(2_147_483_647),
  transactionCount: integer.nonnegative().optional(),
  sourceUpdatedAt: nullableDate,
  syncedAt: optionalDate,
  serviceFeeKurus: nullableInt,
  paymentFeeKurus: nullableInt,
  cargoKurus: nullableInt,
  stoppageKurus: nullableInt,
  platformDiscountKurus: nullableInt,
  returnCargoKurus: nullableInt,
  chargedDesi: nullableFinite,
  parcelNo: nullableString,
});

const ManualOrderSchema = table({
  id,
  orderNumber: z.string().trim().min(1).max(80),
  mode: z.enum(["catalog", "freeform"]),
  orderedAt: z.coerce.date(),
  statusKind: z.enum(["pending", "processing", "shipped", "delivered", "cancelled"]),
  customerName: z.string().max(160).nullable().optional(),
  currency: z.literal("TRY"),
  revenueKurus: integer.nonnegative().max(2_147_483_647),
  netRevenueKurus: integer.nonnegative().max(2_147_483_647),
  totalCostKurus: integer.nonnegative().max(2_147_483_647),
  inputVatCreditKurus: integer.nonnegative().max(2_147_483_647),
  profitKurus: sqliteInt.nullable(),
  profitPartial: z.boolean(),
  itemsJson: z.string().min(1).max(5_000_000),
  breakdownJson: z.string().min(1).max(5_000_000),
  calculationVersion: integer.positive(),
  note: z.string().max(1_000).nullable().optional(),
  createdAt: optionalDate,
  updatedAt: optionalDate,
}).superRefine((order, ctx) => {
  try {
    validateManualOrderCapturedFinance(order);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "Manuel sipariş hesap kaydı geçersiz.",
      path: ["breakdownJson"],
    });
  }
});

const CostTemplateSchema = z.object({
  id,
  name: z.string(),
  materialCostPerGram: finite.optional(),
  electricityCostPerHour: finite.optional(),
  machineWearCostPerHour: finite.optional(),
  defaultPackagingCost: finite.optional(),
  defaultLaborCost: finite.optional(),
  defaultOtherCost: finite.optional(),
  defaultWasteRate: finite.optional(),
  isActive: z.boolean().optional(),
});

const PriceHistorySchema = table({
  id,
  productId: id,
  oldPrice: finite,
  newPrice: finite,
  changeSource: z.string(),
  changedAt: z.coerce.date(),
  note: nullableString,
});

const PrinterConfigSchema = table({
  id,
  name: z.string(),
  brand: z.string(),
  model: nullableString,
  type: z.string().optional(),
  host: z.string(),
  port: integer.optional(),
  accent: nullableString,
  accessCode: nullableString,
  serial: nullableString,
  enabled: z.boolean().optional(),
  sortOrder: integer.optional(),
  createdAt: optionalDate,
  updatedAt: optionalDate,
});

const PrintFileProductSchema = table({
  id,
  printerConfigId: id,
  filename: id,
  productId: id,
  createdAt: optionalDate,
  updatedAt: optionalDate,
});

const ProductModelFileSchema = table({
  id,
  productId: id,
  printerConfigId: id,
  label: nullableString,
  originalName: z.string(),
  storedPath: z.string().optional(),
  r2Key: nullableString,
  fileType: z.string(),
  sizeBytes: integer.optional(),
  gramaj: nullableFinite,
  estPrintMin: integer.nullable().optional(),
  colorsJson: nullableString,
  sliced: z.boolean().nullable().optional(),
  plateJson: nullableString,
  thumbnail: nullableString,
  contentMd5: nullableString,
  meshR2Key: nullableString,
  meshName: nullableString,
  meshType: nullableString,
  meshSizeBytes: nullableInt,
  sortOrder: integer.optional(),
  createdAt: optionalDate,
  updatedAt: optionalDate,
  storageKind: z.string().optional(),
  fileBytesIncluded: z.boolean().optional(),
});

const ImportSchema = z.object({
  version: z.number().int().positive().optional(),
  schemaVersion: z.number().int().nonnegative().nullable().optional(),
  exportedAt: z.string().optional(),
  appVersion: z.string().optional(),
  metadata: z
    .object({
      warnings: z.array(z.string()).optional(),
    })
    .passthrough()
    .optional(),
  variantGroups: z.array(VariantGroupSchema).optional(),
  products: z.array(ProductSchema).optional(),
  productCosts: z.array(ProductCostSchema).optional(),
  listings: z.array(ListingSchema).optional(),
  filamentTypes: z.array(FilamentTypeSchema).optional(),
  filamentSpools: z.array(FilamentSpoolSchema).optional(),
  filamentUsages: z.array(FilamentUsageSchema).optional(),
  appSettings: z.array(AppSettingSchema).optional(),
  commissionRules: z.array(CommissionRuleSchema).optional(),
  cargoRules: z.array(CargoRuleSchema).optional(),
  // Biçim 4 ile eklenen tablolar — eski yedeklerde YOK; yokken mevcut kayıtlara DOKUNULMAZ.
  adBudgets: z.array(AdBudgetSchema).optional().default([]),
  expenseRules: z.array(ExpenseRuleSchema).optional(),
  actualExpenses: z.array(ActualExpenseSchema).optional().default([]),
  recurringExpenses: z.array(RecurringExpenseSchema).optional().default([]),
  recurringExpenseSkips: z.array(RecurringExpenseSkipSchema).optional().default([]),
  expenseCategories: z.array(ExpenseCategorySchema).optional().default([]),
  orderFinanceSnapshots: z.array(OrderFinanceSnapshotSchema).optional().default([]),
  orderItemSnapshots: z.array(OrderItemSnapshotSchema).optional().default([]),
  orderLineCosts: z.array(OrderLineCostSchema).optional().default([]),
  orderLineLinks: z.array(OrderLineLinkSchema).optional().default([]),
  orderCargoDesis: z.array(OrderCargoDesiSchema).optional().default([]),
  cargoShipments: z.array(CargoShipmentSchema).optional().default([]),
  platformOrderFinancials: z.array(PlatformOrderFinancialSchema).optional().default([]),
  manualOrders: z.array(ManualOrderSchema).optional().default([]),
  // ESKİ YEDEKLER İÇİN TOLERANS: maliyet şablonu özelliği kaldırıldı (arayüzü hiç yoktu).
  // Alan kabul edilir ama İÇE AKTARILMAZ — eski bir yedek yüklenirken hata vermesin diye durur.
  costTemplates: z.array(CostTemplateSchema).optional(),
  priceHistory: z.array(PriceHistorySchema).optional(),
  printerConfigs: z.array(PrinterConfigSchema).optional(),
  printFileProducts: z.array(PrintFileProductSchema).optional(),
  productModelFiles: z.array(ProductModelFileSchema).optional(),
});

type ImportPayload = z.infer<typeof ImportSchema>;

const CUSTOM_PRINT_PRODUCT_ID = "__custom__";
/**
 * Geri yüklenmeyen İÇ DURUM anahtarları. `schemaVersion` başka sürümün yedeğinden gelirse açılış
 * göçü "zaten güncel" sanıp DDL'i atlıyor (no such column); `orderNotifyBaseline` yeni veritabanında
 * son günlerin siparişlerini telefona "yeni sipariş" diye düşürüyordu (denetim, 23 Kas 2026).
 * Migration kilidi yedekten geri gelirse açılış göçünü 3 dakika bloklar. Kargo platform göçü
 * bayrağı geri gelirse eski yedekten dönen kargo kuralları hiç göç ettirilmez.
 */
const SKIPPED_SETTING_KEYS = new Set([
  "schemaMigrationLock",
  "schemaVersion",
  "orderNotifyBaseline",
  KARGO_PLATFORM_GOCU_ANAHTARI,
]);
/** Tek libSQL isteğine konacak ifade sayısı (batch içinde de 500'lük dilim var). */
const CHUNK = 500;

type Stmt = { sql: string; args: unknown[] };
type Row = Record<string, unknown>;

/**
 * SQLite bağlaması: boolean → 0/1, tarih → Prisma'nın aynı kolona yazacağı kanonik biçim.
 *
 * ⚠️ Burası eskiden koşulsuz `value.getTime()` (epoch-ms TAMSAYI) yazıyordu. Turso/libSQL
 * adapter üzerinde Prisma tarihleri ISO METİN yazar ve filtrelerde METİN bağlar; SQLite'ta
 * tamsayı her zaman metinden küçük sayıldığı için yedekten dönen satırlar `paidAt >= …` /
 * `orderedAt >= …` gibi HER tarih filtresinden sessizce düşüyordu — yani geri yükleme
 * sonrası Raporlar ve Giderler eksik çıkıyordu. Ayrıntı: src/lib/sqlite-date.ts.
 */
function toArg(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return toDbDate(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

/**
 * Doğal anahtara göre ekle-veya-güncelle. Tekrar çalıştırılabilir (batch geri alınırsa sıralı
 * yol aynı ifadeyi yeniden koşar).
 *
 * SONDAKİ HEDEFSİZ `ON CONFLICT DO NOTHING` neden var: ifade doğal anahtarı hedefliyor ama satır
 * kendi `id`'sini de taşıyor (ör. ProductCost → hedef productId, birincil anahtar id). Yedekteki
 * bir satır veritabanında BAŞKA bir doğal anahtarla aynı id altında duruyorsa çakışma birincil
 * anahtarda olur ve hedefli cümle onu yakalamaz → 500 ifadelik dilimin TAMAMI geri alınır ve
 * sıralı yola düşülür. Veri kaybı olmaz (sıralı yol satırları tek tek yazar) ama uzak-HTTP modunda
 * her ifade ~96 ms sürdüğü için o dilim saniyeler yerine DAKİKALAR alır. Hedefsiz cümle yalnız
 * TEKİLLİK çakışmalarını yutar (NOT NULL / CHECK / yabancı anahtar hataları yine yükselir):
 * çakışan satır atlanır, dilimin geri kalanı tek toplu yazımda tamamlanır.
 */
function upsert(table: string, conflict: string[], insert: Row, update: Row): Stmt {
  const insertCols = Object.keys(insert);
  const updateCols = Object.keys(update);
  const sql =
    `INSERT INTO "${table}" (${insertCols.map((c) => `"${c}"`).join(", ")}) ` +
    `VALUES (${insertCols.map(() => "?").join(", ")}) ` +
    `ON CONFLICT(${conflict.map((c) => `"${c}"`).join(", ")}) DO ` +
    (updateCols.length
      ? `UPDATE SET ${updateCols.map((c) => `"${c}" = ?`).join(", ")}`
      : "NOTHING") +
    " ON CONFLICT DO NOTHING";
  return {
    sql,
    args: [
      ...insertCols.map((c) => toArg(insert[c])),
      ...updateCols.map((c) => toArg(update[c])),
    ],
  };
}

function updateById(table: string, keyColumn: string, keyValue: string, fields: Row): Stmt {
  const cols = Object.keys(fields);
  // Yedekte güncellenecek alan kalmadıysa satıra dokunmayan geçerli bir ifade üret.
  if (cols.length === 0) {
    return {
      sql: `UPDATE "${table}" SET "${keyColumn}" = "${keyColumn}" WHERE "${keyColumn}" = ?`,
      args: [keyValue],
    };
  }
  return {
    sql: `UPDATE "${table}" SET ${cols.map((c) => `"${c}" = ?`).join(", ")} WHERE "${keyColumn}" = ?`,
    args: [...cols.map((c) => toArg(fields[c])), keyValue],
  };
}

/**
 * Yedek satırından modelin kolonlarını kopyalar (`putDefined` deseni, HER tabloda).
 *
 * Kolon listesi Prisma şemasından gelir (`backupColumns`), yani şemaya eklenen yeni kolon burada
 * kendiliğinden taşınır. YEDEKTE ALAN YOKSA (eski ya da yabancı yedek) hedefe KONMAZ:
 * güncellemede mevcut değer korunur, yeni satırda şemanın varsayılanı kullanılır. Alan açıkça
 * `null` ise null yazılır — alan o yedeğin sürümünde vardı ve gerçekten boştu.
 *
 * NEDEN (23 Kas 2026 denetimi, madde 20): tablolar `?? null` / `?? varsayılan` ile yazılıyordu;
 * eski bir yedek ek filamentleri siliyor, siparişin hesap sürümünü 1'e, kâr kaynağını
 * "calculated"a döndürüyor, gerçek komisyonu siliyor, makaranın kalan gramını 1000 yapıyordu.
 */
function columnsFrom(model: BackupModel, source: Row, skip: readonly string[] = []): Row {
  const out: Row = {};
  for (const column of backupColumns(model)) {
    if (skip.includes(column)) continue;
    const value = source[column];
    if (value === undefined) continue;
    // Kolon değeri düz olmalı; nesne/dizi taşıyan (bozuk ya da yabancı) alan yazılmaz.
    if (value !== null && typeof value === "object" && !(value instanceof Date)) continue;
    out[column] = value;
  }
  return out;
}

interface ImportStats {
  variantGroups: number;
  products: number;
  productCosts: number;
  listings: number;
  filamentTypes: number;
  filamentSpools: number;
  filamentUsages: number;
  appSettings: number;
  commissionRules: number;
  cargoRules: number;
  adBudgets: number;
  expenseRules: number;
  actualExpenses: number;
  recurringExpenses: number;
  recurringExpenseSkips: number;
  expenseCategories: number;
  orderFinanceSnapshots: number;
  orderFinanceSnapshotsSkipped: number;
  orderItemSnapshots: number;
  orderLineCosts: number;
  orderLineLinks: number;
  orderCargoDesis: number;
  cargoShipments: number;
  platformOrderFinancials: number;
  manualOrders: number;
  costTemplates: number;
  priceHistory: number;
  printerConfigs: number;
  printFileProducts: number;
  productModelFiles: number;
  productModelFilesSkipped: number;
  /** Karşılığı bulunamadığı için geri yüklenmeyen satır sayısı. */
  skipped: number;
}

type StatKey = keyof ImportStats;
type Job = { label: string; statKey: StatKey | null; stmts: Stmt[] };
type Emit = (event: Record<string, unknown>) => void;

/** Tek sütunluk kimlik listesini oku (tabloyu bellekte haritalamak için — satır başına sorgu YOK). */
async function readRows<T extends Row>(sql: string): Promise<T[]> {
  return (await prisma.$queryRawUnsafe<T[]>(sql)) ?? [];
}

/** Bu veritabanının şema damgası (açılış göçü yazar); okunamazsa null → şema karşılaştırması atlanır. */
async function readAppSchemaVersion(): Promise<number | null> {
  try {
    const rows = await readRows<{ value: unknown }>(
      `SELECT value FROM AppSetting WHERE key = 'schemaVersion'`
    );
    const value = Number(rows[0]?.value);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Yedeği geri yükler. Tek dev transaction YOK: tablolar bağımlılık sırasına göre işlenir,
 * yazımlar 500'lük gruplar hâlinde tek libSQL isteğine toplanır (uzak modda her ifade ~96ms
 * ve tüm uygulama boyunca sıralı olduğundan satır-satır yazım dakikalar sürüp zaman aşımına
 * düşüyordu). Referansı bulunamayan satır hata vermez; atlanır ve sayılır.
 */
async function runImport(data: ImportPayload, emit: Emit, options: { oldBackup: boolean }) {
  const localModelFiles = (data.productModelFiles ?? []).filter((file) => !file.r2Key);
  const legacyManualSnapshots = data.orderFinanceSnapshots.filter(
    (snapshot) => snapshot.platform === "manual"
  );
  const warnings = [...new Set(data.metadata?.warnings ?? [])];
  if (options.oldBackup) warnings.unshift(YEDEK_ESKI_UYARISI);
  if (localModelFiles.length > 0) {
    warnings.push(
      `${localModelFiles.length} yerel model kaydı geri yüklenmedi: JSON yedeği fiziksel dosya baytlarını içermez.`
    );
  }
  if (legacyManualSnapshots.length > 0) {
    warnings.push(
      `${legacyManualSnapshots.length} eski manuel finans kopyası geri yüklenmedi; manuel siparişin kendi hesap kaydı kullanıldı.`
    );
  }

  const stats: ImportStats = {
    variantGroups: 0,
    products: 0,
    productCosts: 0,
    listings: 0,
    filamentTypes: 0,
    filamentSpools: 0,
    filamentUsages: 0,
    appSettings: 0,
    commissionRules: 0,
    cargoRules: 0,
    adBudgets: 0,
    expenseRules: 0,
    actualExpenses: 0,
    recurringExpenses: 0,
    recurringExpenseSkips: 0,
    expenseCategories: 0,
    orderFinanceSnapshots: 0,
    orderFinanceSnapshotsSkipped: legacyManualSnapshots.length,
    orderItemSnapshots: 0,
    orderLineCosts: 0,
    orderLineLinks: 0,
    orderCargoDesis: 0,
    cargoShipments: 0,
    platformOrderFinancials: 0,
    manualOrders: 0,
    costTemplates: 0,
    priceHistory: 0,
    printerConfigs: 0,
    printFileProducts: 0,
    productModelFiles: 0,
    productModelFilesSkipped: localModelFiles.length,
    skipped: 0,
  };
  /** Eski bağlantısı kurulamadığı için bağsız geri yüklenen satırlar. */
  let droppedLinks = 0;
  const stamp = new Date();
  /** Güncellemede @updatedAt kolonu: yedekteki değer, yoksa şimdi (Prisma da her güncellemede damgalar). */
  const touched = (update: Row, source: Row, column = "updatedAt"): Row => {
    update[column] = source[column] ?? stamp;
    return update;
  };

  // ── Eşleme haritaları: gereken her anahtar TEK sorguyla okunur ────────────
  const products = data.products ?? [];
  const variantGroups = data.variantGroups ?? [];
  const printerConfigs = data.printerConfigs ?? [];
  const filamentSpools = data.filamentSpools ?? [];
  const productCosts = data.productCosts ?? [];
  const listings = data.listings ?? [];
  const priceHistory = data.priceHistory ?? [];
  const filamentUsages = data.filamentUsages ?? [];
  const printFileProducts = data.printFileProducts ?? [];
  const modelFiles = (data.productModelFiles ?? []).filter((file) => file.r2Key);
  const needsProductMap =
    products.length > 0 ||
    productCosts.length > 0 ||
    listings.length > 0 ||
    priceHistory.length > 0 ||
    filamentUsages.length > 0 ||
    printFileProducts.length > 0 ||
    modelFiles.length > 0 ||
    data.orderItemSnapshots.length > 0 ||
    data.orderLineCosts.length > 0 ||
    data.orderLineLinks.length > 0;

  const barcodeToProductId = new Map<string, string>();
  const productIds = new Set<string>();
  if (needsProductMap) {
    for (const row of await readRows<{ id: string; barcode: string }>(
      `SELECT id, barcode FROM Product`
    )) {
      barcodeToProductId.set(row.barcode, row.id);
      productIds.add(row.id);
    }
  }
  const printerIds = new Set<string>();
  if (printerConfigs.length || printFileProducts.length || modelFiles.length) {
    for (const row of await readRows<{ id: string }>(`SELECT id FROM PrinterConfig`)) {
      printerIds.add(row.id);
    }
  }
  const spoolIds = new Set<string>();
  if (filamentSpools.length || filamentUsages.length) {
    for (const row of await readRows<{ id: string }>(`SELECT id FROM FilamentSpool`)) {
      spoolIds.add(row.id);
    }
  }
  const variantGroupIds = new Set<string>();
  if (variantGroups.length || products.length) {
    for (const row of await readRows<{ id: string }>(`SELECT id FROM VariantGroup`)) {
      variantGroupIds.add(row.id);
    }
  }

  // Yedekteki satırlar da bu turda yazılacağı için haritalara şimdiden eklenir.
  for (const group of variantGroups) variantGroupIds.add(group.id);
  for (const printer of printerConfigs) printerIds.add(printer.id);
  for (const spool of filamentSpools) spoolIds.add(spool.id);

  /** Yedekteki ürün kimliğini hedef veritabanındaki kimliğe çevirir (yoksa null → satır atlanır). */
  const productIdMap = new Map<string, string>();
  const resolveProduct = (sourceId: string): string | null =>
    productIdMap.get(sourceId) ?? (productIds.has(sourceId) ? sourceId : null);

  // ── Bağımsız tablolar ─────────────────────────────────────────────────────
  const jobs: Job[] = [];

  jobs.push({
    label: "Ayarlar",
    statKey: "appSettings",
    stmts: (data.appSettings ?? [])
      .filter((setting) => !SKIPPED_SETTING_KEYS.has(setting.key))
      .map((setting) =>
        upsert(
          "AppSetting",
          ["key"],
          { key: setting.key, value: setting.value },
          { value: setting.value }
        )
      ),
  });
  stats.appSettings = jobs[jobs.length - 1].stmts.length;

  jobs.push({
    label: "Maliyet ayarları",
    statKey: "filamentTypes",
    stmts: (data.filamentTypes ?? []).map((f) => {
      const update = columnsFrom("FilamentType", f, ["id"]);
      return upsert("FilamentType", ["id"], { id: f.id, isActive: true, ...update }, update);
    }),
  });
  stats.filamentTypes = jobs[jobs.length - 1].stmts.length;

  // MALİYET ŞABLONU KALDIRILDI. Özelliğin arayüzü hiç yoktu: hiçbir ekran uçlarını çağırmıyor,
  // hiçbir yerden ürüne şablon atanamıyordu ve maliyet motoru şablonu hiç okumuyordu (sahada
  // 284 maliyet kaydının tamamı "detailed" modda). Eski yedeklerde bu alan bulunabilir; şema
  // onu KABUL eder ama içe aktarmaz — yükleme hata vermesin, veri de sessizce canlanmasın.

  jobs.push({
    label: "Kurallar",
    statKey: "commissionRules",
    stmts: (data.commissionRules ?? []).map((rule) => {
      const update = columnsFrom("CommissionRule", rule, ["id"]);
      return upsert(
        "CommissionRule",
        ["id"],
        {
          id: rule.id,
          minPrice: 0,
          maxPrice: 999_999,
          fixedCommission: 0,
          priority: 10,
          isActive: true,
          ...update,
        },
        update
      );
    }),
  });
  stats.commissionRules = jobs[jobs.length - 1].stmts.length;

  jobs.push({
    label: "Kurallar",
    statKey: "cargoRules",
    stmts: (data.cargoRules ?? []).map((rule) => {
      const update = columnsFrom("CargoRule", rule, ["id"]);
      return upsert(
        "CargoRule",
        ["id"],
        {
          id: rule.id,
          minPrice: 0,
          maxPrice: 999_999,
          minDesi: 0,
          maxDesi: 999,
          // Yalnız YENİ kayıtta tahmin edilir (eski yedekte alan yok); mevcut kuralın değeri korunur.
          vatIncluded: !(
            rule.cargoProvider?.toUpperCase().includes("TEX") ||
            rule.name.toUpperCase().includes("TEX")
          ),
          priority: 10,
          isActive: true,
          ...update,
        },
        update
      );
    }),
  });
  stats.cargoRules = jobs[jobs.length - 1].stmts.length;

  jobs.push({
    label: "Reklam bütçesi",
    statKey: "adBudgets",
    stmts: data.adBudgets.map((budget) => {
      const update = columnsFrom("AdBudget", budget, ["id"]);
      return upsert(
        "AdBudget",
        ["id"],
        { id: budget.id, isActive: true, createdAt: stamp, ...update },
        update
      );
    }),
  });
  stats.adBudgets = jobs[jobs.length - 1].stmts.length;

  jobs.push({
    label: "Kurallar",
    statKey: "expenseRules",
    stmts: (data.expenseRules ?? []).map((rule) => {
      const update = columnsFrom("ExpenseRule", rule, ["id"]);
      return upsert(
        "ExpenseRule",
        ["id"],
        { id: rule.id, minPrice: 0, maxPrice: 999_999, priority: 10, isActive: true, ...update },
        update
      );
    }),
  });
  stats.expenseRules = jobs[jobs.length - 1].stmts.length;

  // ── Giderler ──────────────────────────────────────────────────────────────
  // Kategoriler giderlere ADIYLA bağlı (ad tekil) → aynı adlı kategori varsa o kayıt güncellenir.
  const categoryIdByName = new Map<string, string>();
  if (data.expenseCategories.length) {
    for (const row of await readRows<{ id: string; name: string }>(
      `SELECT id, name FROM ExpenseCategory`
    )) {
      categoryIdByName.set(row.name, row.id);
    }
  }
  jobs.push({
    label: "Giderler",
    statKey: "expenseCategories",
    stmts: data.expenseCategories.map((category) => {
      const update = touched(columnsFrom("ExpenseCategory", category, ["id"]), category);
      const existingId = categoryIdByName.get(category.name);
      if (existingId) return updateById("ExpenseCategory", "id", existingId, update);
      categoryIdByName.set(category.name, category.id);
      return upsert(
        "ExpenseCategory",
        ["id"],
        { id: category.id, sortOrder: 0, createdAt: stamp, ...update },
        update
      );
    }),
  });
  stats.expenseCategories = jobs[jobs.length - 1].stmts.length;

  jobs.push({
    label: "Giderler",
    statKey: "recurringExpenses",
    stmts: data.recurringExpenses.map((rule) => {
      const update = touched(columnsFrom("RecurringExpense", rule, ["id"]), rule);
      return upsert(
        "RecurringExpense",
        ["id"],
        { id: rule.id, isActive: true, createdAt: stamp, ...update },
        update
      );
    }),
  });
  stats.recurringExpenses = jobs[jobs.length - 1].stmts.length;

  // Silinen otomatik gider dönemleri: geri gelmezse sabit gider o dönemi bir sonraki açılışta yeniden açar.
  jobs.push({
    label: "Giderler",
    statKey: "recurringExpenseSkips",
    stmts: data.recurringExpenseSkips.map((skip) => {
      const update = columnsFrom("RecurringExpenseSkip", skip, ["recurringId", "periodKey"]);
      return upsert(
        "RecurringExpenseSkip",
        ["recurringId", "periodKey"],
        { recurringId: skip.recurringId, periodKey: skip.periodKey, createdAt: stamp, ...update },
        update
      );
    }),
  });
  stats.recurringExpenseSkips = jobs[jobs.length - 1].stmts.length;

  // Aynı sabit giderin aynı dönemi hedefte BAŞKA kimlikle zaten varsa tekil indeks çakışır ve
  // satır atlanır (hedefsiz ON CONFLICT DO NOTHING) → o ayın gideri ikiye katlanmaz.
  jobs.push({
    label: "Giderler",
    statKey: "actualExpenses",
    stmts: data.actualExpenses.map((expense) => {
      const update = touched(columnsFrom("ActualExpense", expense, ["id"]), expense);
      return upsert(
        "ActualExpense",
        ["id"],
        { id: expense.id, createdAt: stamp, ...update },
        update
      );
    }),
  });
  stats.actualExpenses = jobs[jobs.length - 1].stmts.length;

  jobs.push({
    label: "Yazıcılar",
    statKey: "printerConfigs",
    stmts: printerConfigs.map((printer) => {
      const update = touched(columnsFrom("PrinterConfig", printer, ["id"]), printer);
      return upsert(
        "PrinterConfig",
        ["id"],
        {
          id: printer.id,
          type: "moonraker",
          port: 7125,
          enabled: true,
          sortOrder: 0,
          createdAt: stamp,
          ...update,
        },
        update
      );
    }),
  });
  stats.printerConfigs = jobs[jobs.length - 1].stmts.length;

  jobs.push({
    label: "Filament makaraları",
    statKey: "filamentSpools",
    stmts: filamentSpools.map((spool) => {
      const update = touched(columnsFrom("FilamentSpool", spool, ["id"]), spool);
      return upsert(
        "FilamentSpool",
        ["id"],
        {
          id: spool.id,
          material: "PLA",
          colorHex: "#9ca3af",
          totalGrams: 1000,
          remainingGrams: 1000,
          reorderGrams: 200,
          isActive: true,
          createdAt: stamp,
          ...update,
        },
        update
      );
    }),
  });
  stats.filamentSpools = jobs[jobs.length - 1].stmts.length;

  // ── Siparişler (ürüne bağlı değil) ────────────────────────────────────────
  const snapshots = data.orderFinanceSnapshots.filter(
    (snapshot) => snapshot.platform !== "manual"
  );
  const snapshotIdByKey = new Map<string, string>();
  if (snapshots.length) {
    for (const row of await readRows<{ id: string; platform: string; externalOrderId: string }>(
      `SELECT id, platform, externalOrderId FROM OrderFinanceSnapshot`
    )) {
      snapshotIdByKey.set(`${row.platform}\u0000${row.externalOrderId}`, row.id);
    }
  }
  jobs.push({
    label: "Siparişler",
    statKey: "orderFinanceSnapshots",
    stmts: snapshots.map((snapshot) => {
      const update = touched(
        columnsFrom("OrderFinanceSnapshot", snapshot, ["id", "platform", "externalOrderId"]),
        snapshot,
        "syncedAt"
      );
      const existingId = snapshotIdByKey.get(
        `${snapshot.platform}\u0000${snapshot.externalOrderId}`
      );
      if (existingId) return updateById("OrderFinanceSnapshot", "id", existingId, update);
      return upsert(
        "OrderFinanceSnapshot",
        ["platform", "externalOrderId"],
        {
          id: snapshot.id,
          platform: snapshot.platform,
          externalOrderId: snapshot.externalOrderId,
          profitPartial: false,
          currency: "TRY",
          calculationVersion: 1,
          profitSource: "calculated",
          ...update,
        },
        update
      );
    }),
  });
  stats.orderFinanceSnapshots = jobs[jobs.length - 1].stmts.length;

  const financialIdByKey = new Map<string, string>();
  if (data.platformOrderFinancials.length) {
    for (const row of await readRows<{ id: string; platform: string; externalOrderId: string }>(
      `SELECT id, platform, externalOrderId FROM PlatformOrderFinancial`
    )) {
      financialIdByKey.set(`${row.platform}\u0000${row.externalOrderId}`, row.id);
    }
  }
  jobs.push({
    label: "Siparişler",
    statKey: "platformOrderFinancials",
    stmts: data.platformOrderFinancials.map((financial) => {
      const update = touched(
        columnsFrom("PlatformOrderFinancial", financial, ["id", "platform", "externalOrderId"]),
        financial,
        "syncedAt"
      );
      const existingId = financialIdByKey.get(
        `${financial.platform}\u0000${financial.externalOrderId}`
      );
      if (existingId) return updateById("PlatformOrderFinancial", "id", existingId, update);
      return upsert(
        "PlatformOrderFinancial",
        ["platform", "externalOrderId"],
        {
          id: financial.id,
          platform: financial.platform,
          externalOrderId: financial.externalOrderId,
          transactionCount: 0,
          ...update,
        },
        update
      );
    }),
  });
  stats.platformOrderFinancials = jobs[jobs.length - 1].stmts.length;

  const manualOrderIds = new Set<string>();
  const manualOrderIdByNumber = new Map<string, string>();
  if (data.manualOrders.length) {
    for (const row of await readRows<{ id: string; orderNumber: string }>(
      `SELECT id, orderNumber FROM ManualOrder`
    )) {
      manualOrderIds.add(row.id);
      manualOrderIdByNumber.set(row.orderNumber, row.id);
    }
  }
  jobs.push({
    label: "Siparişler",
    statKey: "manualOrders",
    stmts: data.manualOrders.map((order) => {
      const update = touched(columnsFrom("ManualOrder", order, ["id"]), order);
      const existingId = manualOrderIds.has(order.id)
        ? order.id
        : manualOrderIdByNumber.get(order.orderNumber);
      if (existingId) return updateById("ManualOrder", "id", existingId, update);
      manualOrderIds.add(order.id);
      manualOrderIdByNumber.set(order.orderNumber, order.id);
      return upsert(
        "ManualOrder",
        ["orderNumber"],
        { id: order.id, createdAt: stamp, ...update },
        update
      );
    }),
  });
  stats.manualOrders = jobs[jobs.length - 1].stmts.length;

  // ── Varyant grupları → Ürünler ────────────────────────────────────────────
  jobs.push({
    label: "Varyant grupları",
    statKey: "variantGroups",
    stmts: variantGroups.map((group) => {
      const update = touched(columnsFrom("VariantGroup", group, ["id"]), group);
      return upsert(
        "VariantGroup",
        ["id"],
        { id: group.id, shareModels: false, createdAt: stamp, ...update },
        update
      );
    }),
  });
  stats.variantGroups = jobs[jobs.length - 1].stmts.length;

  const productStmts: Stmt[] = [];
  for (const product of products) {
    // Grubu bulunmayan ürün ARTIK hata değil: ürün korunur, yalnız grup bağı boş kalır.
    let variantGroupId = product.variantGroupId ?? null;
    if (variantGroupId && !variantGroupIds.has(variantGroupId)) {
      variantGroupId = null;
      droppedLinks++;
    }

    const update = touched(
      columnsFrom("Product", product, ["id", "barcode", "variantGroupId"]),
      product
    );
    if (product.variantGroupId !== undefined) update.variantGroupId = variantGroupId;

    const existingId = barcodeToProductId.get(product.barcode);
    if (existingId) {
      productIdMap.set(product.id, existingId);
      productStmts.push(updateById("Product", "id", existingId, update));
      continue;
    }
    // Kimlik başka bir barkodda kullanılıyorsa yeni kimlik üret (ürün kaybolmasın).
    const newId = productIds.has(product.id) ? `imp_${randomUUID()}` : product.id;
    productStmts.push(
      upsert(
        "Product",
        ["barcode"],
        {
          id: newId,
          barcode: product.barcode,
          // Zorunlu kolonlar yedekte yoksa (eski/yabancı yedek) yalnız YENİ kayıtta doldurulur.
          sku: product.barcode,
          name: product.barcode,
          categoryName: "Imported",
          stock: 0,
          imageManual: false,
          isActive: true,
          hidden: false,
          madeToOrder: false,
          source: "imported",
          createdAt: stamp,
          ...update,
          variantGroupId,
        },
        update
      )
    );
    productIdMap.set(product.id, newId);
    productIds.add(newId);
    barcodeToProductId.set(product.barcode, newId);
  }
  jobs.push({ label: "Ürünler", statKey: "products", stmts: productStmts });
  stats.products = productStmts.length;

  // ── Ürüne bağlı tablolar (ürün kimlik eşlemesi ARTIK hazır) ──────────────
  const costIdByProduct = new Map<string, string>();
  if (productCosts.length) {
    for (const row of await readRows<{ id: string; productId: string }>(
      `SELECT id, productId FROM ProductCost`
    )) {
      costIdByProduct.set(row.productId, row.id);
    }
  }
  const costStmts: Stmt[] = [];
  for (const cost of productCosts) {
    const productId = resolveProduct(cost.productId);
    if (!productId) {
      stats.skipped++;
      continue;
    }
    const update = touched(columnsFrom("ProductCost", cost, ["id", "productId"]), cost);
    const existingId = costIdByProduct.get(productId);
    if (existingId) {
      costStmts.push(updateById("ProductCost", "id", existingId, update));
    } else {
      costIdByProduct.set(productId, cost.id);
      costStmts.push(
        upsert(
          "ProductCost",
          ["productId"],
          { id: cost.id, productId, costMode: "manual", ...update },
          update
        )
      );
    }
  }
  jobs.push({ label: "Maliyetler", statKey: "productCosts", stmts: costStmts });
  stats.productCosts = costStmts.length;

  const listingIdByKey = new Map<string, string>();
  if (listings.length) {
    for (const row of await readRows<{ id: string; productId: string; platform: string }>(
      `SELECT id, productId, platform FROM Listing`
    )) {
      listingIdByKey.set(`${row.productId}\u0000${row.platform}`, row.id);
    }
  }
  const listingStmts: Stmt[] = [];
  for (const listing of listings) {
    const productId = resolveProduct(listing.productId);
    if (!productId) {
      stats.skipped++;
      continue;
    }
    const update = touched(
      columnsFrom("Listing", listing, ["id", "productId", "platform"]),
      listing
    );
    const key = `${productId}\u0000${listing.platform}`;
    const existingId = listingIdByKey.get(key);
    if (existingId) {
      listingStmts.push(updateById("Listing", "id", existingId, update));
    } else {
      listingIdByKey.set(key, listing.id);
      listingStmts.push(
        upsert(
          "Listing",
          ["productId", "platform"],
          {
            id: listing.id,
            productId,
            platform: listing.platform,
            stock: 0,
            isActive: true,
            createdAt: stamp,
            ...update,
          },
          update
        )
      );
    }
  }
  jobs.push({ label: "Platform kayıtları", statKey: "listings", stmts: listingStmts });
  stats.listings = listingStmts.length;

  const historyStmts: Stmt[] = [];
  for (const history of priceHistory) {
    const productId = resolveProduct(history.productId);
    if (!productId) {
      stats.skipped++;
      continue;
    }
    const update = columnsFrom("PriceHistory", history, ["id", "productId"]);
    update.productId = productId;
    historyStmts.push(upsert("PriceHistory", ["id"], { id: history.id, ...update }, update));
  }
  jobs.push({ label: "Fiyat geçmişi", statKey: "priceHistory", stmts: historyStmts });
  stats.priceHistory = historyStmts.length;

  const modelStmts: Stmt[] = [];
  for (const file of modelFiles) {
    if (!printerIds.has(file.printerConfigId)) {
      stats.skipped++;
      continue;
    }
    // Özel baskılar gerçek bir ürüne bağlı değildir; uygulama genelinde bu sentinel ile saklanır.
    const productId =
      file.productId === CUSTOM_PRINT_PRODUCT_ID
        ? CUSTOM_PRINT_PRODUCT_ID
        : resolveProduct(file.productId);
    if (!productId) {
      stats.skipped++;
      continue;
    }
    // `storedPath` bilinçli olarak yedeğe girmez (yerel yol): yeni kayıtta boş, mevcutta korunur.
    // Önizleme görseli model dosyası satırına DEĞİL, kendi tablosuna yazılır (aşağıda; v63).
    const update = touched(columnsFrom("ProductModelFile", file, ["id", "productId"]), file);
    update.productId = productId;
    modelStmts.push(
      upsert(
        "ProductModelFile",
        ["id"],
        { id: file.id, storedPath: "", sizeBytes: 0, sortOrder: 0, createdAt: stamp, ...update },
        update
      )
    );
    if (file.thumbnail) {
      modelStmts.push(
        upsert("ProductModelFileThumb", ["fileId"], { fileId: file.id, thumbnail: file.thumbnail }, { thumbnail: file.thumbnail })
      );
    }
  }
  jobs.push({ label: "Baskı dosyaları", statKey: "productModelFiles", stmts: modelStmts });
  // Görsel ifadeleri ayrı satır değildir — sayaç yalnız model dosyalarını sayar.
  stats.productModelFiles = modelStmts.filter((m) => !m.sql.includes('"ProductModelFileThumb"')).length;

  const mappingIdByKey = new Map<string, string>();
  if (printFileProducts.length) {
    for (const row of await readRows<{ id: string; printerConfigId: string; filename: string }>(
      `SELECT id, printerConfigId, filename FROM PrintFileProduct`
    )) {
      mappingIdByKey.set(`${row.printerConfigId}\u0000${row.filename}`, row.id);
    }
  }
  const mappingStmts: Stmt[] = [];
  for (const mapping of printFileProducts) {
    const productId = resolveProduct(mapping.productId);
    if (!productId || !printerIds.has(mapping.printerConfigId)) {
      stats.skipped++;
      continue;
    }
    const update = touched(
      columnsFrom("PrintFileProduct", mapping, ["id", "printerConfigId", "filename", "productId"]),
      mapping
    );
    update.productId = productId;
    const key = `${mapping.printerConfigId}\u0000${mapping.filename}`;
    const existingId = mappingIdByKey.get(key);
    if (existingId) {
      mappingStmts.push(updateById("PrintFileProduct", "id", existingId, update));
    } else {
      mappingIdByKey.set(key, mapping.id);
      mappingStmts.push(
        upsert(
          "PrintFileProduct",
          ["printerConfigId", "filename"],
          {
            id: mapping.id,
            printerConfigId: mapping.printerConfigId,
            filename: mapping.filename,
            createdAt: stamp,
            ...update,
          },
          update
        )
      );
    }
  }
  jobs.push({ label: "Baskı dosyaları", statKey: "printFileProducts", stmts: mappingStmts });
  stats.printFileProducts = mappingStmts.length;

  const usageStmts: Stmt[] = [];
  for (const usage of filamentUsages) {
    if (!spoolIds.has(usage.spoolId)) {
      stats.skipped++;
      continue;
    }
    const update = columnsFrom("FilamentUsage", usage, ["id", "productId"]);
    if (usage.productId !== undefined) {
      let productId: string | null = null;
      if (usage.productId) {
        productId = resolveProduct(usage.productId);
        // Ürün silinmişse kullanım kaydı yine korunur (gram düşümü geçmişi kaybolmasın).
        if (!productId) droppedLinks++;
      }
      update.productId = productId;
    }
    usageStmts.push(
      upsert("FilamentUsage", ["id"], { id: usage.id, createdAt: stamp, ...update }, update)
    );
  }
  jobs.push({ label: "Filament kullanımları", statKey: "filamentUsages", stmts: usageStmts });
  stats.filamentUsages = usageStmts.length;

  // ── Sipariş kalemleri (ürün kimliği eşlendikten SONRA) ────────────────────
  // ⚠️ Bunlar eskiden ürünlerden ÖNCE hazırlanıyordu: yeni veritabanına geri yüklemede ürünler
  // henüz eşlenmemiş olduğundan "Ürüne bağla" bağlarının TAMAMI atlanıyor, kalem ve maliyet
  // satırlarındaki ürün kimliği de bu veritabanındaki karşılığına çevrilmiyordu.

  // Ürün bazlı satış geçmişi. Eski yedeklerde bu dizi boştur ve mevcut kayıtlara DOKUNULMAZ
  // (silme yok, yalnız ekleme/güncelleme).
  const itemSnapshots = data.orderItemSnapshots.filter((row) => row.platform !== "manual");
  const itemIdByKey = new Map<string, string>();
  if (itemSnapshots.length) {
    for (const row of await readRows<{
      id: string;
      platform: string;
      externalOrderId: string;
      lineIndex: number;
    }>(`SELECT id, platform, externalOrderId, lineIndex FROM OrderItemSnapshot`)) {
      itemIdByKey.set(
        `${row.platform}\u0000${row.externalOrderId}\u0000${row.lineIndex}`,
        row.id
      );
    }
  }
  jobs.push({
    label: "Satış geçmişi",
    statKey: "orderItemSnapshots",
    stmts: itemSnapshots.map((row) => {
      const update = columnsFrom("OrderItemSnapshot", row, [
        "id",
        "platform",
        "externalOrderId",
        "lineIndex",
        "productId",
      ]);
      // Ürün bu veritabanında başka kimlikle duruyorsa ona taşınır; karşılığı yoksa kimlik
      // olduğu gibi kalır (satış geçmişi ürün adıyla birlikte korunur).
      if (row.productId !== undefined) {
        update.productId = row.productId ? (resolveProduct(row.productId) ?? row.productId) : null;
      }
      const existingId = itemIdByKey.get(
        `${row.platform}\u0000${row.externalOrderId}\u0000${row.lineIndex}`
      );
      if (existingId) return updateById("OrderItemSnapshot", "id", existingId, update);
      return upsert(
        "OrderItemSnapshot",
        ["platform", "externalOrderId", "lineIndex"],
        {
          id: row.id,
          platform: row.platform,
          externalOrderId: row.externalOrderId,
          lineIndex: row.lineIndex,
          currency: "TRY",
          syncedAt: stamp,
          ...update,
        },
        update
      );
    }),
  });
  stats.orderItemSnapshots = jobs[jobs.length - 1].stmts.length;

  // Siparişe özel maliyetler. Satır anahtarı katalog ürününe bağlıysa ("p:<ürün>") ürün kimliği
  // bu veritabanındaki karşılığına taşınır; eşleşmeyen ürünün anahtarı olduğu gibi kalır.
  jobs.push({
    label: "Siparişe özel maliyetler",
    statKey: "orderLineCosts",
    stmts: data.orderLineCosts.map((row) => {
      const lineKey = row.lineKey.startsWith("p:")
        ? `p:${resolveProduct(row.lineKey.slice(2)) ?? row.lineKey.slice(2)}`
        : row.lineKey;
      const update = touched(
        columnsFrom("OrderLineCost", row, ["id", "platform", "externalOrderId", "lineKey"]),
        row
      );
      return upsert(
        "OrderLineCost",
        ["platform", "externalOrderId", "lineKey"],
        {
          id: row.id,
          platform: row.platform,
          externalOrderId: row.externalOrderId,
          lineKey,
          lineName: "",
          createdAt: stamp,
          ...update,
        },
        update
      );
    }),
  });
  stats.orderLineCosts = jobs[jobs.length - 1].stmts.length;

  // Elle ürün bağları. Ürün kimliği bu veritabanındaki karşılığına taşınır; karşılığı olmayan
  // ürüne giden bağ anlamsız → atlanır (satır yeniden "Ürüne bağla" der).
  const baglar = data.orderLineLinks.flatMap((row) => {
    const productId = resolveProduct(row.productId);
    if (!productId) {
      stats.skipped++;
      return [];
    }
    return [{ ...row, productId }];
  });
  jobs.push({
    label: "Ürün bağları",
    statKey: "orderLineLinks",
    stmts: baglar.map((row) => {
      const update = touched(
        columnsFrom("OrderLineLink", row, ["id", "platform", "lineKey"]),
        row
      );
      return upsert(
        "OrderLineLink",
        ["platform", "lineKey"],
        { id: row.id, platform: row.platform, lineKey: row.lineKey, lineName: "", createdAt: stamp, ...update },
        update
      );
    }),
  });
  stats.orderLineLinks = jobs[jobs.length - 1].stmts.length;

  // Elle girilen Shopify kargo desileri (sipariş başına tek kayıt).
  jobs.push({
    label: "Kargo desileri",
    statKey: "orderCargoDesis",
    stmts: data.orderCargoDesis.map((row) => {
      const update = touched(columnsFrom("OrderCargoDesi", row, ["id", "platform", "externalOrderId"]), row);
      return upsert(
        "OrderCargoDesi",
        ["platform", "externalOrderId"],
        { id: row.id, platform: row.platform, externalOrderId: row.externalOrderId, createdAt: stamp, ...update },
        update
      );
    }),
  });
  stats.orderCargoDesis = jobs[jobs.length - 1].stmts.length;

  // Uygulamadan açılan kargo gönderileri (barkod başına tek kayıt).
  jobs.push({
    label: "Kargo gönderileri",
    statKey: "cargoShipments",
    stmts: data.cargoShipments.map((row) => {
      // Tabloda "updatedAt" yok (zamanlar epoch-ms kolonlarında) → touched() kullanılmaz.
      const update = columnsFrom("CargoShipment", row, ["id", "barcode"]);
      return upsert("CargoShipment", ["barcode"], { id: row.id, barcode: row.barcode, ...update }, update);
    }),
  });
  stats.cargoShipments = jobs[jobs.length - 1].stmts.length;

  // ── Yazım: 500'lük gruplar, tek istek; başarısızsa satır satır güvenli yol ─
  const total = jobs.reduce((sum, job) => sum + job.stmts.length, 0);
  let done = 0;
  const report = (label: string) =>
    emit({
      stage: "step",
      label,
      done,
      total,
      pct: total === 0 ? 100 : Math.min(100, Math.round((done / total) * 100)),
    });

  report("Hazırlanıyor");
  for (const job of jobs) {
    if (job.stmts.length === 0) continue;
    report(job.label);
    for (let offset = 0; offset < job.stmts.length; offset += CHUNK) {
      const chunk = job.stmts.slice(offset, offset + CHUNK);
      if (!(await batchWrite(chunk))) {
        // Toplu yazım bu modda kapalı (yerel/replica) veya grup geri alındı → satır satır.
        for (const statement of chunk) {
          try {
            await prisma.$executeRawUnsafe(statement.sql, ...(statement.args as never[]));
          } catch {
            // Tek bir bozuk satır tüm geri yüklemeyi çökertmesin.
            stats.skipped++;
            if (job.statKey) stats[job.statKey]--;
          }
        }
      }
      done += chunk.length;
      report(job.label);
    }
  }

  if (stats.skipped > 0) {
    warnings.push(
      `${stats.skipped} kayıt atlandı: bağlı olduğu ürün, yazıcı veya makara artık yok.`
    );
  }
  if (droppedLinks > 0) {
    warnings.push(`${droppedLinks} kayıt eski bağlantısı olmadan geri yüklendi.`);
  }

  // Yedekten geri yükleme HER TABLOYU değiştirir → tüm önbellek katmanları (bellek + disk) gitsin.
  bustCache();
  // Yazıcı paneli/relay'in süreç içi önbellekleri de eski veriyi tutmasın (geri yükleme her şeyi değiştirir).
  for (const ad of Object.values(BAYAT_ONBELLEK)) bayatOnbellegiDusur(ad);
  invalidateOrdersCache();

  return {
    ok: warnings.length === 0,
    complete: warnings.length === 0,
    stats,
    warnings,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return `Yedek biçimi geçersiz: ${error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ")}`;
  }
  return error instanceof Error ? error.message : "Import başarısız";
}

/**
 * Yedeği geri yükler.
 *  - Normal çağrı → tek JSON yanıt (eski davranış birebir korunur).
 *  - `?stream=1` veya `Accept: application/x-ndjson` → NDJSON ilerleme akışı:
 *      {stage:"step",label,done,total,pct} · {stage:"done",stats,warnings} · {stage:"error",message}
 *
 * Sürüm denetimi (madde 20): bu uygulamadan DAHA YENİ bir sürümün yedeği reddedilir (tanımadığımız
 * alanlar sessizce düşmesin); eski yedek alınır ama yanıtta kısa bir uyarı satırı taşır.
 */
export async function POST(req: NextRequest) {
  let data: ImportPayload;
  let oldBackup = false;
  try {
    await ensureRuntimeSchema();
    const raw: unknown = await req.json();
    // Sürüm, biçim doğrulamasından ÖNCE: daha yeni sürümün yedeği tanınmayan bir alan yüzünden
    // "biçim geçersiz" yerine anlaşılır mesajla reddedilsin.
    const verdict = backupVersionVerdict(backupVersionInfo(raw), await readAppSchemaVersion());
    if (verdict === "yeni") {
      return NextResponse.json(
        { ok: false, complete: false, error: YEDEK_DAHA_YENI_HATASI },
        { status: 400 }
      );
    }
    oldBackup = verdict === "eski";
    data = ImportSchema.parse(raw);
  } catch (error) {
    // Doğrulama akıştan ÖNCE yapılır → bozuk yedek hâlâ net bir hata yanıtı döner.
    return NextResponse.json(
      { ok: false, complete: false, error: errorMessage(error) },
      { status: 400 }
    );
  }

  // NOT: nextUrl yerine standart URL — testler düz Request gönderiyor.
  let streamParam: string | null = null;
  try {
    streamParam = new URL(req.url).searchParams.get("stream");
  } catch {
    streamParam = null;
  }
  const wantsStream =
    streamParam === "1" ||
    (req.headers.get("accept") ?? "").includes("application/x-ndjson");

  if (!wantsStream) {
    try {
      return NextResponse.json(await runImport(data, () => {}, { oldBackup }));
    } catch (error) {
      return NextResponse.json(
        { ok: false, complete: false, error: errorMessage(error) },
        { status: 400 }
      );
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send: Emit = (event) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          /* akış kapandı */
        }
      };
      try {
        const result = await runImport(data, send, { oldBackup });
        send({ stage: "done", ...result });
      } catch (error) {
        send({ stage: "error", message: errorMessage(error) });
      } finally {
        try {
          controller.close();
        } catch {
          /* akış zaten kapalı (istemci ayrıldı) */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
