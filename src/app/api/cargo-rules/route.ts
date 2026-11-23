import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { bustProfitInputCaches } from "@/lib/cache-busting";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { yururluktekiDonemBaslangiciMs } from "@/core/tariff-period";
import { jsonError } from "@/lib/api-error";

const Schema = z.object({
  name: z.string().trim().min(1, "Kural adı gerekli"),
  platform: z.enum(["trendyol", "shopify", "hepsiburada"]).nullable().optional(),
  cargoProvider: z.string().nullable().optional(),
  categoryName: z.string().nullable().optional(),
  minPrice: z.number().min(0).default(0),
  maxPrice: z.number().min(0).default(999999),
  minDesi: z.number().min(0).default(0),
  maxDesi: z.number().min(0).default(999),
  cargoCost: z.number({ message: "Kargo bedeli gerekli" }).min(0, "Kargo bedeli eksi olamaz"),
  vatIncluded: z.boolean().default(true),
  priority: z.number().int().default(10),
  isActive: z.boolean().default(true),
})
  // Ters aralık ölü kural üretir (hiç eşleşmez → kargo 0). Telefon da aynı kuralı uyguluyor.
  .refine((d) => d.maxPrice >= d.minPrice, { message: "Max fiyat min fiyattan küçük olamaz", path: ["maxPrice"] })
  .refine((d) => d.maxDesi >= d.minDesi, { message: "Max desi min desiden küçük olamaz", path: ["maxDesi"] });

export async function GET() {
  try {
    await ensureRuntimeSchema();
    const rules = await prisma.cargoRule.findMany({
      orderBy: [{ isActive: "desc" }, { priority: "desc" }, { minPrice: "asc" }],
    });
    return NextResponse.json(rules);
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Yeni kural, platformun YÜRÜRLÜKTEKİ döneminin başlangıcını devralır.
 * Kararın kendisi çekirdekte (`core/tariff-period.ts`) — mobil de aynı tanımı kullanıyor.
 */
async function yururluktekiDonemBaslangici(platform: string | null | undefined): Promise<Date | null> {
  if (!platform) return null;
  const acikKurallar = await prisma.cargoRule.findMany({
    where: { platform, OR: [{ validTo: null }, { validTo: { gte: new Date() } }] },
    select: { validFrom: true, validTo: true },
  });
  const ms = yururluktekiDonemBaslangiciMs(acikKurallar, Date.now());
  return ms == null ? null : new Date(ms);
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const body = await req.json();
    const data = Schema.parse(body);
    const validFrom = await yururluktekiDonemBaslangici(data.platform);
    const rule = await prisma.cargoRule.create({ data: { ...data, validFrom } });
    bustProfitInputCaches(); // kargo kuralı değişti → sipariş kârı taze hesaplansın
    return NextResponse.json(rule, { status: 201 });
  } catch (error) {
    return jsonError(error, 400);
  }
}
