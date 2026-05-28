import type { ShopifyCredentials } from "./shopify-settings";

/**
 * Shopify Storefront API (GraphQL) istemcisi.
 *
 * Endpoint: https://{shop}.myshopify.com/api/{version}/graphql.json
 * Auth: X-Shopify-Storefront-Access-Token header'ı
 *
 * Eski Admin REST interface'i ({id,title,variants,...}) korunuyor — sync-products
 * kodu değişmeden çalışıyor.
 */

export interface ShopifyProductVariant {
  id: number;
  product_id: number;
  title: string;
  price: string;
  sku: string;
  barcode: string | null;
  inventory_quantity: number;
}

export interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  status: string;
  product_type: string;
  image?: { src: string } | null;
  variants: ShopifyProductVariant[];
}

interface StorefrontProductsResponse {
  data?: {
    products?: {
      edges: Array<{
        cursor: string;
        node: {
          id: string;
          title: string;
          handle: string;
          productType: string;
          availableForSale: boolean;
          featuredImage: { url: string } | null;
          variants: {
            edges: Array<{
              node: {
                id: string;
                title: string;
                sku: string | null;
                barcode: string | null;
                price: { amount: string };
                quantityAvailable: number | null;
              };
            }>;
          };
        };
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  errors?: Array<{ message: string }>;
}

interface StorefrontShopResponse {
  data?: { shop?: { name: string; primaryDomain?: { url: string } } };
  errors?: Array<{ message: string }>;
}

const PRODUCTS_QUERY = `
  query GetProducts($cursor: String) {
    products(first: 100, after: $cursor) {
      edges {
        cursor
        node {
          id
          title
          handle
          productType
          availableForSale
          featuredImage {
            url
          }
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
                barcode
                price {
                  amount
                }
                quantityAvailable
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const SHOP_QUERY = `
  query {
    shop {
      name
      primaryDomain {
        url
      }
    }
  }
`;

function extractNumericId(gid: string): number {
  const match = gid.match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

export class ShopifyClient {
  constructor(private credentials: ShopifyCredentials) {}

  private endpoint() {
    return `https://${this.credentials.shopDomain}/api/${this.credentials.apiVersion}/graphql.json`;
  }

  /**
   * Shopify Storefront API auth header'ı token tipine göre seçilir:
   * - Private (Headless Özel Erişim Belirteci, shpat_ prefix) → server-only
   *   `Shopify-Storefront-Private-Token` header
   * - Public (32-char hex Genel Erişim Belirteci) → istemci tarafı
   *   `X-Shopify-Storefront-Access-Token` header
   *
   * Yanlış header ile gönderilince Shopify 401 UNAUTHORIZED döner.
   */
  private authHeaders(): Record<string, string> {
    const token = this.credentials.storefrontAccessToken;
    const isPrivate = token.startsWith("shpat_") || token.startsWith("shpsa_");
    return isPrivate
      ? { "Shopify-Storefront-Private-Token": token }
      : { "X-Shopify-Storefront-Access-Token": token };
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.endpoint(), {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          "Shopify Storefront token reddedildi. Headless kanalı → Storefront API → Özel Erişim Belirteci doğru mu? İzinlerde unauthenticated_read_product_listings + unauthenticated_read_product_inventory açık mı?"
        );
      }
      if (res.status === 404) {
        throw new Error(
          "Shopify alan adı bulunamadı (404). 'magaza.myshopify.com' formatında olmalı."
        );
      }
      throw new Error(
        `Shopify Storefront API hatası: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`
      );
    }

    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors && json.errors.length > 0) {
      throw new Error(
        `Shopify GraphQL hatası: ${json.errors.map((e) => e.message).join("; ")}`
      );
    }
    return json as unknown as T;
  }

  async listAllProducts(): Promise<ShopifyProduct[]> {
    const allProducts: ShopifyProduct[] = [];
    let cursor: string | null = null;
    let hasNext = true;
    let safetyCounter = 0;

    while (hasNext && safetyCounter < 100) {
      safetyCounter += 1;
      const response: StorefrontProductsResponse = await this.graphql<StorefrontProductsResponse>(
        PRODUCTS_QUERY,
        { cursor }
      );

      const productsData = response.data?.products;
      if (!productsData) break;

      for (const edge of productsData.edges) {
        const p = edge.node;
        const productId = extractNumericId(p.id);

        const variants: ShopifyProductVariant[] = p.variants.edges.map((vEdge) => {
          const v = vEdge.node;
          return {
            id: extractNumericId(v.id),
            product_id: productId,
            title: v.title,
            price: v.price?.amount ?? "0",
            sku: v.sku ?? "",
            barcode: v.barcode ?? null,
            inventory_quantity: v.quantityAvailable ?? 0,
          };
        });

        allProducts.push({
          id: productId,
          title: p.title,
          handle: p.handle,
          // Storefront API sadece "active" döner; archive/draft görünmüyor
          status: p.availableForSale ? "active" : "draft",
          product_type: p.productType || "Shopify",
          image: p.featuredImage ? { src: p.featuredImage.url } : null,
          variants,
        });
      }

      hasNext = productsData.pageInfo.hasNextPage;
      cursor = productsData.pageInfo.endCursor;
      if (!cursor) break;
    }

    return allProducts;
  }

  async testConnection(): Promise<{ shop: string }> {
    const response = await this.graphql<StorefrontShopResponse>(SHOP_QUERY);
    const shopName = response.data?.shop?.name;
    if (!shopName) {
      throw new Error("Shopify shop bilgisi alınamadı");
    }
    return { shop: shopName };
  }
}
