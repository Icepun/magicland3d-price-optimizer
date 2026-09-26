import { invalidateOrdersCache } from "@/lib/orders-cache";
import { bustCaches } from "@/lib/route-cache";
import { recalculateFinanceMonths } from "@/lib/order-finance-snapshots";
import type { EtkilenenSiparisler } from "@/lib/order-line-links";

/**
 * Bir satır düzeltmesinden (elle ürün bağı, "tüm siparişler" maliyeti) sonra ekranlar yeni hesabı
 * görsün; etkilenen siparişlerin kârı YALNIZ o siparişler için arka planda yeniden hesaplanır.
 *
 * Kayıtlı kâr, kullanıcının az önce düzelttiği bilgiyle hesaplanmıştı → "maliyet bilinmiyor"
 * sonucu da yazılır (bağ/maliyet kaldırılınca sipariş yeniden "maliyet eksik" olmalı).
 *
 * Ayrı dosya: order-finance-snapshots zaten order-line-links'i içe aktarıyor; yeniden hesabı
 * oraya koymak döngüsel içe aktarma doğururdu.
 */
export function siparisleriTazele(e: EtkilenenSiparisler): void {
  const onbellekleriDusur = () => {
    invalidateOrdersCache();
    bustCaches(["dashboard:", "finance-monthly:", "products:profitability", "planner-queue:"]);
  };
  onbellekleriDusur();
  if (e.externalOrderIds.length === 0 || e.aylar.length === 0) return;
  // Beklenmiyor: yüzlerce siparişi ilgilendirebilir, isteği bekletmek arayüzü kilitlerdi. Düşerse
  // siparişler zaten "eski hesap" işaretli — Siparişler/Raporlar bir sonraki turda düzeltir.
  void recalculateFinanceMonths(e.aylar, {
    yalnizSiparisler: e.externalOrderIds.map((externalOrderId) => ({
      platform: e.platform,
      externalOrderId,
    })),
    bilinmeyenKariYaz: true,
  })
    .then(onbellekleriDusur)
    .catch((err) =>
      console.warn("[satır-düzeltme] yeniden hesap düştü:", err instanceof Error ? err.message : err)
    );
}
