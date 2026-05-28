import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

/**
 * Son N günde fiyat değişimi olan ürünlerin özeti.
 * Default: son 30 gün, en çok değişen top 10.
 */
export async function GET(req: NextRequest) {
  await ensureRuntimeSchema();

  const url = new URL(req.url);
  const days = Number(url.searchParams.get("days") ?? 30);
  const limit = Number(url.searchParams.get("limit") ?? 10);

  const since = new Date();
  since.setDate(since.getDate() - days);

  const history = await prisma.priceHistory.findMany({
    where: { changedAt: { gte: since } },
    include: {
      product: {
        select: { id: true, name: true, currentSalePrice: true },
      },
    },
    orderBy: { changedAt: "desc" },
  });

  type ProductChange = {
    productId: string;
    productName: string;
    currentPrice: number;
    firstPrice: number;
    lastPrice: number;
    changePercent: number;
    changeCount: number;
    lastChangedAt: Date;
  };

  // Aynı ürün için birden fazla değişim varsa, ilkini ve sonunu al, % hesapla
  const byProduct = new Map<string, ProductChange>();

  for (const entry of history) {
    if (!entry.product) continue;
    const prev = byProduct.get(entry.productId);
    if (!prev) {
      byProduct.set(entry.productId, {
        productId: entry.productId,
        productName: entry.product.name,
        currentPrice: entry.product.currentSalePrice,
        firstPrice: entry.oldPrice,
        lastPrice: entry.newPrice,
        changePercent:
          entry.oldPrice > 0
            ? ((entry.newPrice - entry.oldPrice) / entry.oldPrice) * 100
            : 0,
        changeCount: 1,
        lastChangedAt: entry.changedAt,
      });
    } else {
      // Bu ürün için kaydedilen daha eski entry — firstPrice güncellenebilir
      if (entry.changedAt < prev.lastChangedAt) {
        prev.firstPrice = entry.oldPrice;
        prev.changePercent =
          prev.firstPrice > 0
            ? ((prev.lastPrice - prev.firstPrice) / prev.firstPrice) * 100
            : 0;
      }
      prev.changeCount += 1;
    }
  }

  const items = Array.from(byProduct.values());
  const totalChanges = history.length;
  const productsAffected = items.length;

  const topIncreases = [...items]
    .filter((i) => i.changePercent > 0)
    .sort((a, b) => b.changePercent - a.changePercent)
    .slice(0, limit);

  const topDecreases = [...items]
    .filter((i) => i.changePercent < 0)
    .sort((a, b) => a.changePercent - b.changePercent)
    .slice(0, limit);

  const recent = [...items]
    .sort((a, b) => b.lastChangedAt.getTime() - a.lastChangedAt.getTime())
    .slice(0, limit);

  return NextResponse.json({
    days,
    totalChanges,
    productsAffected,
    topIncreases,
    topDecreases,
    recent,
  });
}
