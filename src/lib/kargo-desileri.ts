import { prisma } from "@/lib/prisma";
import { invalidateOrdersCache } from "@/lib/orders-cache";
import { bustCaches } from "@/lib/route-cache";
import { siparisKimligi } from "@/core/order-line-cost";
import { KARGO_DESI_PLATFORMLARI, kargoDesiAnahtari } from "@/core/kargo-desi";

const OKUMA_DILIMI = 400;

/**
 * Verilen siparişlerin ELLE GİRİLEN kargo desileri (`core/kargo-desi.ts`) → `kargoDesiAnahtari`
 * ile aranabilir harita. Sipariş listesi ve ay yeniden hesabı aynı fonksiyonu kullanır.
 *
 * Okuma düşerse boş harita: o tur kargo ürün desilerinden hesaplanır, liste yine gelir.
 */
export async function kargoDesileriniOku(
  siparisler: readonly { platform: string; id: string }[]
): Promise<Map<string, number>> {
  const harita = new Map<string, number>();
  const idler = [
    ...new Set(
      siparisler.filter((s) => KARGO_DESI_PLATFORMLARI.has(s.platform)).map((s) => siparisKimligi(s.platform, s.id))
    ),
  ];
  if (idler.length === 0) return harita;
  try {
    for (let i = 0; i < idler.length; i += OKUMA_DILIMI) {
      const satirlar = await prisma.orderCargoDesi.findMany({
        where: { externalOrderId: { in: idler.slice(i, i + OKUMA_DILIMI) } },
        select: { platform: true, externalOrderId: true, desi: true },
      });
      for (const s of satirlar) harita.set(kargoDesiAnahtari(s.platform, s.externalOrderId), s.desi);
    }
  } catch (err) {
    console.warn("[kargo-desisi] kayıtlar okunamadı:", err instanceof Error ? err.message : err);
    return new Map();
  }
  return harita;
}

/**
 * Desi değişti → o siparişin kayıtlı kârı bir sonraki sipariş yenilemesinde YENİDEN hesaplansın
 * (ilk tam kâr yakalandıktan sonra özet donuyor; işaret olmadan Raporlar eski kargoda kalırdı).
 * Siparişe özel maliyetteki işaretin aynısı.
 */
export async function kargoDesisiSonrasiTazele(platform: string, siparisId: string): Promise<void> {
  await prisma
    .$executeRawUnsafe(
      `UPDATE "OrderFinanceSnapshot" SET "calculationVersion" = 0 WHERE "platform" = ? AND "externalOrderId" = ?`,
      platform,
      siparisKimligi(platform, siparisId)
    )
    .catch(() => {});
  invalidateOrdersCache();
  bustCaches(["dashboard:", "finance-monthly:"]);
}
