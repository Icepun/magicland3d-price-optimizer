import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") ?? "products";

  if (type === "products") {
    const products = await prisma.product.findMany({
      include: { cost: true },
      orderBy: { name: "asc" },
    });

    const header =
      "barcode,sku,name,category,sale_price,stock,desi,product_cost,packaging_cost";
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
