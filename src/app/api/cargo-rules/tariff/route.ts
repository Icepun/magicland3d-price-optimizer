import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { bustProfitInputCaches } from "@/lib/cache-busting";
import { tarifeDonemSiniri } from "@/core/tariff-period";

/**
 * YENİ KARGO TARİFESİ BAŞLAT — tek işlemde dönem değiştirir.
 *
 * NEDEN VAR: kargo tarifeleri dönem dönem değişiyor. Eskiden yeni tarife girmek KOD
 * değişikliği gerektiriyordu (`runtime-schema-tex.ts` gibi elle yazılmış bir göç). Bu rota
 * aynı işi veriden yapar:
 *
 *   1. O platformun YÜRÜRLÜKTEKİ kuralları, yeni tarifenin başlangıcından 1 ms önce kapanır
 *      (`validTo`). SİLİNMEZ — o dönemde verilmiş siparişlerin kârı hâlâ onlardan hesaplanıyor
 *      (`core/order-profit.ts` kuralı siparişin KENDİ tarihine göre seçer).
 *   2. Yeni kurallar `validFrom` = başlangıç ile eklenir.
 *
 * Sınırda BOŞLUK BIRAKILMAZ: eşleşme kapsayıcı (`date > validTo` ise elenir), bu yüzden eski
 * dönem `başlangıç - 1 ms`de kapanır. Milisaniye çözünürlüğünde her an tam bir kurala düşer.
 *
 * ⚠️ GEÇMİŞE DOKUNMAZ. Zaten kapanmış dönemler (validTo dolu) hiç görülmez.
 */

const KuralSemasi = z.object({
  name: z.string().min(1),
  cargoProvider: z.string().nullable().optional(),
  categoryName: z.string().nullable().optional(),
  minPrice: z.coerce.number().min(0).default(0),
  maxPrice: z.coerce.number().min(0).default(999999),
  minDesi: z.coerce.number().min(0).default(0),
  maxDesi: z.coerce.number().min(0).default(999),
  cargoCost: z.coerce.number().min(0),
  vatIncluded: z.boolean().default(true),
  priority: z.coerce.number().int().default(10),
  isActive: z.boolean().default(true),
});

const Body = z.object({
  platform: z.enum(["trendyol", "shopify", "hepsiburada"]),
  /** Yeni tarifenin yürürlüğe girdiği an (ISO). Bu andan İTİBAREN geçerli. */
  startsAt: z.string().datetime({ offset: true }),
  rules: z.array(KuralSemasi).min(1).max(200),
});

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const { platform, startsAt, rules } = Body.parse(await req.json());

    const baslangic = new Date(startsAt);
    if (Number.isNaN(baslangic.getTime())) {
      return NextResponse.json({ error: "Başlangıç tarihi geçersiz." }, { status: 400 });
    }
    // Eski dönem, yeninin başlangıcından bir milisaniye önce kapanır → arada boşluk kalmaz.
    const { eskiBitis } = tarifeDonemSiniri(baslangic);

    /**
     * ⚠️ GERİYE DÖNÜK TARİFE ENGELİ.
     *
     * Kapatma işlemi "yürürlükteki" (validTo boş) kuralları hedefler. Eğer bu tarihten SONRA
     * başlayan bir tarife zaten varsa, o tarifenin kuralları kapatılır ve `validTo`ları kendi
     * `validFrom`larından ÖNCEYE düşer: hiçbir zaman eşleşemeyen ölü kurallar doğar, dönemler
     * de iç içe geçer. Aynı tarihte ikinci bir tarife de aynı sınıfta karmaşa yaratır.
     *
     * İkisini birden engelle: yeni tarife, var olan en son dönemden SONRA başlamalı.
     */
    const cakisan = await prisma.cargoRule.findFirst({
      where: { platform, validFrom: { gte: baslangic } },
      orderBy: { validFrom: "desc" },
      select: { validFrom: true },
    });
    if (cakisan) {
      const mevcut = cakisan.validFrom
        ? new Date(cakisan.validFrom).toLocaleDateString("tr-TR", { timeZone: "Europe/Istanbul" })
        : "";
      return NextResponse.json(
        {
          error:
            `${mevcut} tarihinde başlayan bir tarife zaten var. ` +
            `Yeni tarife ondan sonraki bir tarihte başlamalı.`,
        },
        { status: 409 }
      );
    }

    const kapanan = await prisma.cargoRule.updateMany({
      where: { platform, validTo: null },
      data: { validTo: eskiBitis },
    });

    await prisma.cargoRule.createMany({
      data: rules.map((r) => ({
        name: r.name,
        platform,
        cargoProvider: r.cargoProvider ?? null,
        categoryName: r.categoryName ?? null,
        minPrice: r.minPrice,
        maxPrice: r.maxPrice,
        minDesi: r.minDesi,
        maxDesi: r.maxDesi,
        cargoCost: r.cargoCost,
        vatIncluded: r.vatIncluded,
        validFrom: baslangic,
        validTo: null,
        priority: r.priority,
        isActive: r.isActive,
      })),
    });

    // Kargo değişti → sipariş kârı bir sonraki istekte yeni baremle hesaplansın.
    bustProfitInputCaches();

    return NextResponse.json({
      ok: true,
      platform,
      kapanan: kapanan.count,
      eklenen: rules.length,
      baslangic: baslangic.toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Tarife başlatılamadı" },
      { status: 400 }
    );
  }
}
