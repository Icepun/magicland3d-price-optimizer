import type { QueryClient } from "@tanstack/react-query";

/**
 * Fiyatlama girdisi değiştiğinde, global `refetchOnMount: false` nedeniyle yalnızca "stale"
 * işaretlemek yetmez. İnaktif ağır sorguları tamamen kaldırırız; ilgili sayfa bir sonraki açılışta
 * yeni kurallar ve ayarlarla hesaplanmış veriyi çeker.
 */
export function clearPricingQueryCache(queryClient: QueryClient): void {
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
    // KDV oranı da bir fiyatlama girdisi. Detay sayfası kâr önizlemesini bu gövdeden
    // İSTEMCİDE hesaplıyor; düşürülmezse yeni oran sunucuda geçerli olduğu hâlde ekranda
    // 10 dakikaya kadar ESKİ oranla kâr gösteriliyordu.
    "app-settings",
  ]) {
    queryClient.removeQueries({ queryKey: [queryKey] });
  }
}
