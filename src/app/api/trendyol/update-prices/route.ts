import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { TrendyolClient, type TrendyolPriceInventoryItem } from "@/services/trendyol-client";
import { getTrendyolCredentials } from "@/services/trendyol-settings";
import { jsonError } from "@/lib/api-error";

const Schema = z.object({
  recommendationIds: z.array(z.string()).optional(),
  onlyAccepted: z.boolean().default(true),
  dryRun: z.boolean().default(false),
});

export async function POST(req: NextRequest) {
  try {
  const input = Schema.parse(await req.json().catch(() => ({})));
  const where =
    input.recommendationIds && input.recommendationIds.length > 0
      ? { id: { in: input.recommendationIds } }
      : input.onlyAccepted
        ? { status: "accepted" }
        : { status: { in: ["accepted", "ready"] } };

  const recommendations = await prisma.recommendation.findMany({
    where,
    include: { product: { include: { cost: true } } },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });

  const skipped: Array<{ id: string; reason: string }> = [];
  const items: TrendyolPriceInventoryItem[] = [];

  for (const recommendation of recommendations) {
    const product = recommendation.product;
    const productCost = product.cost?.totalCost ?? product.cost?.manualCost ?? 0;

    if (!product.barcode) {
      skipped.push({ id: recommendation.id, reason: "Barkod eksik" });
      continue;
    }
    if (productCost <= 0) {
      skipped.push({ id: recommendation.id, reason: "Maliyet eksik" });
      continue;
    }
    if (recommendation.recommendedPrice <= 0) {
      skipped.push({ id: recommendation.id, reason: "Onerilen fiyat gecersiz" });
      continue;
    }
    if (Math.abs(recommendation.recommendedPrice - product.currentSalePrice) < 0.01) {
      skipped.push({ id: recommendation.id, reason: "Fiyat degismemis" });
      continue;
    }

    items.push({
      barcode: product.barcode,
      quantity: product.stock,
      salePrice: Number(recommendation.recommendedPrice.toFixed(2)),
      listPrice: Number(
        Math.max(product.listPrice ?? 0, recommendation.recommendedPrice).toFixed(2)
      ),
    });
  }

  if (items.length === 0) {
    return NextResponse.json({ sent: 0, skipped, dryRun: input.dryRun });
  }

  if (input.dryRun) {
    return NextResponse.json({ sent: 0, readyToSend: items, skipped, dryRun: true });
  }

  const client = new TrendyolClient(await getTrendyolCredentials());
  const batch = await client.updatePriceAndInventory(items);
  const batchRequestId = batch.batchRequestId ?? "";

  for (const item of items) {
    const recommendation = recommendations.find(
      (rec) => rec.product.barcode === item.barcode
    );
    if (!recommendation || item.salePrice === undefined) continue;

    await prisma.priceHistory.create({
      data: {
        productId: recommendation.productId,
        oldPrice: recommendation.product.currentSalePrice,
        newPrice: item.salePrice,
        changeSource: "trendyol_api",
        note: batchRequestId ? `batchRequestId=${batchRequestId}` : undefined,
      },
    });
    await prisma.product.update({
      where: { id: recommendation.productId },
      data: {
        currentSalePrice: item.salePrice,
        listPrice: item.listPrice,
        stock: item.quantity ?? recommendation.product.stock,
      },
    });
    await prisma.recommendation.update({
      where: { id: recommendation.id },
      data: { status: "sent_to_trendyol" },
    });
  }

    return NextResponse.json({
      sent: items.length,
      skipped,
      batchRequestId,
      raw: batch,
    });
  } catch (error) {
    return jsonError(error);
  }
}
