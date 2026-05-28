import { NextResponse } from "next/server";
import { getShopifyCredentials } from "@/services/shopify-settings";
import { jsonError } from "@/lib/api-error";

/**
 * Storefront API bağlantı testi.
 *
 * Endpoint adı 'generate-token' geriye uyum için tutuldu; artık token üretmiyor,
 * Storefront API GraphQL endpoint'ine 2 sorgu atıp adım adım sonuç döner.
 */
export async function POST() {
  try {
    const credentials = await getShopifyCredentials();
    const result: {
      steps: Array<{
        name: string;
        status: "ok" | "fail";
        detail: string;
        responseStatus?: number;
        responseBody?: unknown;
      }>;
    } = { steps: [] };

    const endpoint = `https://${credentials.shopDomain}/api/${credentials.apiVersion}/graphql.json`;
    // Private (shpat_) → server header; Public (32-hex) → client header
    const isPrivate =
      credentials.storefrontAccessToken.startsWith("shpat_") ||
      credentials.storefrontAccessToken.startsWith("shpsa_");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(isPrivate
        ? { "Shopify-Storefront-Private-Token": credentials.storefrontAccessToken }
        : { "X-Shopify-Storefront-Access-Token": credentials.storefrontAccessToken }),
    };

    // ─── ADIM 1: shop query ──────────────────────────────────────
    try {
      const shopRes = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: `query { shop { name primaryDomain { url } } }`,
        }),
      });
      const shopText = await shopRes.text();
      let shopJson: unknown = null;
      try {
        shopJson = JSON.parse(shopText);
      } catch {
        shopJson = shopText.slice(0, 500);
      }

      const shopData = (shopJson as { data?: { shop?: { name?: string; primaryDomain?: { url?: string } } }; errors?: Array<{ message: string }> });
      const ok = shopRes.ok && !shopData.errors && Boolean(shopData.data?.shop?.name);

      result.steps.push({
        name: "1. Mağaza Sorgusu (shop)",
        status: ok ? "ok" : "fail",
        detail: ok
          ? `${shopData.data?.shop?.name} — ${shopData.data?.shop?.primaryDomain?.url ?? ""}`
          : shopData.errors
            ? shopData.errors.map((e) => e.message).join("; ")
            : `${shopRes.status} ${shopRes.statusText}`,
        responseStatus: shopRes.status,
        responseBody: ok
          ? { name: shopData.data?.shop?.name, primaryDomain: shopData.data?.shop?.primaryDomain }
          : shopJson,
      });

      if (!ok) return NextResponse.json(result);
    } catch (error) {
      result.steps.push({
        name: "1. Mağaza Sorgusu (shop)",
        status: "fail",
        detail: error instanceof Error ? error.message : "Network hatası",
      });
      return NextResponse.json(result);
    }

    // ─── ADIM 2: ilk 3 ürün ─────────────────────────────────────
    try {
      const prodRes = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: `query { products(first: 3) { edges { node { id title variants(first: 1) { edges { node { sku barcode price { amount } } } } } } } }`,
        }),
      });
      const prodText = await prodRes.text();
      let prodJson: unknown = null;
      try {
        prodJson = JSON.parse(prodText);
      } catch {
        prodJson = prodText.slice(0, 500);
      }

      const prodData = (prodJson as { data?: { products?: { edges: Array<{ node: { id: string; title: string } }> } }; errors?: Array<{ message: string }> });
      const products = prodData.data?.products?.edges ?? [];
      const ok = prodRes.ok && !prodData.errors && products.length > 0;

      result.steps.push({
        name: "2. Ürün Sorgusu (products)",
        status: ok ? "ok" : "fail",
        detail: ok
          ? `${products.length} ürün döndü`
          : prodData.errors
            ? prodData.errors.map((e) => e.message).join("; ")
            : products.length === 0
              ? "0 ürün — Storefront API izinlerinde unauthenticated_read_product_listings açık mı?"
              : `${prodRes.status} ${prodRes.statusText}`,
        responseStatus: prodRes.status,
        responseBody: ok
          ? {
              productCount: products.length,
              sample: products.map((edge) => ({
                id: edge.node.id,
                title: edge.node.title,
              })),
            }
          : prodJson,
      });
    } catch (error) {
      result.steps.push({
        name: "2. Ürün Sorgusu (products)",
        status: "fail",
        detail: error instanceof Error ? error.message : "Network hatası",
      });
    }

    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}
