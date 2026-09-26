import { NextResponse } from "next/server";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { getPublicShopifySettings } from "@/services/shopify-settings";
import { katalogFarkiniHesapla } from "@/lib/shopify-katalog-sunucu";

/**
 * Shopify ↔ uygulama farkı ("Shopify'dan Ekle" penceresi ve Ürünler'deki rozet).
 *   GET              → { bagli, yeni[], gizli[], kalkan[], ozet }
 *   GET ?ozet=1      → yalnız sayılar (rozet)
 *   GET ?tazele=1    → Shopify'dan yeniden çek (önbelleği atla)
 */
export async function GET(req: Request) {
  try {
    await ensureRuntimeSchema();
    const ayar = await getPublicShopifySettings().catch(() => null);
    if (!ayar?.shopDomain || !ayar.hasStorefrontAccessToken) {
      return NextResponse.json({ bagli: false }, { headers: { "Cache-Control": "no-store" } });
    }
    const url = new URL(req.url);
    const fark = await katalogFarkiniHesapla(url.searchParams.get("tazele") === "1");
    if (url.searchParams.get("ozet") === "1") {
      return NextResponse.json({ bagli: true, ozet: fark.ozet }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ bagli: true, ...fark }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error, 502);
  }
}
