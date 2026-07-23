import { afterEach, describe, expect, it, vi } from "vitest";
import { ShopifyClient } from "./shopify-client";
import type { ShopifyCredentials } from "./shopify-settings";

const EMPTY_ORDERS_RESPONSE = {
  data: {
    orders: {
      edges: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  },
};

function credentials(overrides: Partial<ShopifyCredentials> = {}): ShopifyCredentials {
  return {
    shopDomain: "test-store.myshopify.com",
    apiVersion: "2026-07",
    storefrontAccessToken: "storefront-token",
    clientId: "client-id",
    clientSecret: "client-secret",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ShopifyClient Admin API token yenileme", () => {
  it("cache'teki token 401 alınca yeni token üretip sipariş isteğini bir kez tekrarlar", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "old-token",
          scope: "read_orders",
          expires_in: 86399,
        })
      )
      .mockResolvedValueOnce(jsonResponse(EMPTY_ORDERS_RESPONSE))
      .mockResolvedValueOnce(
        jsonResponse({ errors: "Invalid API key or access token" }, 401)
      )
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "fresh-token",
          scope: "read_orders",
          expires_in: 86399,
        })
      )
      .mockResolvedValueOnce(jsonResponse(EMPTY_ORDERS_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ShopifyClient(credentials({ clientId: "retry-client" }));
    await expect(client.listOrders()).resolves.toEqual([]);
    await expect(client.listOrders()).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const retryHeaders = new Headers(fetchMock.mock.calls[4][1]?.headers);
    expect(retryHeaders.get("X-Shopify-Access-Token")).toBe("fresh-token");
  });

  it("Client Secret değiştiğinde eski cache girdisini kullanmaz", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "first-token",
          scope: "read_orders",
          expires_in: 86399,
        })
      )
      .mockResolvedValueOnce(jsonResponse(EMPTY_ORDERS_RESPONSE))
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "second-token",
          scope: "read_orders",
          expires_in: 86399,
        })
      )
      .mockResolvedValueOnce(jsonResponse(EMPTY_ORDERS_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);

    await new ShopifyClient(
      credentials({ clientId: "rotated-secret-client", clientSecret: "old-secret" })
    ).listOrders();
    await new ShopifyClient(
      credentials({ clientId: "rotated-secret-client", clientSecret: "new-secret" })
    ).listOrders();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const secondTokenRequestBody = fetchMock.mock.calls[2][1]?.body;
    expect(secondTokenRequestBody).toBeInstanceOf(URLSearchParams);
    expect((secondTokenRequestBody as URLSearchParams).get("client_secret")).toBe(
      "new-secret"
    );
  });

  it("üretilen token'da sipariş kapsamı yoksa açıklayıcı hata verir", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        access_token: "products-only-token",
        scope: "read_products",
        expires_in: 86399,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ShopifyClient(credentials({ clientId: "missing-scope-client" }));

    await expect(client.listOrders()).rejects.toThrow(
      /read_orders.*yayınla.*yeniden kur/i
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function orderNode(id: string, amount: string, linesTruncated = false) {
  return {
    id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    createdAt: "2026-07-20T10:00:00.000Z",
    cancelledAt: null,
    displayFinancialStatus: "PARTIALLY_REFUNDED",
    displayFulfillmentStatus: "FULFILLED",
    currentTotalPriceSet: { shopMoney: { amount, currencyCode: "TRY" } },
    customer: null,
    lineItems: {
      edges: [],
      pageInfo: { hasNextPage: linesTruncated },
    },
    fulfillments: [],
  };
}

describe("ShopifyClient orders", () => {
  it("cursor sayfalarını tüketip iade sonrası güncel toplamı ve satır sınırını taşır", async () => {
    const client = new ShopifyClient({
      shopDomain: "example.myshopify.com",
      apiVersion: "2026-07",
      storefrontAccessToken: "test",
      clientId: "client",
      clientSecret: "secret",
    });
    const adminGraphql = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          orders: {
            edges: [{ node: orderNode("1", "80.00", true) }],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          orders: {
            edges: [{ node: orderNode("2", "120.00") }],
            pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
          },
        },
      });
    Object.defineProperty(client, "adminGraphql", { value: adminGraphql });

    const orders = await client.listOrders({ limit: 100, sinceDays: 30 });

    expect(adminGraphql).toHaveBeenCalledTimes(2);
    expect(adminGraphql.mock.calls[1]?.[1]).toMatchObject({ cursor: "cursor-1" });
    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({
      totalAmount: 80,
      currency: "TRY",
      linesTruncated: true,
      financialStatus: "PARTIALLY_REFUNDED",
    });
  });
});
