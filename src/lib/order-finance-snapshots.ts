import { prisma } from "@/lib/prisma";
import {
  FINANCE_CALCULATION_VERSION,
  tlToKurus,
} from "./monthly-finance";

export interface FinanceSnapshotOrder {
  platform: string;
  id: string;
  orderNumber: string;
  date: string | null;
  total: number;
  profit: number | null;
  profitPartial: boolean;
  statusKind: string;
  currency: string;
}

export function canonicalFinanceOrderId(platform: string, externalOrderId: string): string {
  if (platform !== "shopify") return externalOrderId;
  if (externalOrderId.startsWith("sh-")) return externalOrderId;
  const gidMatch = externalOrderId.match(/\/Order\/([^/]+)$/i);
  return `sh-${gidMatch?.[1] ?? externalOrderId.replace(/^shopify-/, "")}`;
}

export function shouldReplaceCapturedProfit(
  existing: {
    revenueKurus: number;
    profitKurus: number | null;
    profitPartial: boolean;
  } | null,
  incoming: {
    revenueKurus: number;
    profitKurus: number | null;
    profitPartial: boolean;
  }
): boolean {
  // Tam hesap ilk kez yakalandıktan sonra maliyet/rule düzenlemeleri geçmiş ayı
  // geriye dönük oynatmasın. Gelir değişirse (iade/order edit) veya eksik hesap
  // daha sonra tamamlanırsa yeni değeri kabul ederiz.
  if (!existing || existing.revenueKurus !== incoming.revenueKurus) return true;
  if (existing.profitKurus == null && incoming.profitKurus != null) return true;
  return (
    existing.profitPartial &&
    !incoming.profitPartial &&
    incoming.profitKurus != null
  );
}

function snapshotKey(platform: string, externalOrderId: string): string {
  return JSON.stringify([platform, externalOrderId]);
}

export async function persistOrderFinanceSnapshots(
  orders: FinanceSnapshotOrder[]
): Promise<void> {
  const valid = orders.flatMap((order) => {
    // Manuel siparişin captured finansı ManualOrder satırındadır. Buraya da yazılırsa
    // aylık finans aynı satışı iki kez sayar ve mobilde atomik olmayan çift yazım doğar.
    if (order.platform === "manual") return [];
    if (!order.date) return [];
    const orderedAt = new Date(order.date);
    if (!Number.isFinite(orderedAt.getTime())) return [];
    const externalOrderId = canonicalFinanceOrderId(order.platform, order.id);
    return [{ order, orderedAt, externalOrderId }];
  });

  const syncedAt = new Date();
  for (let offset = 0; offset < valid.length; offset += 50) {
    const chunk = valid.slice(offset, offset + 50);
    const existingRows = await prisma.orderFinanceSnapshot.findMany({
      where: {
        OR: chunk.map(({ order, externalOrderId }) => ({
          platform: order.platform,
          externalOrderId,
        })),
      },
      select: {
        platform: true,
        externalOrderId: true,
        revenueKurus: true,
        profitKurus: true,
        profitPartial: true,
        calculationVersion: true,
      },
    });
    const existingByKey = new Map(
      existingRows.map((row) => [
        snapshotKey(row.platform, row.externalOrderId),
        row,
      ])
    );

    await prisma.$transaction(
      chunk.map(({ order, orderedAt, externalOrderId }) => {
        const existing =
          existingByKey.get(snapshotKey(order.platform, externalOrderId)) ?? null;
        const incoming = {
          revenueKurus: tlToKurus(order.total),
          profitKurus: order.profit == null ? null : tlToKurus(order.profit),
          profitPartial: order.profitPartial,
        };
        const replaceProfit = shouldReplaceCapturedProfit(existing, incoming);
        const data = {
          orderNumber: order.orderNumber,
          orderedAt,
          revenueKurus: incoming.revenueKurus,
          profitKurus: replaceProfit
            ? incoming.profitKurus
            : existing?.profitKurus ?? null,
          profitPartial: replaceProfit
            ? incoming.profitPartial
            : existing?.profitPartial ?? incoming.profitPartial,
          statusKind: order.statusKind,
          currency: order.currency || "TRY",
          syncedAt,
          calculationVersion: replaceProfit
            ? FINANCE_CALCULATION_VERSION
            : existing?.calculationVersion ?? FINANCE_CALCULATION_VERSION,
        };
        return prisma.orderFinanceSnapshot.upsert({
          where: {
            platform_externalOrderId: {
              platform: order.platform,
              externalOrderId,
            },
          },
          create: {
            id: `finance:${order.platform}:${externalOrderId}`,
            platform: order.platform,
            externalOrderId,
            ...data,
          },
          update: data,
        });
      })
    );
  }
}
