import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { batchWrite } from "@/lib/libsql-batch";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { invalidateOrdersCache } from "@/lib/orders-cache";
import { bustCache } from "@/lib/route-cache";
import { validateManualOrderCapturedFinance } from "@/lib/manual-orders";
import { toDbDate } from "@/lib/sqlite-date";

export const dynamic = "force-dynamic";

const id = z.string().trim().min(1);
const finite = z.number().finite();
const integer = finite.int();
const sqliteInt = integer.min(-2_147_483_648).max(2_147_483_647);
const nullableString = z.string().nullable().optional();
const optionalDate = z.coerce.date().optional();
const nullableDate = z.coerce.date().nullable().optional();

const VariantGroupSchema = z.object({
  id,
  name: z.string(),
  shareModels: z.boolean().optional(),
  createdAt: optionalDate,
  updatedAt: optionalDate,
});

const ProductSchema = z.object({
  id,
  barcode: id,
  sku: z.string().optional(),
  name: z.string().optional(),
  alias: nullableString,
  categoryName: z.string().optional(),
  currentSalePrice: finite,
  listPrice: finite.nullable().optional(),
  stock: integer.optional(),
  desi: finite.nullable().optional(),
  weight: finite.nullable().optional(),
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
  commissionRate: finite.nullable().optional(),
  commissionSource: nullableString,
  commissionUpdatedAt: nullableDate,
  createdAt: optionalDate,
  updatedAt: optionalDate,
});

const ProductCostSchema = z.object({
  id,
  productId: id,
  costMode: z.string().optional(),
  templateId: nullableString,
  filamentTypeId: nullableString,
  filamentWeight: finite.nullable().optional(),
  printTimeHours: finite.nullable().optional(),
  wasteRate: finite.nullable().optional(),
  packagingPoset: finite.nullable().optional(),
  packagingNaylon: finite.nullable().optional(),
  packagingBant: finite.nullable().optional(),
  packagingKart: finite.nullable().optional(),
  packagingOptionId: nullableString,
  nylonLevel: nullableString,
  tapeUsed: z.boolean().nullable().optional(),
  manualCost: finite.nullable().optional(),
  materialWeight: finite.nullable().optional(),
  materialCost: finite.nullable().optional(),
  electricityCost: finite.nullable().optional(),
  machineWearCost: finite.nullable().optional(),
  laborCost: finite.nullable().optional(),
  packagingCost: finite.nullable().optional(),
  otherCost: finite.nullable().optional(),
  totalCost: finite.nullable().optional(),
  updatedAt: optionalDate,
});

const ListingSchema = z.object({
  id,
  productId: id,
  platform: id,
  externalId: nullableString,
  externalSku: nullableString,
  barcode: nullableString,
  salePrice: finite,
  listPrice: finite.nullable().optional(),
  stock: integer.optional(),
  commissionRate: finite.nullable().optional(),
  commissionFixed: finite.nullable().optional(),
  cargoCost: finite.nullable().optional(),
  isActive: z.boolean().optional(),
  lastSyncedAt: nullableDate,
  createdAt: optionalDate,
  updatedAt: optionalDate,
});

const FilamentTypeSchema = z.object({
  id,
  name: z.string(),
  costPerGram: finite,
  isActive: z.boolean().optional(),
});

const FilamentSpoolSchema = z.object({
  id,
  name: z.string(),
  material: z.string().optional(),
  colorName: nullableString,
  colorHex: z.string().optional(),
  brand: nullableString,
  totalGrams: finite.optional(),
  remainingGrams: finite.optional(),
  spoolCost: finite.nullable().optional(),
  reorderGrams: finite.optional(),
  vendorUrl: nullableString,
  // v37: envanter gruplaması + kapalı/açık durumu. Opsiyonel → eski (v3) yedekler aynen yüklenir.
  colorKey: nullableString,
  openedAt: optionalDate.nullable(),
  isActive: z.boolean().optional(),
  createdAt: optionalDate,
  updatedAt: optionalDate,
});

