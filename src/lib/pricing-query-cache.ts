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
    "product-profit",
    "profit-preview",
    "price-lab",
  ]) {
    queryClient.removeQueries({ queryKey: [queryKey] });
  }
}
