import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { bustProfitInputCaches } from "@/lib/cache-busting";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { yeniKuralBaslangiciMs } from "@/core/tariff-period";
import { jsonError } from "@/lib/api-error";
import { kuralSonrasiSiparisleriTazele } from "@/lib/kural-sonrasi-tazele";

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
 * Yeni kural BU AYIN 1'inden başlar (yürürlükteki dönem bu aydan sonra başladıysa dönemin başından)
 * — Berke'nin kararı: "tüm kasıma etki etsin, öncesine değil". Kural çekirdekte
 * (`core/tariff-period.ts`), telefon da aynısını kullanıyor.
 */
async function yeniKuralBaslangici(platform: string): Promise<Date> {
  const acikKurallar = await prisma.cargoRule.findMany({
    where: { platform },
    select: { validFrom: true, validTo: true },
  });
  return new Date(yeniKuralBaslangiciMs(acikKurallar, Date.now()));
}

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const body = await req.json();
    const data = Schema.parse(body);
    // Platformsuz kural her şema göçünde Trendyol'a taşınıyor ve Shopify'da kargosuz kalıyordu:
    // platform ZORUNLU (düzenlenebilir kurallar yalnız Shopify'da; pazaryerleri tarifeden gelir).
    const platform = data.platform ?? "shopify";
    const validFrom = await yeniKuralBaslangici(platform);
    const rule = await prisma.cargoRule.create({ data: { ...data, platform, validFrom } });
    bustProfitInputCaches(); // kargo kuralı değişti → sipariş kârı taze hesaplansın
    // Bu ayın kayıtlı kârları da yeni kuralı görsün (Panel/Raporlar ↔ Siparişler aynı rakam).
    void kuralSonrasiSiparisleriTazele(platform, validFrom).catch((err) =>
      console.warn("[kargo-kuralı] yeniden hesap düştü:", err instanceof Error ? err.message : err)
    );
    return NextResponse.json(rule, { status: 201 });
  } catch (error) {
    return jsonError(error, 400);
  }
}