const FilamentUsageSchema = z.object({
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

const CommissionRuleSchema = z.object({
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
});

const CargoRuleSchema = z.object({
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

const ExpenseRuleSchema = z.object({
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

const ActualExpenseSchema = z.object({
  id,
  name: z.string().trim().min(1),
  category: nullableString,
  amountKurus: integer.positive().max(2_147_483_647),
  paidAt: z.coerce.date(),
  note: nullableString,
  createdAt: optionalDate,
  updatedAt: optionalDate,
});

const OrderFinanceSnapshotSchema = z.object({
  id,
  platform: id,
  externalOrderId: id,
  orderNumber: z.string(),
  orderedAt: z.coerce.date(),
  revenueKurus: integer.nonnegative().max(2_147_483_647),
  profitKurus: sqliteInt.nullable().optional(),
  profitPartial: z.boolean().optional(),
  statusKind: z.string(),
  currency: z.string().optional(),
  syncedAt: optionalDate,
  calculationVersion: integer.positive().optional(),
  profitSource: z.enum(["calculated", "platform"]).optional(),
  estimatedCommissionKurus: sqliteInt.nullable().optional(),
  actualCommissionKurus: sqliteInt.nullable().optional(),
});

/** Ürün bazlı satış geçmişi — yedeğe bu oturumda eklendi, eski yedeklerde YOK (opsiyonel). */
const OrderItemSnapshotSchema = z.object({
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
});

const PlatformOrderFinancialSchema = z.object({
  id,
  platform: id,
  externalOrderId: id,
  orderNumber: z.string(),
  grossRevenueKurus: integer.nonnegative().max(2_147_483_647),
  commissionKurus: integer.nonnegative().max(2_147_483_647),
  sellerRevenueKurus: integer.nonnegative().max(2_147_483_647),
  transactionCount: integer.nonnegative().optional(),
  sourceUpdatedAt: optionalDate,
  syncedAt: optionalDate,
});

const ManualOrderSchema = z
  .object({
    id,
    orderNumber: z.string().trim().min(1).max(80),
    mode: z.enum(["catalog", "freeform"]),
    orderedAt: z.coerce.date(),
    statusKind: z.enum([
      "pending",
      "processing",
      "shipped",
      "delivered",
      "cancelled",
    ]),
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
  })
  .superRefine((order, ctx) => {
    try {
      validateManualOrderCapturedFinance(order);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          error instanceof Error
            ? error.message
            : "Manuel sipariş hesap kaydı geçersiz.",
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

const PriceHistorySchema = z.object({
  id,
  productId: id,
  oldPrice: finite,
  newPrice: finite,
  changeSource: z.string(),
  changedAt: z.coerce.date(),
  note: nullableString,
});

const PrinterConfigSchema = z.object({
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

const PrintFileProductSchema = z.object({
  id,
  printerConfigId: id,
  filename: id,
  productId: id,
  createdAt: optionalDate,
  updatedAt: optionalDate,
});

const ProductModelFileSchema = z.object({
  id,
  productId: id,
  printerConfigId: id,
  label: nullableString,
  originalName: z.string(),
  storedPath: z.string().optional(),
  r2Key: nullableString,
  fileType: z.string(),
  sizeBytes: integer.optional(),
  gramaj: finite.nullable().optional(),
  estPrintMin: integer.nullable().optional(),
  colorsJson: nullableString,
  sliced: z.boolean().nullable().optional(),
  plateJson: nullableString,
  thumbnail: nullableString,
  contentMd5: nullableString,
  sortOrder: integer.optional(),
  createdAt: optionalDate,
  updatedAt: optionalDate,
  storageKind: z.string().optional(),
  fileBytesIncluded: z.boolean().optional(),
});

const ImportSchema = z.object({
  version: z.number().int().positive().optional(),
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
  expenseRules: z.array(ExpenseRuleSchema).optional(),
  actualExpenses: z.array(ActualExpenseSchema).optional().default([]),
  orderFinanceSnapshots: z.array(OrderFinanceSnapshotSchema).optional().default([]),
  orderItemSnapshots: z.array(OrderItemSnapshotSchema).optional().default([]),
  platformOrderFinancials: z
    .array(PlatformOrderFinancialSchema)
    .optional()
    .default([]),
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
/** Migration kilidi yedekten geri gelirse açılış migration'ını 3 dakika bloklar → asla yazma. */
const SKIPPED_SETTING_KEYS = new Set(["schemaMigrationLock"]);
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
  return {
    sql: `UPDATE "${table}" SET ${cols.map((c) => `"${c}" = ?`).join(", ")} WHERE "${keyColumn}" = ?`,
    args: [...cols.map((c) => toArg(fields[c])), keyValue],
  };
}

/** Yalnız tanımlı alanları hedefe kopyala (yedekte olmayan alan mevcut değeri EZMESİN). */
function putDefined(target: Row, source: Row, keys: string[]): Row {
  for (const key of keys) {
    if (source[key] !== undefined) target[key] = source[key];
  }
  return target;
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
  expenseRules: number;
  actualExpenses: number;
  orderFinanceSnapshots: number;
  orderFinanceSnapshotsSkipped: number;
  orderItemSnapshots: number;
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

/**
 * Yedeği geri yükler. Tek dev transaction YOK: tablolar bağımlılık sırasına göre işlenir,
 * yazımlar 500'lük gruplar hâlinde tek libSQL isteğine toplanır (uzak modda her ifade ~96ms
 * ve tüm uygulama boyunca sıralı olduğundan satır-satır yazım dakikalar sürüp zaman aşımına
 * düşüyordu). Referansı bulunamayan satır hata vermez; atlanır ve sayılır.
 */
async function runImport(data: ImportPayload, emit: Emit) {
  const localModelFiles = (data.productModelFiles ?? []).filter((file) => !file.r2Key);
  const legacyManualSnapshots = data.orderFinanceSnapshots.filter(
    (snapshot) => snapshot.platform === "manual"
  );
  const warnings = [...new Set(data.metadata?.warnings ?? [])];
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
    expenseRules: 0,
    actualExpenses: 0,
    orderFinanceSnapshots: 0,
    orderFinanceSnapshotsSkipped: legacyManualSnapshots.length,
    orderItemSnapshots: 0,
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
    modelFiles.length > 0;

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
      const fields = { name: f.name, costPerGram: f.costPerGram, isActive: f.isActive ?? true };
      return upsert("FilamentType", ["id"], { id: f.id, ...fields }, fields);
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
      const fields = {
        name: rule.name,
        categoryName: rule.categoryName ?? null,
        minPrice: rule.minPrice ?? 0,
        maxPrice: rule.maxPrice ?? 999_999,
        commissionRate: rule.commissionRate,
        fixedCommission: rule.fixedCommission ?? 0,
        validFrom: rule.validFrom ?? null,
        validTo: rule.validTo ?? null,
        priority: rule.priority ?? 10,
        isActive: rule.isActive ?? true,
      };
      return upsert("CommissionRule", ["id"], { id: rule.id, ...fields }, fields);
    }),
  });
  stats.commissionRules = jobs[jobs.length - 1].stmts.length;

  jobs.push({
    label: "Kurallar",
    statKey: "cargoRules",
    stmts: (data.cargoRules ?? []).map((rule) => {
      const fields = {
        name: rule.name,
        platform: rule.platform ?? null,
        cargoProvider: rule.cargoProvider ?? null,
        categoryName: rule.categoryName ?? null,
        minPrice: rule.minPrice ?? 0,
        maxPrice: rule.maxPrice ?? 999_999,
        minDesi: rule.minDesi ?? 0,
        maxDesi: rule.maxDesi ?? 999,
        cargoCost: rule.cargoCost,
        vatIncluded:
          rule.vatIncluded ??
          !(
            rule.cargoProvider?.toUpperCase().includes("TEX") ||
            rule.name.toUpperCase().includes("TEX")
          ),
        validFrom: rule.validFrom ?? null,
        validTo: rule.validTo ?? null,
        priority: rule.priority ?? 10,
        isActive: rule.isActive ?? true,
      };
      return upsert("CargoRule", ["id"], { id: rule.id, ...fields }, fields);
    }),
  });
  stats.cargoRules = jobs[jobs.length - 1].stmts.length;

  jobs.push({
    label: "Kurallar",
    statKey: "expenseRules",
    stmts: (data.expenseRules ?? []).map((rule) => {
      const fields = {
        name: rule.name,
        platform: rule.platform ?? null,
        type: rule.type,
        value: rule.value,
        categoryName: rule.categoryName ?? null,
        minPrice: rule.minPrice ?? 0,
        maxPrice: rule.maxPrice ?? 999_999,
        priority: rule.priority ?? 10,
        isActive: rule.isActive ?? true,
      };
      return upsert("ExpenseRule", ["id"], { id: rule.id, ...fields }, fields);
    }),
  });
  stats.expenseRules = jobs[jobs.length - 1].stmts.length;

  jobs.push({
    label: "Giderler",
    statKey: "actualExpenses",
    stmts: data.actualExpenses.map((expense) => {
      const fields: Row = {
        name: expense.name,
        category: expense.category ?? null,
        amountKurus: expense.amountKurus,
        paidAt: expense.paidAt,
        note: expense.note ?? null,
      };
      const update = putDefined({ ...fields }, expense, ["createdAt"]);
      update.updatedAt = expense.updatedAt ?? stamp;
      return upsert(
        "ActualExpense",
        ["id"],
        {
          id: expense.id,
          ...fields,
          createdAt: expense.createdAt ?? stamp,
          updatedAt: expense.updatedAt ?? stamp,
        },
        update
      );
    }),
  });
  stats.actualExpenses = jobs[jobs.length - 1].stmts.length;

  jobs.push({
    label: "Yazıcılar",
    statKey: "printerConfigs",
    stmts: printerConfigs.map((printer) => {
      const fields: Row = {
        name: printer.name,
        brand: printer.brand,
        model: printer.model ?? null,
        type: printer.type ?? "moonraker",
        host: printer.host,
        port: printer.port ?? 7125,
        accent: printer.accent ?? null,
        accessCode: printer.accessCode ?? null,
        serial: printer.serial ?? null,
        enabled: printer.enabled ?? true,
        sortOrder: printer.sortOrder ?? 0,
      };
      const update = putDefined({ ...fields }, printer, ["createdAt"]);
      update.updatedAt = printer.updatedAt ?? stamp;
      return upsert(
        "PrinterConfig",
        ["id"],
        {
          id: printer.id,
          ...fields,
          createdAt: printer.createdAt ?? stamp,
          updatedAt: printer.updatedAt ?? stamp,
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
      const fields: Row = {
        name: spool.name,
        material: spool.material ?? "PLA",
        colorName: spool.colorName ?? null,
        colorHex: spool.colorHex ?? "#9ca3af",
        brand: spool.brand ?? null,
        totalGrams: spool.totalGrams ?? 1000,
        remainingGrams: spool.remainingGrams ?? 1000,
        spoolCost: spool.spoolCost ?? null,
        reorderGrams: spool.reorderGrams ?? 200,
        vendorUrl: spool.vendorUrl ?? null,
        // v37: zod'a eklemek YETMEZ — burada da yazılmazsa geri yüklemede SESSİZCE kaybolur.
        // `fields` hem INSERT hem UPDATE'e gittiği için iki yol da kapsanır; `openedAt` bir Date
        // olduğundan `toArg()` onu epoch-ms'e çevirir (createdAt/updatedAt ile aynı yol).
        colorKey: spool.colorKey ?? null,
        openedAt: spool.openedAt ?? null,
        isActive: spool.isActive ?? true,
      };
      const update = putDefined({ ...fields }, spool, ["createdAt"]);
      update.updatedAt = spool.updatedAt ?? stamp;
      return upsert(
        "FilamentSpool",
        ["id"],
        {
          id: spool.id,
          ...fields,
          createdAt: spool.createdAt ?? stamp,
          updatedAt: spool.updatedAt ?? stamp,
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
      const fields: Row = {
        orderNumber: snapshot.orderNumber,
        orderedAt: snapshot.orderedAt,
        revenueKurus: snapshot.revenueKurus,
        profitKurus: snapshot.profitKurus ?? null,
        profitPartial: snapshot.profitPartial ?? false,
        statusKind: snapshot.statusKind,
        currency: snapshot.currency ?? "TRY",
        syncedAt: snapshot.syncedAt ?? stamp,
        calculationVersion: snapshot.calculationVersion ?? 1,
        profitSource: snapshot.profitSource ?? "calculated",
        estimatedCommissionKurus: snapshot.estimatedCommissionKurus ?? null,
        actualCommissionKurus: snapshot.actualCommissionKurus ?? null,
      };
      const existingId = snapshotIdByKey.get(
        `${snapshot.platform}\u0000${snapshot.externalOrderId}`
      );
      if (existingId) return updateById("OrderFinanceSnapshot", "id", existingId, fields);
      return upsert(
        "OrderFinanceSnapshot",
        ["platform", "externalOrderId"],
        {
          id: snapshot.id,
          platform: snapshot.platform,
          externalOrderId: snapshot.externalOrderId,
          ...fields,
        },
        fields
      );
    }),
  });
  stats.orderFinanceSnapshots = jobs[jobs.length - 1].stmts.length;

  // Ürün bazlı satış geçmişi. Yedeğe bu oturumda eklendi → eski yedeklerde bu dizi boştur ve
  // mevcut kayıtlara DOKUNULMAZ (silme yok, yalnız ekleme/güncelleme).
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
      const fields: Row = {
        orderedAt: row.orderedAt,
        productId: row.productId ?? null,
        productName: row.productName,
        quantity: row.quantity,
        unitPriceKurus: row.unitPriceKurus,
        lineRevenueKurus: row.lineRevenueKurus,
        statusKind: row.statusKind,
        currency: row.currency ?? "TRY",
        syncedAt: stamp,
      };
      const existingId = itemIdByKey.get(
        `${row.platform}\u0000${row.externalOrderId}\u0000${row.lineIndex}`
      );
      if (existingId) return updateById("OrderItemSnapshot", "id", existingId, fields);
      return upsert(
        "OrderItemSnapshot",
        ["platform", "externalOrderId", "lineIndex"],
        {
          id: row.id,
          platform: row.platform,
          externalOrderId: row.externalOrderId,
          lineIndex: row.lineIndex,
          ...fields,
        },
        fields
      );
    }),
  });
  stats.orderItemSnapshots = jobs[jobs.length - 1].stmts.length;

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
      const fields: Row = {
        orderNumber: financial.orderNumber,
        grossRevenueKurus: financial.grossRevenueKurus,
        commissionKurus: financial.commissionKurus,
        sellerRevenueKurus: financial.sellerRevenueKurus,
        transactionCount: financial.transactionCount ?? 0,
        sourceUpdatedAt: financial.sourceUpdatedAt ?? null,
        syncedAt: financial.syncedAt ?? stamp,
      };
      const existingId = financialIdByKey.get(
        `${financial.platform}\u0000${financial.externalOrderId}`
      );
      if (existingId) return updateById("PlatformOrderFinancial", "id", existingId, fields);
      return upsert(
        "PlatformOrderFinancial",
        ["platform", "externalOrderId"],
        {
          id: financial.id,
          platform: financial.platform,
          externalOrderId: financial.externalOrderId,
          ...fields,
        },
        fields
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
      const fields: Row = {
        orderNumber: order.orderNumber,
        mode: order.mode,
        orderedAt: order.orderedAt,
        statusKind: order.statusKind,
        customerName: order.customerName ?? null,
        currency: order.currency,
        revenueKurus: order.revenueKurus,
        netRevenueKurus: order.netRevenueKurus,
        totalCostKurus: order.totalCostKurus,
        inputVatCreditKurus: order.inputVatCreditKurus,
        profitKurus: order.profitKurus,
        profitPartial: order.profitPartial,
        itemsJson: order.itemsJson,
        breakdownJson: order.breakdownJson,
        calculationVersion: order.calculationVersion,
        note: order.note ?? null,
      };
      const update = putDefined({ ...fields }, order, ["createdAt"]);
      update.updatedAt = order.updatedAt ?? stamp;
      const existingId = manualOrderIds.has(order.id)
        ? order.id
        : manualOrderIdByNumber.get(order.orderNumber);
      if (existingId) return updateById("ManualOrder", "id", existingId, update);
      manualOrderIds.add(order.id);
      manualOrderIdByNumber.set(order.orderNumber, order.id);
      return upsert(
        "ManualOrder",
        ["orderNumber"],
        {
          id: order.id,
          ...fields,
          createdAt: order.createdAt ?? stamp,
          updatedAt: order.updatedAt ?? stamp,
        },
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
      const fields: Row = { name: group.name, shareModels: group.shareModels ?? false };
      const update = putDefined({ ...fields }, group, ["createdAt"]);
      update.updatedAt = group.updatedAt ?? stamp;
      return upsert(
        "VariantGroup",
        ["id"],
        {
          id: group.id,
          ...fields,
          createdAt: group.createdAt ?? stamp,
          updatedAt: group.updatedAt ?? stamp,
        },
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

    const common: Row = {
      sku: product.sku ?? product.barcode,
      name: product.name ?? product.barcode,
      categoryName: product.categoryName ?? "Imported",
      currentSalePrice: product.currentSalePrice,
    };
    const update = putDefined({ ...common }, product, [
      "alias",
      "listPrice",
      "stock",
      "desi",
      "weight",
      "imageUrl",
      "imageManual",
      "isActive",
      "hidden",
      "madeToOrder",
      "source",
      "trendyolId",
      "productMainId",
      "variantLabel",
      "commissionRate",
      "commissionSource",
      "commissionUpdatedAt",
    ]);
    if (product.variantGroupId !== undefined) update.variantGroupId = variantGroupId;
    update.updatedAt = product.updatedAt ?? stamp;

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
          sku: product.sku ?? product.barcode,
          name: product.name ?? product.barcode,
          alias: product.alias ?? null,
          categoryName: product.categoryName ?? "Imported",
          currentSalePrice: product.currentSalePrice,
          listPrice: product.listPrice ?? null,
          stock: product.stock ?? 0,
          desi: product.desi ?? null,
          weight: product.weight ?? null,
          imageUrl: product.imageUrl ?? null,
          imageManual: product.imageManual ?? false,
          isActive: product.isActive ?? true,
          hidden: product.hidden ?? false,
          madeToOrder: product.madeToOrder ?? false,
          source: product.source ?? "imported",
          trendyolId: product.trendyolId ?? null,
          productMainId: product.productMainId ?? null,
          variantGroupId,
          variantLabel: product.variantLabel ?? null,
          commissionRate: product.commissionRate ?? null,
          commissionSource: product.commissionSource ?? null,
          commissionUpdatedAt: product.commissionUpdatedAt ?? null,
          createdAt: product.createdAt ?? stamp,
          updatedAt: product.updatedAt ?? stamp,
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

  // ── Ürüne bağlı tablolar ──────────────────────────────────────────────────
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
    const fields: Row = {
      costMode: cost.costMode ?? "manual",
      filamentTypeId: cost.filamentTypeId ?? null,
      filamentWeight: cost.filamentWeight ?? null,
      printTimeHours: cost.printTimeHours ?? null,
      wasteRate: cost.wasteRate ?? null,
      packagingPoset: cost.packagingPoset ?? null,
      packagingNaylon: cost.packagingNaylon ?? null,
      packagingBant: cost.packagingBant ?? null,
      packagingKart: cost.packagingKart ?? null,
      packagingOptionId: cost.packagingOptionId ?? null,
      nylonLevel: cost.nylonLevel ?? null,
      tapeUsed: cost.tapeUsed ?? null,
      manualCost: cost.manualCost ?? null,
      materialWeight: cost.materialWeight ?? null,
      materialCost: cost.materialCost ?? null,
      electricityCost: cost.electricityCost ?? null,
      machineWearCost: cost.machineWearCost ?? null,
      laborCost: cost.laborCost ?? null,
      packagingCost: cost.packagingCost ?? null,
      otherCost: cost.otherCost ?? null,
      totalCost: cost.totalCost ?? null,
      updatedAt: cost.updatedAt ?? stamp,
    };
    const existingId = costIdByProduct.get(productId);
    if (existingId) {
      costStmts.push(updateById("ProductCost", "id", existingId, fields));
    } else {
      costIdByProduct.set(productId, cost.id);
      costStmts.push(
        upsert("ProductCost", ["productId"], { id: cost.id, productId, ...fields }, fields)
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
    const fields: Row = {
      externalId: listing.externalId ?? null,
      externalSku: listing.externalSku ?? null,
      barcode: listing.barcode ?? null,
      salePrice: listing.salePrice,
      listPrice: listing.listPrice ?? null,
      stock: listing.stock ?? 0,
      commissionRate: listing.commissionRate ?? null,
      commissionFixed: listing.commissionFixed ?? null,
      cargoCost: listing.cargoCost ?? null,
      isActive: listing.isActive ?? true,
      lastSyncedAt: listing.lastSyncedAt ?? null,
    };
    const update = putDefined({ ...fields }, listing, ["createdAt"]);
    update.updatedAt = listing.updatedAt ?? stamp;
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
            ...fields,
            createdAt: listing.createdAt ?? stamp,
            updatedAt: listing.updatedAt ?? stamp,
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
    const fields: Row = {
      productId,
      oldPrice: history.oldPrice,
      newPrice: history.newPrice,
      changeSource: history.changeSource,
      changedAt: history.changedAt,
      note: history.note ?? null,
    };
    historyStmts.push(upsert("PriceHistory", ["id"], { id: history.id, ...fields }, fields));
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
    const fields: Row = {
      productId,
      printerConfigId: file.printerConfigId,
      label: file.label ?? null,
      originalName: file.originalName,
      storedPath: "",
      r2Key: file.r2Key ?? null,
      fileType: file.fileType,
      sizeBytes: file.sizeBytes ?? 0,
      gramaj: file.gramaj ?? null,
      estPrintMin: file.estPrintMin ?? null,
      colorsJson: file.colorsJson ?? null,
      sliced: file.sliced ?? null,
      plateJson: file.plateJson ?? null,
      thumbnail: file.thumbnail ?? null,
      contentMd5: file.contentMd5 ?? null,
      sortOrder: file.sortOrder ?? 0,
    };
    const update = putDefined({ ...fields }, file, ["createdAt"]);
    update.updatedAt = file.updatedAt ?? stamp;
    modelStmts.push(
      upsert(
        "ProductModelFile",
        ["id"],
        {
          id: file.id,
          ...fields,
          createdAt: file.createdAt ?? stamp,
          updatedAt: file.updatedAt ?? stamp,
        },
        update
      )
    );
  }
  jobs.push({ label: "Baskı dosyaları", statKey: "productModelFiles", stmts: modelStmts });
  stats.productModelFiles = modelStmts.length;

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
    const fields: Row = { productId };
    const update = putDefined({ ...fields }, mapping, ["createdAt"]);
    update.updatedAt = mapping.updatedAt ?? stamp;
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
            ...fields,
            createdAt: mapping.createdAt ?? stamp,
            updatedAt: mapping.updatedAt ?? stamp,
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
    let productId: string | null = null;
    if (usage.productId) {
      productId = resolveProduct(usage.productId);
      // Ürün silinmişse kullanım kaydı yine korunur (gram düşümü geçmişi kaybolmasın).
      if (!productId) droppedLinks++;
    }
    const fields: Row = {
      spoolId: usage.spoolId,
      productId,
      productName: usage.productName ?? null,
      grams: usage.grams,
      note: usage.note ?? null,
    };
    const update = putDefined({ ...fields }, usage, ["createdAt"]);
    usageStmts.push(
      upsert(
        "FilamentUsage",
        ["id"],
        { id: usage.id, ...fields, createdAt: usage.createdAt ?? stamp },
        update
      )
    );
  }
  jobs.push({ label: "Filament kullanımları", statKey: "filamentUsages", stmts: usageStmts });
  stats.filamentUsages = usageStmts.length;

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
 */
export async function POST(req: NextRequest) {
  let data: ImportPayload;
  try {
    await ensureRuntimeSchema();
    data = ImportSchema.parse(await req.json());
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
      return NextResponse.json(await runImport(data, () => {}));
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
        const result = await runImport(data, send);
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
