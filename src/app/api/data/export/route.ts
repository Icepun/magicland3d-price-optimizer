import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

/**
 * Tüm uygulama verisini tek bir JSON dosyası olarak indirir.
 * Update sırasında veri kaybı olmasın diye bu yedek alınabilir + import edilebilir.
 */
export async function GET() {
  await ensureRuntimeSchema();

  const [
    products,
    productCosts,
    listings,
    filamentTypes,
    appSettings,
    commissionRules,
    cargoRules,
    expenseRules,
    costTemplates,
    priceHistory,
  ] = await Promise.all([
    prisma.product.findMany(),
    prisma.productCost.findMany(),
    prisma.listing.findMany(),
    prisma.filamentType.findMany(),
    prisma.appSetting.findMany(),
    prisma.commissionRule.findMany(),
    prisma.cargoRule.findMany(),
    prisma.expenseRule.findMany(),
    prisma.costTemplate.findMany().catch(() => []),
    prisma.priceHistory.findMany(),
  ]);

  const dump = {
    version: 1,
    exportedAt: new Date().toISOString(),
    appVersion: "0.5.1",
    products,
    productCosts,
    listings,
    filamentTypes,
    appSettings,
    commissionRules,
    cargoRules,
    expenseRules,
    costTemplates,
    priceHistory,
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
