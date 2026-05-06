import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTrendyolCommissionRates } from "@/data/trendyol-commission-rates";

export async function POST() {
  const rates = getTrendyolCommissionRates();

  let created = 0;
  let updated = 0;

  for (const rate of rates) {
    const name = `Trendyol PDF - ${rate.categoryName}`;
    const data = {
      name,
      categoryName: rate.categoryName,
      minPrice: 0,
      maxPrice: 999999,
      commissionRate: rate.commissionPercent / 100,
      fixedCommission: 0,
      priority: 100 + Math.min(rate.categoryName.length, 100),
      isActive: true,
    };

    const existing = await prisma.commissionRule.findFirst({
      where: { name, categoryName: rate.categoryName },
      select: { id: true },
    });

    if (existing) {
      await prisma.commissionRule.update({
        where: { id: existing.id },
        data,
      });
      updated += 1;
    } else {
      await prisma.commissionRule.create({ data });
      created += 1;
    }
  }

  return NextResponse.json({
    created,
    updated,
    total: rates.length,
  });
}
