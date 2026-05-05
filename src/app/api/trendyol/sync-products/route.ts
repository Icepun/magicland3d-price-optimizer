import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { TrendyolClient, type TrendyolProduct } from "@/services/trendyol-client";
import { getTrendyolCredentials } from "@/services/trendyol-settings";
import { jsonError } from "@/lib/api-error";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

const Schema = z.object({
  approved: z.boolean().default(true),
  archived: z.boolean().default(false),
  maxPages: z.coerce.number().int().min(1).max(100).default(10),
  size: z.coerce.number().int().min(1).max(100).default(100),
});

function mapProduct(product: TrendyolProduct) {
  return {
    barcode: product.barcode,
    sku: product.stockCode || product.productMainId || product.barcode,
    name: product.title || product.barcode,
    categoryName: product.categoryName || "Trendyol",
    currentSalePrice: Number(product.salePrice ?? 0),
    listPrice: product.listPrice === undefined ? undefined : Number(product.listPrice),
    stock: Math.max(0, Math.floor(Number(product.quantity ?? 0))),
    desi:
      product.dimensionalWeight === undefined
        ? undefined
        : Number(product.dimensionalWeight),
    isActive: product.archived ? false : true,
    source: "trendyol",
    trendyolId: String(product.id ?? product.productCode ?? ""),
  };
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const input = Schema.parse(await req.json().catch(() => ({})));
    const client = new TrendyolClient(await getTrendyolCredentials());

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let totalElements = 0;
  let totalPages = 0;

  for (let page = 0; page < input.maxPages; page += 1) {
    const result = await client.listProducts({
      page,
      size: input.size,
      approved: input.approved,
      archived: input.archived,
    });

    const products = result.content ?? [];
    totalElements = result.totalElements ?? totalElements;
    totalPages = result.totalPages ?? totalPages;

    if (products.length === 0) break;

    for (const trendyolProduct of products) {
      if (!trendyolProduct.barcode) {
        skipped += 1;
        continue;
      }

      const data = mapProduct(trendyolProduct);
      const existing = await prisma.product.findUnique({
        where: { barcode: data.barcode },
        select: { id: true },
      });

      await prisma.product.upsert({
        where: { barcode: data.barcode },
        create: data,
        update: data,
      });

      if (existing) updated += 1;
      else created += 1;
    }

    if (result.totalPages !== undefined && page >= result.totalPages - 1) break;
  }

  await prisma.appSetting.upsert({
    where: { key: "trendyolLastSyncAt" },
    create: { key: "trendyolLastSyncAt", value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });

    return NextResponse.json({
      created,
      updated,
      skipped,
      totalElements,
      totalPages,
    });
  } catch (error) {
    return jsonError(error);
  }
}
