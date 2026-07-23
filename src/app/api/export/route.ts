import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveProductCost } from "@/core/product-cost";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

export async function GET(req: NextRequest) {
  await ensureRuntimeSchema();
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") ?? "products";

  if (type === "products") {
    const [products, settings] = await Promise.all([
      prisma.product.findMany({
        include: { cost: { include: { filamentType: true } } },
        orderBy: { name: "asc" },
      }),
      prisma.appSetting.findMany(),
    ]);
    const settingsMap = Object.fromEntries(settings.map((setting) => [setting.key, setting.value]));

    const header =
      "barcode,sku,name,category,sale_price,stock,desi,product_cost,packaging_cost";
    const rows = products.map((p) => {
      const resolved = resolveProductCost(
        p.cost,
        settingsMap,
        p.cost?.filamentType?.costPerGram ?? 0
      );
      return [
        p.barcode,
        p.sku,
        `"${p.name.replace(/"/g, '""')}"`,
        `"${p.categoryName.replace(/"/g, '""')}"`,
        p.currentSalePrice.toFixed(2),
        p.stock,
        p.desi ?? "",
        resolved?.productionCost.toFixed(2) ?? "",
        resolved?.packagingCost.toFixed(2) ?? "",
      ].join(",");
    });

    const csv = [header, ...rows].join("\n");
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="products-${Date.now()}.csv"`,
      },
    });
  }

  return NextResponse.json({ error: "Unknown export type" }, { status: 400 });
}
