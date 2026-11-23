import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { bustProfitInputCaches } from "@/lib/cache-busting";
import { jsonError } from "@/lib/api-error";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { kuralSonrasiSiparisleriTazele } from "@/lib/kural-sonrasi-tazele";
import { komisyonKuraliPlatformu } from "@/core/commission-calculator";
import {
  komisyonKesimi,
  komisyonKuraliGuncellemePlani,
  komisyonKuraliSilmePlani,
  komisyonKuraliYenidenAcmaPlani,
  kuralYururlukte,
} from "@/core/komisyon-kurali-donem";

const Schema = z.object({
  name: z.string().trim().min(1, "Kural adı gerekli").optional(),
  categoryName: z.string().trim().nullable().optional(),
  minPrice: z.number().min(0, "Min fiyat eksi olamaz").optional(),
  maxPrice: z.number().min(0, "Max fiyat eksi olamaz").optional(),
  commissionRate: z.number().min(0, "Oran eksi olamaz").max(1, "Oran %100'den büyük olamaz").optional(),
  fixedCommission: z.number().min(0, "Sabit komisyon eksi olamaz").optional(),
  priority: z.number().int("Öncelik tam sayı olmalı").optional(),
  platform: z.enum(["trendyol", "hepsiburada"], { message: "Pazaryeri seç" }).optional(),
  /** false = bu ayın 1'inden kapat (geçmiş aylar korunur); true = kapanmış kuralı yeniden aç. */
  isActive: z.boolean().optional(),
});

const bulunamadi = () => NextResponse.json({ error: "Kural bulunamadı — silinmiş olabilir" }, { status: 404 });

/** Bu ayın kayıtlı kârları da değişikliği görsün (Panel/Raporlar ↔ Siparişler aynı rakam). */
function buAyiTazele(platformlar: Iterable<string>, an: Date) {
  bustProfitInputCaches();
  for (const platform of new Set(platformlar)) {
    void kuralSonrasiSiparisleriTazele(platform, komisyonKesimi(an)).catch((err) =>
      console.warn("[komisyon-kuralı] yeniden hesap düştü:", err instanceof Error ? err.message : err)
    );
  }
}

/**
 * DÖNEMLİ düzenleme (`core/komisyon-kurali-donem.ts`, telefonla aynı plan): değişiklik BU AYIN
 * 1'inden geçerli olur — önceki aylar eski kuralla kalır (Berke: "tüm kasıma etki etsin, öncesine değil").
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const { isActive, ...data } = Schema.parse(await req.json());
    const eski = await prisma.commissionRule.findUnique({ where: { id } });
    if (!eski) return bulunamadi();
    // Yalnız biri değişse de aralık geçerli kalmalı (yalnız değişen alanlar gönderiliyor).
    if ((data.maxPrice ?? eski.maxPrice) < (data.minPrice ?? eski.minPrice)) {
      return NextResponse.json({ error: "Max fiyat min fiyattan küçük olamaz" }, { status: 400 });
    }
    const an = new Date();
    const eskiPlatform = komisyonKuraliPlatformu(eski);
    const degisiklik = data.categoryName !== undefined ? { ...data, categoryName: data.categoryName || null } : data;

    // Aç/kapa.
    if (isActive === false && Object.keys(data).length === 0) {
      const plan = komisyonKuraliSilmePlani(eski, an);
      if (plan.tur === "sil") await prisma.commissionRule.delete({ where: { id } });
      else await prisma.commissionRule.update({ where: { id }, data: { validTo: plan.validTo } });
      buAyiTazele([eskiPlatform], an);
      return NextResponse.json({ ok: true, silindi: plan.tur === "sil" });
    }
    if (isActive === true && Object.keys(data).length === 0) {
      if (kuralYururlukte(eski, an)) return NextResponse.json(eski);
      const rule = await prisma.commissionRule.create({ data: komisyonKuraliYenidenAcmaPlani(eski, an) });
      buAyiTazele([eskiPlatform], an);
      return NextResponse.json(rule);
    }

    const plan = komisyonKuraliGuncellemePlani(eski, degisiklik, an);
    let rule;
    if (plan.tur === "yerinde") {
      rule = await prisma.commissionRule.update({ where: { id }, data: plan.veri });
    } else {
      // Tek parça: eski dönem kapanır + yeni dönem açılır (biri düşerse ikisi de yazılmaz).
      const [, yeni] = await prisma.$transaction([
        prisma.commissionRule.update({ where: { id }, data: { validTo: plan.kapat.validTo } }),
        prisma.commissionRule.create({ data: plan.yeni }),
      ]);
      rule = yeni;
    }
    buAyiTazele([eskiPlatform, komisyonKuraliPlatformu(rule)], an);
    return NextResponse.json(rule);
  } catch (error) {
    return jsonError(error, 400);
  }
}

/**
 * Silme: bu aydan önce başlamış kural ayın 1'inden itibaren KAPANIR (geçmiş aylar onu kullanmaya
 * devam eder); bu ay eklenmiş kural gerçekten silinir. `?tamamen=1` = geçmişten de kaldır.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const eski = await prisma.commissionRule.findUnique({ where: { id } });
    if (!eski) return bulunamadi();
    const an = new Date();
    const tamamen = req.nextUrl.searchParams.get("tamamen") === "1";
    const plan = komisyonKuraliSilmePlani(eski, an, tamamen);
    if (plan.tur === "sil") await prisma.commissionRule.delete({ where: { id } });
    else await prisma.commissionRule.update({ where: { id }, data: { validTo: plan.validTo } });
    buAyiTazele([komisyonKuraliPlatformu(eski)], an);
    return NextResponse.json({ ok: true, kapatildi: plan.tur === "kapat" });
  } catch (error) {
    return jsonError(error);
  }
}
