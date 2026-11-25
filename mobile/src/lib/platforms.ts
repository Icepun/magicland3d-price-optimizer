/**
 * Tek kaynak: desteklenen satış platformları (Hepsiburada dahil).
 * Veri katmanı + UI buradan okur; yeni platform tek yerden eklenir.
 * Masaüstüyle aynı 3 platform: Shopify, Trendyol, Hepsiburada.
 */
export type Platform = "shopify" | "trendyol" | "hepsiburada";
export type OrderPlatform = Platform | "manual";

/** Görüntü/işlem sırası. */
export const PLATFORMS: readonly Platform[] = ["shopify", "trendyol", "hepsiburada"] as const;
export const ORDER_PLATFORMS: readonly OrderPlatform[] = [...PLATFORMS, "manual"] as const;

export const PLATFORM_LABEL: Record<Platform, string> = {
  shopify: "Shopify",
  trendyol: "Trendyol",
  hepsiburada: "Hepsiburada",
};

export const ORDER_PLATFORM_LABEL: Record<OrderPlatform, string> = {
  ...PLATFORM_LABEL,
  manual: "Manuel",
};

/**
 * Dar yüzeyler için kısa etiket — "Hepsiburada" Panel'deki platform çipine sığmıyordu (taşıyordu),
 * Berke "HB" yazılmasını onayladı (2026-09-04). Uzun etiket gereken yerde PLATFORM_LABEL kullan.
 */
export const PLATFORM_SHORT_LABEL: Record<Platform, string> = {
  ...PLATFORM_LABEL,
  hepsiburada: "HB",
};

export const ORDER_PLATFORM_SHORT_LABEL: Record<OrderPlatform, string> = {
  ...PLATFORM_SHORT_LABEL,
  manual: "Manuel",
};

/** Marka renkleri (UI rozet/kart) — masaüstüyle AYNI (`PLATFORM_RENGI`): Trendyol HER YERDE turuncu,
 * Hepsiburada Magicland mavisi (iki turuncu yan yana karışıyordu), Shopify zümrüt. */
export const PLATFORM_COLOR: Record<Platform, string> = {
  shopify: "#34D399",
  trendyol: "#F27A1A",
  hepsiburada: "#4F8CFF",
};

export const ORDER_PLATFORM_COLOR: Record<OrderPlatform, string> = {
  ...PLATFORM_COLOR,
  manual: "#C9D2F2",
};
