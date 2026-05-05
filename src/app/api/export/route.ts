import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") ?? "recommendations";

  if (type === "recommendations") {
    const recs = await prisma.recommendation.findMany({
      where: { status: { not: "ignored" } },
      include: { product: true },
      orderBy: { createdAt: "desc" },
    });

    const header = "barcode,sku,product_name,current_sale_price,recommended_sale_price,current_profit,recommended_profit,profit_difference,reason";
    const rows = recs.map((r) =>
      [
        r.product.barcode,
        r.product.sku,
        `"${r.product.name.replace(/"/g, '""')}"`,
        r.currentPrice.toFixed(2),
        r.recommendedPrice.toFixed(2),
        r.currentProfit.toFixed(2),
        r.recommendedProfit.toFixed(2),
        r.profitDifference.toFixed(2),
        `"${r.reason.replace(/"/g, '""')}"`,
      ].join(",")
    );

    const csv = [header, ...rows].join("\n");
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="recommendations-${Date.now()}.csv"`,
      },
    });
  }

  if (type === "products") {
    const products = await prisma.product.findMany({
      include: { cost: true },
      orderBy: { name: "asc" },
    });

    const header = "barcode,sku,name,category,sale_price,stock,desi,product_cost,packaging_cost";
    const rows = products.map((p) =>
      [
        p.barcode,
        p.sku,
        `"${p.name.replace(/"/g, '""')}"`,
        `"${p.categoryName.replace(/"/g, '""')}"`,
        p.currentSalePrice.toFixed(2),
        p.stock,
        p.desi ?? "",
        p.cost?.totalCost?.toFixed(2) ?? p.cost?.manualCost?.toFixed(2) ?? "",
        p.cost?.packagingCost?.toFixed(2) ?? "",
      ].join(",")
    );

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
