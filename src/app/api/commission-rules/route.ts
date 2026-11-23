import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { bustProfitInputCaches } from "@/lib/cache-busting";
import { jsonError } from "@/lib/api-error";
import { yeniKuralBaslangiciMs } from "@/core/tariff-period";
import { kuralSonrasiSiparisleriTazele } from "@/lib/kural-sonrasi-tazele";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

/**
 * Doğrulama TÜRKÇE ve sıkı: boş oran %0 kural, ters fiyat aralığı ölü kural üretiyordu
 * (denetim, 23 Kas 2026). Telefon da aynı kuralları uygular.
 */
const Schema = z
  .object({
    name: z.string().trim().min(1, "Kural adı gerekli"),
    categoryName: z.string().trim().nullable().optional(),
    minPrice: z.number({ message: "Min fiyat bir sayı olmalı" }).min(0, "Min fiyat eksi olamaz").default(0),
    maxPrice: z.number({ message: "Max fiyat bir sayı olmalı" }).min(0, "Max fiyat eksi olamaz").default(999999),
    commissionRate: z.number({ message: "Komisyon oranı gerekli" }).min(0, "Oran eksi olamaz").max(1, "Oran %100'den büyük olamaz"),
    fixedCommission: z.number().min(0, "Sabit komisyon eksi olamaz").default(0),
    priority: z.number().int("Öncelik tam sayı olmalı").default(10),
    // Kural yalnız bu pazaryerinin ilanına uyar (Hepsiburada ilanı Trendyol kuralını devralmasın).
    platform: z.enum(["trendyol", "hepsiburada"], { message: "Pazaryeri seç" }).default("trendyol"),
  })
  .refine((d) => d.maxPrice >= d.minPrice, { message: "Max fiyat min fiyattan küçük olamaz", path: ["maxPrice"] });

export async function GET() {
  try {
    await ensureRuntimeSchema();
    // Kapanmış (geçmiş) kurallar da döner: ekran yürürlüktekileri ve geçmişi ayrı gösterir.
    const rules = await prisma.commissionRule.findMany({
      orderBy: [{ isActive: "desc" }, { priority: "desc" }, { name: "asc" }],
    });
    return NextResponse.json(rules);
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const data = Schema.parse(await req.json());
    // Yeni kural BU AYIN 1'inden başlar — geçmiş ayların kârı değişmez (kargo kuralıyla aynı karar).
    const validFrom = new Date(yeniKuralBaslangiciMs([], Date.now()));
    const rule = await prisma.commissionRule.create({
      data: { ...data, categoryName: data.categoryName || null, validFrom, validTo: null, isActive: true },
    });
    bustProfitInputCaches(); // komisyon değişti → sipariş kârı taze hesaplansın
    // Bu ayın kayıtlı kârları da yeni kuralı görsün (Panel/Raporlar ↔ Siparişler aynı rakam).
    void kuralSonrasiSiparisleriTazele(data.platform, validFrom).catch((err) =>
      console.warn("[komisyon-kuralı] yeniden hesap düştü:", err instanceof Error ? err.message : err)
    );
    return NextResponse.json(rule, { status: 201 });
  } catch (error) {
    return jsonError(error, 400);
  }
}
