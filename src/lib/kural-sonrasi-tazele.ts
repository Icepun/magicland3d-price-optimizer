import { prisma } from "@/lib/prisma";
import { recalculateFinanceMonths } from "@/lib/order-finance-snapshots";
import { invalidateOrdersCache } from "@/lib/orders-cache";
import { bustCaches } from "@/lib/route-cache";
import { parseDbDate } from "@/core/sqlite-date";

const TR_KAYMA_MS = 3 * 60 * 60_000;

function ayAnahtari(ms: number): string {
  const d = new Date(ms + TR_KAYMA_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Bugünden GERİYE uygulanan yeni bir kuraldan sonra (Berke: "yeni kargo kuralı tüm kasıma etki
 * etsin") kayıtlı kârlar da aynı kuralı görsün: YALNIZ o platformun, kuralın başlangıcından sonraki
 * siparişleri arka planda yeniden hesaplanır. Siparişler canlı hesapladığı için hemen görür;
 * Panel ve Raporlar kayıtlı kârdan okur — yeniden hesap olmadan üç ekran farklı rakam gösterirdi.
 *
 * Tarih süzmesi JS'te `parseDbDate` ile (Prisma `gte` karışık biçimli tarihlerde satır eler).
 */
export async function kuralSonrasiSiparisleriTazele(platform: string, baslangic: Date): Promise<void> {
  const onbellekleriDusur = () => {
    invalidateOrdersCache();
    bustCaches(["dashboard:", "finance-monthly:", "products:profitability"]);
  };
  const basMs = baslangic.getTime();
  if (!Number.isFinite(basMs)) return;
  const satirlar = await prisma.orderFinanceSnapshot.findMany({
    where: { platform },
    select: { externalOrderId: true, orderedAt: true },
  });
  const secilen: { platform: string; externalOrderId: string }[] = [];
  const aylar = new Set<string>();
  for (const s of satirlar) {
    const t = parseDbDate(s.orderedAt)?.getTime();
    if (t == null || t < basMs) continue;
    secilen.push({ platform, externalOrderId: s.externalOrderId });
    aylar.add(ayAnahtari(t));
  }
  onbellekleriDusur();
  if (secilen.length === 0) return;
  await recalculateFinanceMonths([...aylar], { yalnizSiparisler: secilen });
  onbellekleriDusur();
}
