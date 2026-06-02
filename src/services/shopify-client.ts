import type { ShopifyCredentials } from "./shopify-settings";

/**
 * Client-credentials Admin API erişim token'ı önbelleği (modül seviyesi, 24 saat).
 * Anahtar: `${shopDomain}:${clientId}`. İstekler arası aynı token paylaşılır.
 */
const adminTokenCache = new Map<string, { token: string; expiresAt: number }>();

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
  /** Varyanta özel görsel (yoksa null → ürün featuredImage'ine düşülür). */
  image: string | null;
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

export interface ShopifyOrderLine {
  title: string;
  quantity: number;
  unitPrice: number;
  barcode: string | null;
  sku: string | null;
  variantId: string | null;
  variantSku: string | null;
  image: string | null;
}

export interface ShopifyOrder {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  totalAmount: number;
  currency: string;
  customerName: string | null;
  lines: ShopifyOrderLine[];
  trackingNumber: string | null;
  cargoProvider: string | null;
}

/** Client ID/Secret tanımlı değilken fırlatılır — UI "kimlik bilgileri gerekli" gösterir. */
export class ShopifyAdminTokenMissingError extends Error {
  constructor() {
    super("Shopify Client ID / Client Secret tanımlı değil (siparişler için gerekli)");
    this.name = "ShopifyAdminTokenMissingError";
  }
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
                image: { url: string } | null;
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

interface AdminOrdersResponse {
  data?: {
    orders?: {
      edges: Array<{
        node: {
          id: string;
          name: string;
          createdAt: string;
          cancelledAt: string | null;
          displayFinancialStatus: string | null;
          displayFulfillmentStatus: string | null;
          totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
          customer: { firstName: string | null; lastName: string | null } | null;
          lineItems: {
            edges: Array<{
              node: {
                title: string;
                quantity: number;
                sku: string | null;
                variant: { id: string | null; barcode: string | null; sku: string | null } | null;
                image: { url: string } | null;
                discountedUnitPriceSet: { shopMoney: { amount: string } } | null;
              };
            }>;
          };
          fulfillments: Array<{ trackingInfo: Array<{ number: string | null; company: string | null }> }>;
        };
      }>;
    };
  };
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
                image {
                  url
                }
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

const ORDERS_QUERY = `
  query GetOrders($first: Int!, $query: String) {
    orders(first: $first, sortKey: CREATED_AT, reverse: true, query: $query) {
      edges {
        node {
          id
          name
          createdAt
          cancelledAt
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          customer { firstName lastName }
          lineItems(first: 20) {
            edges {
              node {
                title
                quantity
                sku
                variant { id barcode sku }
                image { url }
                discountedUnitPriceSet { shopMoney { amount } }
              }
            }
          }
          fulfillments(first: 1) { trackingInfo { number company } }
        }
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
            image: v.image?.url ?? null,
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

  // ── Admin API (siparişler) — Storefront token'dan AYRI, read_orders gerektirir ──
  private adminEndpoint() {
    return `https://${this.credentials.shopDomain}/admin/api/${this.credentials.apiVersion}/graphql.json`;
  }

  /** Client credentials grant → 24 saatlik Admin API erişim token'ı (önbellekli). */
  private async getAdminToken(): Promise<string> {
    const { clientId, clientSecret, shopDomain } = this.credentials;
    if (!clientId || !clientSecret) throw new ShopifyAdminTokenMissingError();

    const cacheKey = `${shopDomain}:${clientId}`;
    const cached = adminTokenCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

    const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    const text = await res.text();
    if (!res.ok) {
      if (/shop_not_permitted/i.test(text)) {
        throw new Error(
          "Shopify: uygulama ile mağaza farklı organizasyonda görünüyor (client credentials çalışmaz). Uygulamanın bu mağazaya kurulu olduğundan emin ol."
        );
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error("Shopify Client ID / Secret reddedildi (401/403). Bilgileri kontrol et.");
      }
      throw new Error(
        `Shopify erişim token'ı alınamadı: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`
      );
    }

    let json: { access_token?: string; expires_in?: number };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("Shopify token yanıtı çözümlenemedi.");
    }
    if (!json.access_token) {
      throw new Error("Shopify access_token dönmedi — Client ID / Secret doğru mu?");
    }
    adminTokenCache.set(cacheKey, {
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 86399) * 1000,
    });
    return json.access_token;
  }

  private async adminGraphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const token = await this.getAdminToken();

    const res = await fetch(this.adminEndpoint(), {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          "Shopify Admin token reddedildi (401/403). Token doğru mu ve uygulamanın 'read_orders' izni açık mı?"
        );
      }
      throw new Error(
        `Shopify Admin API hatası: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`
      );
    }

    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors && json.errors.length > 0) {
      const msg = json.errors.map((e) => e.message).join("; ");
      if (/access denied|read_orders|not approved|scope/i.test(msg)) {
        throw new Error(
          "Shopify Admin token'ında 'read_orders' izni yok. Uygulamada bu izni açıp token'ı yeniden üret."
        );
      }
      throw new Error(`Shopify GraphQL hatası: ${msg}`);
    }
    return json as unknown as T;
  }

  /** Son siparişler (Admin API, read_orders gerekir). sinceDays verilirse created_at ile filtreler. */
  async listOrders(opts: { limit?: number; sinceDays?: number } = {}): Promise<ShopifyOrder[]> {
    const limit = opts.limit ?? 100;
    const query =
      opts.sinceDays && opts.sinceDays > 0
        ? `created_at:>=${new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString()}`
        : null;
    const response = await this.adminGraphql<AdminOrdersResponse>(ORDERS_QUERY, {
      first: limit,
      query,
    });
    const edges = response.data?.orders?.edges ?? [];
    return edges.map(({ node }) => {
      const tracking = node.fulfillments?.[0]?.trackingInfo?.[0];
      const customerName = node.customer
        ? [node.customer.firstName, node.customer.lastName].filter(Boolean).join(" ") || null
        : null;
      return {
        id: node.id,
        name: node.name,
        createdAt: node.createdAt,
        cancelledAt: node.cancelledAt,
        financialStatus: node.displayFinancialStatus,
        fulfillmentStatus: node.displayFulfillmentStatus,
        totalAmount: Number(node.totalPriceSet?.shopMoney?.amount ?? 0),
        currency: node.totalPriceSet?.shopMoney?.currencyCode ?? "TRY",
        customerName,
        lines: node.lineItems.edges.map((e) => ({
          title: e.node.title,
          quantity: e.node.quantity,
          unitPrice: Number(e.node.discountedUnitPriceSet?.shopMoney?.amount ?? 0),
          barcode: e.node.variant?.barcode ?? null,
          sku: e.node.sku ?? null,
          variantId: e.node.variant?.id?.split("/").pop() ?? null,
          variantSku: e.node.variant?.sku ?? null,
          image: e.node.image?.url ?? null,
        })),
        trackingNumber: tracking?.number ?? null,
        cargoProvider: tracking?.company ?? null,
      };
    });
  }
}
