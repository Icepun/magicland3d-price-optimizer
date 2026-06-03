import { NextResponse } from "next/server";
import { getPublicShopifySettings } from "@/services/shopify-settings";
import { getPublicTrendyolSettings } from "@/services/trendyol-settings";
import { getPublicHepsiburadaSettings } from "@/services/hepsiburada-settings";

/**
 * UI tarafı için hangi platformların yapılandırılmış olduğunu döndürür.
 * Ürün listesindeki 'Ürün Seç' butonu bu bilgiye göre aktif/pasif olur.
 */
export async function GET() {
  const [shopify, trendyol, hepsiburada] = await Promise.all([
    getPublicShopifySettings().catch(() => null),
    getPublicTrendyolSettings().catch(() => null),
    getPublicHepsiburadaSettings().catch(() => null),
  ]);

  return NextResponse.json({
    shopify: Boolean(shopify?.shopDomain && shopify.hasStorefrontAccessToken),
    trendyol: Boolean(
      trendyol?.sellerId && trendyol.hasApiKey && trendyol.hasApiSecret
    ),
    hepsiburada: Boolean(
      hepsiburada?.merchantId && hepsiburada.hasSecretKey && hepsiburada.developerUsername
    ),
  });
}
