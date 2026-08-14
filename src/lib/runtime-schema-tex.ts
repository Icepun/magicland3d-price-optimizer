import { prisma } from "@/lib/prisma";
import {
  TEX_ESKI_TARIFE_BITIS,
  TEX_YENI_TARIFE_BASLANGIC,
  buildTexCargoRules,
} from "@/core/tex-tariff";

/**
 * TEX tarife güncellemesi (1 Ağustos 2026) — BİR KEZ çalışır.
 *
 * ⚠️ KÂR RAKAMINI DEĞİŞTİRİR. Bu yüzden eski kurallar SİLİNMEZ, `validTo` ile kapatılır:
 * Temmuz ve öncesi siparişler kendi dönemlerinin tarifesiyle hesaplanmaya devam eder
 * (`order-profit.ts → orderedAt` bunu sağlıyor). Yeni kurallar `validFrom` ile başlar.
 *
 * Tekrar çalışırsa hiçbir şey yapmaz: yeni kuralların varlığına bakılır.
 */
export async function migrateTexTariff2026Agustos(): Promise<boolean> {
  try {
    const zatenVar = await prisma.cargoRule.count({
      where: { platform: "trendyol", validFrom: new Date(TEX_YENI_TARIFE_BASLANGIC) },
    });
    if (zatenVar > 0) return true;

    // Hangi barem modu aktif? Yeni kurallar aynı modla açılsın ki düğme yerinde kalsın.
    const modSatiri = await prisma.appSetting.findUnique({ where: { key: "trendyolCargoMode" } });
    const aktifMod = modSatiri?.value === "avantajli" ? "avantajli" : "standart";

    // Eski TEX kurallarını KAPAT (silme yok — geçmiş siparişler onlara bağlı).
    await prisma.cargoRule.updateMany({
      where: { platform: "trendyol", validTo: null },
      data: { validTo: new Date(TEX_ESKI_TARIFE_BITIS) },
    });

    const yeni = buildTexCargoRules(aktifMod);
    await prisma.cargoRule.createMany({
      data: yeni.map((r) => ({
        name: r.name,
        platform: r.platform,
        cargoProvider: r.cargoProvider,
        categoryName: r.categoryName,
        minPrice: r.minPrice,
        maxPrice: r.maxPrice,
        minDesi: r.minDesi,
        maxDesi: r.maxDesi,
        cargoCost: r.cargoCost,
        vatIncluded: r.vatIncluded,
        validFrom: new Date(r.validFrom),
        validTo: null,
        priority: r.priority,
        isActive: r.isActive,
      })),
    });
    return true;
  } catch {
    // Göç isteğe bağlıdır: başarısız olursa açılış BLOKLANMAZ (bkz. optional-step-must-not-block).
    return false;
  }
}
