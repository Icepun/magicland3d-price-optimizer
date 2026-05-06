import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { TrendyolClient, type TrendyolSettlementItem } from "@/services/trendyol-client";
import { getTrendyolCredentials } from "@/services/trendyol-settings";
import { jsonError } from "@/lib/api-error";

const Schema = z.object({
  days: z.coerce.number().int().min(15).max(365).default(180),
  startDate: z.coerce.number().int().positive().optional(),
  endDate: z.coerce.number().int().positive().optional(),
  size: z.coerce.number().int().min(100).max(1000).default(1000),
});

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_DAYS = 15;

function getItemTime(item: TrendyolSettlementItem) {
  return Number(item.transactionDate ?? item.orderDate ?? 0);
}

function normalizeBarcode(barcode: string) {
  return barcode.trim();
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const input = Schema.parse(await req.json().catch(() => ({})));
    const client = new TrendyolClient(await getTrendyolCredentials());

    const now = Date.now();
    const startLimit = now - input.days * DAY_MS;
    const byBarcode = new Map<string, { rate: number; seenAt: number }>();
    let scannedRecords = 0;
    let processedRanges = 0;
    let processedPages = 0;

    const ranges =
      input.startDate && input.endDate
        ? [{ start: input.startDate, end: input.endDate }]
        : (() => {
            const builtRanges: Array<{ start: number; end: number }> = [];
            let end = now;
            while (end > startLimit) {
              const start = Math.max(startLimit, end - RANGE_DAYS * DAY_MS + 1);
              builtRanges.push({ start, end });
              end = start - 1;
            }
            return builtRanges.reverse();
          })();

    for (const range of ranges) {
      for (let page = 0; page < 500; page += 1) {
        const result = await client.listSettlements({
          startDate: range.start,
          endDate: range.end,
          transactionType: "Sale",
          page,
          size: input.size,
        });

        const content = result.content ?? [];
        scannedRecords += content.length;
        processedPages += 1;

        for (const item of content) {
          const barcode = item.barcode ? normalizeBarcode(item.barcode) : "";
          const rate = Number(item.commissionRate);
          if (!barcode || !Number.isFinite(rate) || rate <= 0) continue;

          const seenAt = getItemTime(item);
          const current = byBarcode.get(barcode);
          if (!current || seenAt >= current.seenAt) {
            byBarcode.set(barcode, { rate: rate / 100, seenAt });
          }
        }

        if (content.length === 0) break;
        if (result.totalPages !== undefined && page >= result.totalPages - 1) break;
      }

      processedRanges += 1;
    }

    let updated = 0;
    let unchanged = 0;
    let matchedProducts = 0;
    const nowDate = new Date();
    const products = await prisma.product.findMany({
      select: { id: true, barcode: true, commissionRate: true },
    });
    const productByBarcode = new Map(
      products.map((product) => [normalizeBarcode(product.barcode), product])
    );

    for (const [barcode, value] of byBarcode) {
      const product = productByBarcode.get(barcode);
      if (!product) continue;

      matchedProducts += 1;
      if (
        product.commissionRate !== null &&
        product.commissionRate !== undefined &&
        Math.abs(product.commissionRate - value.rate) < 0.00001
      ) {
        unchanged += 1;
        continue;
      }

      await prisma.product.update({
        where: { id: product.id },
        data: {
          commissionRate: value.rate,
          commissionSource: "trendyol_finance",
          commissionUpdatedAt: nowDate,
        },
      });
      updated += 1;
    }

    await prisma.appSetting.upsert({
      where: { key: "trendyolLastCommissionSyncAt" },
      create: { key: "trendyolLastCommissionSyncAt", value: nowDate.toISOString() },
      update: { value: nowDate.toISOString() },
    });

    return NextResponse.json({
      updated,
      unchanged,
      foundBarcodes: byBarcode.size,
      matchedProducts,
      unmatchedBarcodes: byBarcode.size - matchedProducts,
      scannedRecords,
      days: input.days,
      processedRanges,
      totalRanges: ranges.length,
      processedPages,
    });
  } catch (error) {
    return jsonError(error);
  }
}
