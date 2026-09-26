import { prisma } from "@/lib/prisma";
import { filamentFiyatHaritasi } from "@/core/filament-karisimi";

/**
 * Tüm filament türlerinin GÜNCEL gram fiyatı — `resolveProductCost`un 4. parametresi.
 * Çoklu filamentli ürünlerde ek filamentlerin tutarı buradan okunur (bkz. core/filament-karisimi).
 *
 * Okuma düşerse boş harita döner: ek filamentli ürünler o tur "maliyet eksik" görünür (tedbirli
 * yön), tek filamentli ürünler hiç etkilenmez.
 */
export async function filamentFiyatlariOku(): Promise<Map<string, number>> {
  try {
    const turler = await prisma.filamentType.findMany({ select: { id: true, costPerGram: true } });
    return filamentFiyatHaritasi(turler);
  } catch (err) {
    console.warn("[filament] fiyat listesi okunamadı:", err instanceof Error ? err.message : err);
    return new Map();
  }
}
