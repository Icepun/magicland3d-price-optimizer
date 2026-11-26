import { NextResponse } from "next/server";
import { getPublicShopifySettings } from "@/services/shopify-settings";
import { getPublicTrendyolSettings } from "@/services/trendyol-settings";
import { getPublicHepsiburadaSettings } from "@/services/hepsiburada-settings";
import { n11AcikAyarlar } from "@/services/n11-settings";

/**
 * UI tarafı için hangi platformların yapılandırılmış olduğunu döndürür.
 * Ürün listesindeki 'Ürün Seç' butonu bu bilgiye göre aktif/pasif olur.
 */
export async function GET() {
  const [shopify, trendyol, hepsiburada, n11] = await Promise.all([
    getPublicShopifySettings().catch(() => null),
    getPublicTrendyolSettings().catch(() => null),
    getPublicHepsiburadaSettings().catch(() => null),
    n11AcikAyarlar().catch(() => null),
  ]);

  return NextResponse.json({
    shopify: Boolean(shopify?.shopDomain && shopify.hasStorefrontAccessToken),
    trendyol: Boolean(
      trendyol?.sellerId && trendyol.hasApiKey && trendyol.hasApiSecret
    ),
    hepsiburada: Boolean(
      hepsiburada?.merchantId && hepsiburada.hasSecretKey && hepsiburada.developerUsername
    ),
    n11: Boolean(n11?.anahtarVar && n11.sifreVar),
  });
}
