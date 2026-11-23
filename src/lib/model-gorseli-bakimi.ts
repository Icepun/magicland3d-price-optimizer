import { gorselleriTasi } from "@/lib/model-gorseli";
import { perfYaz } from "@/lib/server-perf-log";

/**
 * AÇILIŞ BAKIMI — eski `ProductModelFile.thumbnail` kolonundaki görselleri `ProductModelFileThumb`
 * tablosuna taşır, yetim görselleri siler (bkz. lib/model-gorseli.ts).
 *
 * ⚠️ Açılışı ASLA bekletmez ve hata fırlatmaz (bellek: isteğe bağlı adım hızlı yolu bloklamaz).
 * Çağıran `void` ile bırakır. Taşıma düşerse bir sonraki açılış yeniden dener; o arada görseller
 * gösteren uçta eski kolondan okunmaya devam eder.
 */
let basladi = false;

export async function modelGorseliBakimi(): Promise<void> {
  if (basladi) return;
  basladi = true;
  const bas = Date.now();
  try {
    const sonuc = await gorselleriTasi();
    if (sonuc.tasinan > 0) {
      perfYaz(`MODEL-GORSELI ${sonuc.tasinan} görsel taşındı (${sonuc.yontem}, ${Date.now() - bas}ms)`);
    }
  } catch (error) {
    perfYaz(`MODEL-GORSELI taşıma düştü (${Date.now() - bas}ms): ${error instanceof Error ? error.message.slice(0, 160) : "?"}`);
  }
}
