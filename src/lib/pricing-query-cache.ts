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
  ]) {
    queryClient.removeQueries({ queryKey: [queryKey] });
  }
}
