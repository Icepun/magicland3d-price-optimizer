import { NextResponse } from "next/server";
import { prisma, remotePrisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import packageJson from "../../../../../package.json";

/**
 * Uygulamanın taşınabilir verisini tek bir JSON dosyası olarak indirir.
 * Fiziksel yerel model dosyaları JSON'a gömülmez; R2 kayıtlarında yalnız uzaktaki
 * nesne anahtarı, yerel kayıtlarda ise dosya içermeyen metadata dışa aktarılır.
 */
export async function GET() {
  await ensureRuntimeSchema();

  const [
    variantGroups,
    products,
    productCosts,
    listings,
    filamentTypes,
    filamentSpools,
    filamentUsages,
    appSettings,
    commissionRules,
    cargoRules,
    expenseRules,
    actualExpenses,
    orderFinanceSnapshots,
    platformOrderFinancials,
    platformOrderCargoItems,
    manualOrders,
    costTemplates,
    priceHistory,
    printerConfigs,
    printFileProducts,
    rawProductModelFiles,
  ] = await Promise.all([
    prisma.variantGroup.findMany(),
    prisma.product.findMany(),
    prisma.productCost.findMany(),
    prisma.listing.findMany(),
    prisma.filamentType.findMany(),
    prisma.filamentSpool.findMany(),
    prisma.filamentUsage.findMany(),
    prisma.appSetting.findMany(),
    prisma.commissionRule.findMany(),
    prisma.cargoRule.findMany(),
    prisma.expenseRule.findMany(),
    remotePrisma.actualExpense.findMany(),
    // Manual orders are their own captured finance source. Exporting a second
    // "manual" platform snapshot would make older backups easy to double-count.
    prisma.orderFinanceSnapshot.findMany({
      where: { platform: { not: "manual" } },
    }),
    prisma.platformOrderFinancial.findMany(),
    prisma.platformOrderCargoItem.findMany(),
    remotePrisma.manualOrder.findMany(),
    prisma.costTemplate.findMany(),
    prisma.priceHistory.findMany(),
    prisma.printerConfig.findMany(),
    prisma.printFileProduct.findMany(),
    prisma.productModelFile.findMany(),
  ]);

  const localModelFileCount = rawProductModelFiles.filter((file) => !file.r2Key).length;
  const productModelFiles = rawProductModelFiles.map((file) => ({
    ...file,
    // Mutlak yerel yollar başka cihaza taşınabilir değildir ve kullanıcı dizinini ifşa eder.
    storedPath: "",
    storageKind: file.r2Key ? "r2-reference" : "local-metadata-only",
    fileBytesIncluded: false,
  }));
  const warnings =
    localModelFileCount > 0
      ? [
          `${localModelFileCount} yerel model kaydı yalnız metadata içerir; dosya baytları olmadan başka cihazda geri yüklenemez.`,
        ]
      : [];

  const dump = {
    version: 4,
    exportedAt: new Date().toISOString(),
    appVersion: packageJson.version,
    metadata: {
      format: "magicland-portable-backup",
      localModelFileBytesIncluded: false,
      localModelFilePathsIncluded: false,
      localModelFileMetadataCount: localModelFileCount,
      r2ModelReferenceCount: rawProductModelFiles.length - localModelFileCount,
      notes: ["Model dosyalarının fiziksel baytları taşınabilir JSON yedeğine dahil değildir."],
      warnings,
    },
    variantGroups,
    products,
    productCosts,
    listings,
    filamentTypes,
    filamentSpools,
    filamentUsages,
    appSettings,
    commissionRules,
    cargoRules,
    expenseRules,
    actualExpenses,
    orderFinanceSnapshots,
    platformOrderFinancials,
    platformOrderCargoItems,
    manualOrders,
    costTemplates,
    priceHistory,
    printerConfigs,
    printFileProducts,
    productModelFiles,
  };

  return new NextResponse(JSON.stringify(dump, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="magicland-backup-${new Date()
        .toISOString()
        .slice(0, 10)}.json"`,
    },
  });
}
