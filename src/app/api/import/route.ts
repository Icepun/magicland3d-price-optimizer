import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { invalidateOrdersCache } from "@/lib/orders-cache";

interface ProductRow extends Record<string, string | undefined> {
  barcode?: string;
  sku?: string;
  name?: string;
  category?: string;
  sale_price?: string;
  list_price?: string;
  stock?: string;
  desi?: string;
  weight?: string;
  product_cost?: string;
  packaging_cost?: string;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { type: string; rows: ProductRow[] };
  const { type, rows } = body;

  if (type === "products") {
    const created: string[] = [];
    const updated: string[] = [];
    const errors: string[] = [];

    for (const row of rows) {
      const barcode = row.barcode?.trim();
      const name = row.name?.trim();

      if (!barcode || !name) {
        errors.push("Satir atlandi: barcode veya name eksik");
        continue;
      }

      const salePriceText = row.sale_price?.trim() ?? "";
      const salePrice = Number(salePriceText);
      if (!salePriceText || !Number.isFinite(salePrice) || salePrice <= 0) {
        errors.push(`${barcode}: sale_price sonlu ve 0'dan büyük bir sayı olmalı`);
        continue;
      }

      const productData = {
        sku: row.sku || barcode,
        name,
        categoryName: row.category || "Genel",
        currentSalePrice: salePrice,
        listPrice: row.list_price ? parseFloat(row.list_price) : undefined,
        stock: row.stock ? parseInt(row.stock) : 0,
        desi: row.desi ? parseFloat(row.desi) : undefined,
        weight: row.weight ? parseFloat(row.weight) : undefined,
      };

      const costData = row.product_cost
        ? {
            costMode: "manual" as const,
            manualCost: parseFloat(row.product_cost) || 0,
            packagingCost: row.packaging_cost ? parseFloat(row.packaging_cost) : 0,
            totalCost:
              (parseFloat(row.product_cost) || 0) +
              (row.packaging_cost ? parseFloat(row.packaging_cost) : 0),
          }
        : null;

      try {
        const existing = await prisma.product.findUnique({
          where: { barcode },
        });

        if (existing) {
          await prisma.product.update({
            where: { barcode },
            data: productData,
          });
          if (costData) {
            await prisma.productCost.upsert({
              where: { productId: existing.id },
              create: { productId: existing.id, ...costData },
              update: costData,
            });
          }
          updated.push(barcode);
        } else {
          const product = await prisma.product.create({
            data: { barcode, ...productData },
          });
          if (costData) {
            await prisma.productCost.create({
              data: { productId: product.id, ...costData },
            });
          }
          created.push(barcode);
        }
      } catch (e) {
        errors.push(`${barcode}: ${e instanceof Error ? e.message : "Bilinmeyen hata"}`);
      }
    }

    if (created.length > 0 || updated.length > 0) invalidateOrdersCache();
    return NextResponse.json({ created: created.length, updated: updated.length, errors });
  }

  return NextResponse.json({ error: "Unknown import type" }, { status: 400 });
}
