import type { QueryClient } from "@tanstack/react-query";

/**
 * Fiyatlama girdisi değiştiğinde, global `refetchOnMount: false` nedeniyle yalnızca "stale"
 * işaretlemek yetmez. İnaktif ağır sorguları tamamen kaldırırız; ilgili sayfa bir sonraki açılışta
 * yeni kurallar ve ayarlarla hesaplanmış veriyi çeker.
 */
export function clearPricingQueryCache(
  queryClient: QueryClient,
  /** ayarlarDokunma: filament gibi ayar DIŞI değişikliklerde ayarlar sorgusuna dokunma. */
  secenek: { ayarlarDokunma?: boolean } = {},
): void {
  /**
   * AYARLAR SİLİNMEZ, TAZELENİR (pasif olanlar dahil). Eskiden silinirdi: Maliyet & Paketleme
   * sayfasındaki formlar sıfır/varsayılan değerlerle yeniden kuruluyor, kaydedilmemiş değişiklikler
   * gidiyor, ardından gelen istek düşerse sıfırlar ekranda kalıyordu (denetim, 23 Kas 2026).
   */
  if (!secenek.ayarlarDokunma) void queryClient.invalidateQueries({ queryKey: ["app-settings"], refetchType: "all" });
  for (const queryKey of [
    "products",
    "orders",
    "dashboard",
    "price-changes",
    // ⚠️ ÜRÜN DETAYI da düşürülmeli: `["products"]` (liste) öneki `["product", id]` (detay)
    // ile EŞLEŞMEZ. Eksikken kargo/komisyon/gider/reklam/maliyet/paketleme değişiklikleri
    // detayda eski kârı göstermeye devam ediyordu — yedi akış birden.
    "product",
    "price-history",
    // KDV oranı da bir fiyatlama girdisi (detay sayfası kâr önizlemesini istemcide hesaplıyor) —
    // "app-settings" yukarıda TAZELENİYOR (silinmiyor).
  ]) {
    queryClient.removeQueries({ queryKey: [queryKey] });
  }
}
