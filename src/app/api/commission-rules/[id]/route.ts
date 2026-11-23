import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { bustProfitInputCaches } from "@/lib/cache-busting";
import { jsonError } from "@/lib/api-error";

const Schema = z.object({
  name: z.string().trim().min(1, "Kural adı gerekli").optional(),
  categoryName: z.string().trim().nullable().optional(),
  minPrice: z.number().min(0, "Min fiyat eksi olamaz").optional(),
  maxPrice: z.number().min(0, "Max fiyat eksi olamaz").optional(),
  commissionRate: z.number().min(0, "Oran eksi olamaz").max(1, "Oran %100'den büyük olamaz").optional(),
  fixedCommission: z.number().min(0, "Sabit komisyon eksi olamaz").optional(),
  priority: z.number().int("Öncelik tam sayı olmalı").optional(),
  isActive: z.boolean().optional(),
});

const bulunamadi = () => NextResponse.json({ error: "Kural bulunamadı — silinmiş olabilir" }, { status: 404 });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const data = Schema.parse(await req.json());
    const onceki = await prisma.commissionRule.findUnique({ where: { id }, select: { minPrice: true, maxPrice: true } });
    if (!onceki) return bulunamadi();
    // Yalnız biri değişse de aralık geçerli kalmalı (yalnız değişen alanlar gönderiliyor).
    if ((data.maxPrice ?? onceki.maxPrice) < (data.minPrice ?? onceki.minPrice)) {
      return NextResponse.json({ error: "Max fiyat min fiyattan küçük olamaz" }, { status: 400 });
    }
    const rule = await prisma.commissionRule.update({
      where: { id },
      data: data.categoryName !== undefined ? { ...data, categoryName: data.categoryName || null } : data,
    });
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
    const { id } = await params;
    const varMi = await prisma.commissionRule.findUnique({ where: { id }, select: { id: true } });
    if (!varMi) return bulunamadi();
    await prisma.commissionRule.delete({ where: { id } });
    bustProfitInputCaches();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
