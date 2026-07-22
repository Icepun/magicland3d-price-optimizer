import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

const id = z.string().trim().min(1);
const finite = z.number().finite();
const integer = finite.int();
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
  costTemplates: z.array(CostTemplateSchema).optional(),
  priceHistory: z.array(PriceHistorySchema).optional(),
  printerConfigs: z.array(PrinterConfigSchema).optional(),
  printFileProducts: z.array(PrintFileProductSchema).optional(),
  productModelFiles: z.array(ProductModelFileSchema).optional(),
});

class BackupReferenceError extends Error {}
const CUSTOM_PRINT_PRODUCT_ID = "__custom__";

/**
 * Daha önce export edilmiş JSON'u tek transaction içinde geri yükler.
 * Mevcut veri silinmez; doğal benzersiz anahtarlarla birleştirilir. Bir satır
 * doğrulanamaz veya yazılamazsa transaction tamamen geri alınır.
 */
export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const data = ImportSchema.parse(await req.json());
    const localModelFiles = (data.productModelFiles ?? []).filter((file) => !file.r2Key);
    const warnings = [...new Set(data.metadata?.warnings ?? [])];
    if (localModelFiles.length > 0) {
      warnings.push(
        `${localModelFiles.length} yerel model kaydı geri yüklenmedi: JSON yedeği fiziksel dosya baytlarını içermez.`
      );
    }

    const stats = await prisma.$transaction(
      async (tx) => {
        const result = {
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
          costTemplates: 0,
          priceHistory: 0,
          printerConfigs: 0,
          printFileProducts: 0,
          productModelFiles: 0,
          productModelFilesSkipped: localModelFiles.length,
        };
        const productIdMap = new Map<string, string>();

        for (const f of data.filamentTypes ?? []) {
          const fields = { name: f.name, costPerGram: f.costPerGram, isActive: f.isActive ?? true };
          await tx.filamentType.upsert({
            where: { id: f.id },
            create: { id: f.id, ...fields },
            update: fields,
          });
          result.filamentTypes++;
        }

        for (const template of data.costTemplates ?? []) {
          const fields = {
            name: template.name,
            materialCostPerGram: template.materialCostPerGram ?? 0,
            electricityCostPerHour: template.electricityCostPerHour ?? 0,
            machineWearCostPerHour: template.machineWearCostPerHour ?? 0,
            defaultPackagingCost: template.defaultPackagingCost ?? 0,
            defaultLaborCost: template.defaultLaborCost ?? 0,
            defaultOtherCost: template.defaultOtherCost ?? 0,
            defaultWasteRate: template.defaultWasteRate ?? 0,
            isActive: template.isActive ?? true,
          };
          await tx.costTemplate.upsert({
            where: { id: template.id },
            create: { id: template.id, ...fields },
            update: fields,
          });
          result.costTemplates++;
        }

        for (const rule of data.commissionRules ?? []) {
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
          await tx.commissionRule.upsert({
            where: { id: rule.id },
            create: { id: rule.id, ...fields },
            update: fields,
          });
          result.commissionRules++;
        }

        for (const rule of data.cargoRules ?? []) {
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
            validFrom: rule.validFrom ?? null,
            validTo: rule.validTo ?? null,
            priority: rule.priority ?? 10,
            isActive: rule.isActive ?? true,
          };
          await tx.cargoRule.upsert({
            where: { id: rule.id },
            create: { id: rule.id, ...fields },
            update: fields,
          });
          result.cargoRules++;
        }

        for (const rule of data.expenseRules ?? []) {
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
          await tx.expenseRule.upsert({
            where: { id: rule.id },
            create: { id: rule.id, ...fields },
            update: fields,
          });
          result.expenseRules++;
        }

        for (const group of data.variantGroups ?? []) {
          const fields = {
            name: group.name,
            shareModels: group.shareModels ?? false,
            ...(group.createdAt ? { createdAt: group.createdAt } : {}),
            ...(group.updatedAt ? { updatedAt: group.updatedAt } : {}),
          };
          await tx.variantGroup.upsert({
            where: { id: group.id },
            create: { id: group.id, ...fields },
            update: fields,
          });
          result.variantGroups++;
        }

        for (const printer of data.printerConfigs ?? []) {
          const fields = {
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
            ...(printer.createdAt ? { createdAt: printer.createdAt } : {}),
            ...(printer.updatedAt ? { updatedAt: printer.updatedAt } : {}),
          };
          await tx.printerConfig.upsert({
            where: { id: printer.id },
            create: { id: printer.id, ...fields },
            update: fields,
          });
          result.printerConfigs++;
        }

        for (const spool of data.filamentSpools ?? []) {
          const fields = {
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
            isActive: spool.isActive ?? true,
            ...(spool.createdAt ? { createdAt: spool.createdAt } : {}),
            ...(spool.updatedAt ? { updatedAt: spool.updatedAt } : {}),
          };
          await tx.filamentSpool.upsert({
            where: { id: spool.id },
            create: { id: spool.id, ...fields },
            update: fields,
          });
          result.filamentSpools++;
        }

        for (const product of data.products ?? []) {
          if (product.variantGroupId) {
            const group = await tx.variantGroup.findUnique({
              where: { id: product.variantGroupId },
              select: { id: true },
            });
            if (!group) {
              throw new BackupReferenceError(
                `Ürün ${product.barcode}: varyant grubu ${product.variantGroupId} yedekte veya hedef veritabanında yok.`
              );
            }
          }

          const createFields = {
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
            variantGroupId: product.variantGroupId ?? null,
            variantLabel: product.variantLabel ?? null,
            commissionRate: product.commissionRate ?? null,
            commissionSource: product.commissionSource ?? null,
            commissionUpdatedAt: product.commissionUpdatedAt ?? null,
            ...(product.createdAt ? { createdAt: product.createdAt } : {}),
            ...(product.updatedAt ? { updatedAt: product.updatedAt } : {}),
          };
          const updateFields = {
            sku: product.sku ?? product.barcode,
            name: product.name ?? product.barcode,
            categoryName: product.categoryName ?? "Imported",
            currentSalePrice: product.currentSalePrice,
            ...(product.alias !== undefined ? { alias: product.alias } : {}),
            ...(product.listPrice !== undefined ? { listPrice: product.listPrice } : {}),
            ...(product.stock !== undefined ? { stock: product.stock } : {}),
            ...(product.desi !== undefined ? { desi: product.desi } : {}),
            ...(product.weight !== undefined ? { weight: product.weight } : {}),
            ...(product.imageUrl !== undefined ? { imageUrl: product.imageUrl } : {}),
            ...(product.imageManual !== undefined ? { imageManual: product.imageManual } : {}),
            ...(product.isActive !== undefined ? { isActive: product.isActive } : {}),
            ...(product.hidden !== undefined ? { hidden: product.hidden } : {}),
            ...(product.madeToOrder !== undefined ? { madeToOrder: product.madeToOrder } : {}),
            ...(product.source !== undefined ? { source: product.source } : {}),
            ...(product.trendyolId !== undefined ? { trendyolId: product.trendyolId } : {}),
            ...(product.productMainId !== undefined
              ? { productMainId: product.productMainId }
              : {}),
            ...(product.variantGroupId !== undefined
              ? { variantGroupId: product.variantGroupId }
              : {}),
            ...(product.variantLabel !== undefined ? { variantLabel: product.variantLabel } : {}),
            ...(product.commissionRate !== undefined
              ? { commissionRate: product.commissionRate }
              : {}),
            ...(product.commissionSource !== undefined
              ? { commissionSource: product.commissionSource }
              : {}),
            ...(product.commissionUpdatedAt !== undefined
              ? { commissionUpdatedAt: product.commissionUpdatedAt }
              : {}),
            ...(product.updatedAt ? { updatedAt: product.updatedAt } : {}),
          };

          const existingByBarcode = await tx.product.findUnique({
            where: { barcode: product.barcode },
            select: { id: true },
          });
          let restored;
          if (existingByBarcode) {
            restored = await tx.product.update({
              where: { id: existingByBarcode.id },
              data: updateFields,
              select: { id: true },
            });
          } else {
            const idCollision = await tx.product.findUnique({
              where: { id: product.id },
              select: { id: true },
            });
            restored = await tx.product.create({
              data: idCollision ? createFields : { id: product.id, ...createFields },
              select: { id: true },
            });
          }
          productIdMap.set(product.id, restored.id);
          result.products++;
        }

        const resolveProductId = async (sourceId: string, context: string): Promise<string> => {
          const mapped = productIdMap.get(sourceId);
          if (mapped) return mapped;
          const existing = await tx.product.findUnique({
            where: { id: sourceId },
            select: { id: true },
          });
          if (existing) return existing.id;
          throw new BackupReferenceError(`${context}: ürün ${sourceId} bulunamadı.`);
        };
        const requirePrinter = async (printerId: string, context: string) => {
          const existing = await tx.printerConfig.findUnique({
            where: { id: printerId },
            select: { id: true },
          });
          if (!existing) {
            throw new BackupReferenceError(`${context}: yazıcı ${printerId} bulunamadı.`);
          }
        };

        for (const cost of data.productCosts ?? []) {
          const productId = await resolveProductId(cost.productId, `Maliyet ${cost.id}`);
          const fields = {
            costMode: cost.costMode ?? "manual",
            templateId: cost.templateId ?? null,
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
            ...(cost.updatedAt ? { updatedAt: cost.updatedAt } : {}),
          };
          await tx.productCost.upsert({
            where: { productId },
            create: { id: cost.id, productId, ...fields },
            update: fields,
          });
          result.productCosts++;
        }

        for (const listing of data.listings ?? []) {
          const productId = await resolveProductId(listing.productId, `Listing ${listing.id}`);
          const fields = {
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
            ...(listing.createdAt ? { createdAt: listing.createdAt } : {}),
            ...(listing.updatedAt ? { updatedAt: listing.updatedAt } : {}),
          };
          await tx.listing.upsert({
            where: { productId_platform: { productId, platform: listing.platform } },
            create: { id: listing.id, productId, platform: listing.platform, ...fields },
            update: fields,
          });
          result.listings++;
        }

        for (const history of data.priceHistory ?? []) {
          const productId = await resolveProductId(history.productId, `Fiyat geçmişi ${history.id}`);
          const fields = {
            productId,
            oldPrice: history.oldPrice,
            newPrice: history.newPrice,
            changeSource: history.changeSource,
            changedAt: history.changedAt,
            note: history.note ?? null,
          };
          await tx.priceHistory.upsert({
            where: { id: history.id },
            create: { id: history.id, ...fields },
            update: fields,
          });
          result.priceHistory++;
        }

        for (const usage of data.filamentUsages ?? []) {
          const spool = await tx.filamentSpool.findUnique({
            where: { id: usage.spoolId },
            select: { id: true },
          });
          if (!spool) {
            throw new BackupReferenceError(
              `Filament kullanımı ${usage.id}: makara ${usage.spoolId} bulunamadı.`
            );
          }
          const productId = usage.productId
            ? await resolveProductId(usage.productId, `Filament kullanımı ${usage.id}`)
            : null;
          const fields = {
            spoolId: spool.id,
            productId,
            productName: usage.productName ?? null,
            grams: usage.grams,
            note: usage.note ?? null,
            ...(usage.createdAt ? { createdAt: usage.createdAt } : {}),
          };
          await tx.filamentUsage.upsert({
            where: { id: usage.id },
            create: { id: usage.id, ...fields },
            update: fields,
          });
          result.filamentUsages++;
        }

        for (const mapping of data.printFileProducts ?? []) {
          await requirePrinter(mapping.printerConfigId, `Dosya eşlemesi ${mapping.id}`);
          const productId = await resolveProductId(mapping.productId, `Dosya eşlemesi ${mapping.id}`);
          const fields = {
            productId,
            ...(mapping.createdAt ? { createdAt: mapping.createdAt } : {}),
            ...(mapping.updatedAt ? { updatedAt: mapping.updatedAt } : {}),
          };
          await tx.printFileProduct.upsert({
            where: {
              printerConfigId_filename: {
                printerConfigId: mapping.printerConfigId,
                filename: mapping.filename,
              },
            },
            create: {
              id: mapping.id,
              printerConfigId: mapping.printerConfigId,
              filename: mapping.filename,
              ...fields,
            },
            update: fields,
          });
          result.printFileProducts++;
        }

        for (const file of (data.productModelFiles ?? []).filter((item) => item.r2Key)) {
          await requirePrinter(file.printerConfigId, `Model dosyası ${file.id}`);
          // Özel baskılar gerçek bir Product satırına bağlı değildir; uygulama genelinde bu
          // sentinel ile saklanır. Normal model dosyalarında barkod birleşiminden doğan ID map'i sürer.
          const productId =
            file.productId === CUSTOM_PRINT_PRODUCT_ID
              ? CUSTOM_PRINT_PRODUCT_ID
              : await resolveProductId(file.productId, `Model dosyası ${file.id}`);
          const fields = {
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
            ...(file.createdAt ? { createdAt: file.createdAt } : {}),
            ...(file.updatedAt ? { updatedAt: file.updatedAt } : {}),
          };
          await tx.productModelFile.upsert({
            where: { id: file.id },
            create: { id: file.id, ...fields },
            update: fields,
          });
          result.productModelFiles++;
        }

        for (const setting of data.appSettings ?? []) {
          await tx.appSetting.upsert({
            where: { key: setting.key },
            create: setting,
            update: { value: setting.value },
          });
          result.appSettings++;
        }

        return result;
      },
      { timeout: 120_000 }
    );

    return NextResponse.json({
      ok: warnings.length === 0,
      complete: warnings.length === 0,
      stats,
      warnings,
    });
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? `Yedek biçimi geçersiz: ${error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`
        : error instanceof Error
          ? error.message
          : "Import başarısız";
    return NextResponse.json({ ok: false, complete: false, error: message }, { status: 400 });
  }
}
