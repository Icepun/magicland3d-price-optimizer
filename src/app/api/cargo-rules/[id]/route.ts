import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { bustProfitInputCaches } from "@/lib/cache-busting";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";

const Schema = z.object({
  name: z.string().trim().min(1, "Kural adı gerekli").optional(),
  platform: z.enum(["trendyol", "shopify", "hepsiburada"]).nullable().optional(),
  cargoProvider: z.string().nullable().optional(),
  categoryName: z.string().nullable().optional(),
  minPrice: z.number().min(0).optional(),
  maxPrice: z.number().min(0).optional(),
  minDesi: z.number().min(0).optional(),
  maxDesi: z.number().min(0).optional(),
  cargoCost: z.number().min(0).optional(),
  vatIncluded: z.boolean().optional(),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

const bulunamadi = () => NextResponse.json({ error: "Kural bulunamadı — silinmiş olabilir" }, { status: 404 });
/**
 * Dönemi BİTMİŞ kural kilitli: değiştirmek ya da silmek o dönemin siparişlerinin kargosunu sessizce
 * değiştirir, Raporlar ile Siparişler ayrışırdı (denetim, 23 Kas 2026).
 */
const kilitli = () =>
  NextResponse.json({ error: "Geçmiş dönemin kuralı değiştirilemez — yeni tarife başlatabilirsin." }, { status: 400 });
const suresiDoldu = (validTo: Date | null) => validTo != null && validTo.getTime() < Date.now();

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const data = Schema.parse(await req.json());
    const onceki = await prisma.cargoRule.findUnique({
      where: { id },
      select: { validTo: true, minPrice: true, maxPrice: true, minDesi: true, maxDesi: true },
    });
    if (!onceki) return bulunamadi();
    if (suresiDoldu(onceki.validTo)) return kilitli();
    if ((data.maxPrice ?? onceki.maxPrice) < (data.minPrice ?? onceki.minPrice)) {
      return NextResponse.json({ error: "Max fiyat min fiyattan küçük olamaz" }, { status: 400 });
    }
    if ((data.maxDesi ?? onceki.maxDesi) < (data.minDesi ?? onceki.minDesi)) {
      return NextResponse.json({ error: "Max desi min desiden küçük olamaz" }, { status: 400 });
    }
    const rule = await prisma.cargoRule.update({ where: { id }, data });
    bustProfitInputCaches();
    return NextResponse.json(rule);
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const onceki = await prisma.cargoRule.findUnique({ where: { id }, select: { validTo: true } });
    if (!onceki) return bulunamadi();
    if (suresiDoldu(onceki.validTo)) return kilitli();
    await prisma.cargoRule.delete({ where: { id } });
    bustProfitInputCaches();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
