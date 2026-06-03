/**
 * Tek kaynak: desteklenen satış platformları (Hepsiburada dahil).
 * Veri katmanı + UI buradan okur; yeni platform tek yerden eklenir.
 * Masaüstüyle aynı 3 platform: Shopify, Trendyol, Hepsiburada.
 */
export type Platform = "shopify" | "trendyol" | "hepsiburada";

/** Görüntü/işlem sırası. */
export const PLATFORMS: readonly Platform[] = ["shopify", "trendyol", "hepsiburada"] as const;

export const PLATFORM_LABEL: Record<Platform, string> = {
  shopify: "Shopify",
  trendyol: "Trendyol",
  hepsiburada: "Hepsiburada",
};

/** Marka renkleri (UI rozet/kart). */
export const PLATFORM_COLOR: Record<Platform, string> = {
  shopify: "#4FBF67", // yeşil (ML teması ile birebir)
  trendyol: "#F27A1A", // turuncu
  hepsiburada: "#FF6000", // HB turuncu
};
