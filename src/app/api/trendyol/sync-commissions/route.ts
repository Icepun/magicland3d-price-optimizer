import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { TrendyolClient, type TrendyolSettlementItem } from "@/services/trendyol-client";
import { getTrendyolCredentials } from "@/services/trendyol-settings";
import { jsonError } from "@/lib/api-error";

const Schema = z.object({
  days: z.coerce.number().int().min(15).max(365).default(180),
  size: z.coerce.number().int().min(100).max(1000).default(1000),
});

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_DAYS = 15;

function getItemTime(item: TrendyolSettlementItem) {
  return Number(item.transactionDate ?? item.orderDate ?? 0);
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const input = Schema.parse(await req.json().catch(() => ({})));
    const client = new TrendyolClient(await getTrendyolCredentials());

    const now = Date.now();
    let end = now;
    const startLimit = now - input.days * DAY_MS;
    const byBarcode = new Map<string, { rate: number; seenAt: number }>();
    let scannedRecords = 0;

    while (end > startLimit) {
      const start = Math.max(startLimit, end - RANGE_DAYS * DAY_MS + 1);

      for (let page = 0; page < 500; page += 1) {
        const result = await client.listSettlements({
          startDate: start,
          endDate: end,
          transactionType: "Sale",
          page,
          size: input.size,
        });

        const content = result.content ?? [];
        scannedRecords += content.length;

        for (const item of content) {
          const barcode = item.barcode?.trim();
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

      end = start - 1;
    }

    let updated = 0;
    let unchanged = 0;
    const nowDate = new Date();

    for (const [barcode, value] of byBarcode) {
      const product = await prisma.product.findUnique({
        where: { barcode },
        select: { id: true, commissionRate: true },
      });
      if (!product) continue;

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
      scannedRecords,
      days: input.days,
    });
  } catch (error) {
    return jsonError(error);
  }
}
