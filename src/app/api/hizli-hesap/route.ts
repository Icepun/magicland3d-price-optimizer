import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { sikKomisyonlar } from "@/core/hizli-hesap";

export const dynamic = "force-dynamic";

/** Hızlı hesap formunun kısayolları: ilanlarda en sık kullanılan komisyon oranları. */
export async function GET() {
  try {
    await ensureRuntimeSchema();
    const satirlar = await prisma.listing.findMany({
      where: { isActive: true, commissionRate: { not: null }, platform: { in: ["trendyol", "hepsiburada"] } },
      select: { platform: true, commissionRate: true },
    });
    return NextResponse.json({ komisyonlar: sikKomisyonlar(satirlar) });
  } catch (error) {
    return jsonError(error);
  }
}
