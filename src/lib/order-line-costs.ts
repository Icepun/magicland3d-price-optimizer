import { prisma } from "@/lib/prisma";
import {
  satirMaliyetiHaritaAnahtari,
  siparisKimligi,
  type SatirMaliyetKaydi,
} from "@/core/order-line-cost";

export type { SatirMaliyetKaydi };

const OKUMA_DILIMI = 400;

/**
 * Verilen siparişlerin "siparişe özel maliyet" kayıtları → `satirMaliyetiHaritaAnahtari` ile
 * aranabilir harita. Sipariş listesi ve ay yeniden hesabı aynı fonksiyonu kullanır.
 *
 * Okuma düşerse boş harita: o tur bu satırlar eskisi gibi "maliyet eksik" görünür, liste yine gelir.
 */
export async function satirMaliyetleriniOku(
  siparisler: readonly { platform: string; id: string }[]
): Promise<Map<string, SatirMaliyetKaydi>> {
  const harita = new Map<string, SatirMaliyetKaydi>();
  const idler = [...new Set(siparisler.map((s) => siparisKimligi(s.platform, s.id)))];
  if (idler.length === 0) return harita;
  try {
    for (let i = 0; i < idler.length; i += OKUMA_DILIMI) {
      const satirlar = await prisma.orderLineCost.findMany({
        where: { externalOrderId: { in: idler.slice(i, i + OKUMA_DILIMI) } },
        select: {
          platform: true,
          externalOrderId: true,
          lineKey: true,
          lineName: true,
          costJson: true,
          desi: true,
        },
      });
      for (const s of satirlar) {
        harita.set(satirMaliyetiHaritaAnahtari(s.platform, s.externalOrderId, s.lineKey), s);
      }
    }
  } catch (err) {
    console.warn("[sipariş-maliyeti] kayıtlar okunamadı:", err instanceof Error ? err.message : err);
    return new Map();
  }
  return harita;
}
