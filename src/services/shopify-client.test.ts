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

/** Satır kalemi: `quantity` sipariş anındaki adet, `currentQuantity` iade sonrası kalan adet. */
function lineNode(quantity: number, currentQuantity?: number) {
  return {
    node: {
      title: "Samuray GPU Tutucu",
      quantity,
      ...(currentQuantity === undefined ? {} : { currentQuantity }),
      sku: "SKU-1",
      variant: { id: "gid://shopify/ProductVariant/9", barcode: "BC-1", sku: "VSKU-1" },
      image: null,
      discountedUnitPriceSet: { shopMoney: { amount: "199.99" } },
    },
  };
}

function orderWithLines(lines: ReturnType<typeof lineNode>[]) {
  return {
    id: "gid://shopify/Order/10",
    name: "#10",
    createdAt: "2026-07-20T10:00:00.000Z",
    cancelledAt: null,
    displayFinancialStatus: "PARTIALLY_REFUNDED",
    displayFulfillmentStatus: "FULFILLED",
    currentTotalPriceSet: { shopMoney: { amount: "399.98", currencyCode: "TRY" } },
    customer: null,
    lineItems: { edges: lines, pageInfo: { hasNextPage: false } },
    fulfillments: [],
  };
}

function clientWithResponse(node: unknown, apiVersion = "2026-07") {
  const client = new ShopifyClient(credentials({ apiVersion }));
  const adminGraphql = vi.fn().mockResolvedValue({
    data: {
      orders: { edges: [{ node }], pageInfo: { hasNextPage: false, endCursor: null } },
    },
  });
  Object.defineProperty(client, "adminGraphql", { value: adminGraphql });
  return { client, adminGraphql };
}

describe("ShopifyClient sipariş satırı adedi (iade sonrası)", () => {
  it("kısmi iadede satır adedi KALAN adet olur (3 adetten 1'i iade)", async () => {
    const { client } = clientWithResponse(orderWithLines([lineNode(3, 2)]));

    const [order] = await client.listOrders();

    expect(order.lines[0]).toMatchObject({
      quantity: 2,
      orderedQuantity: 3,
      refundedQuantity: 1,
    });
  });

  it("satırın tamamı iade edildiyse kalan adet 0 olur", async () => {
    const { client } = clientWithResponse(orderWithLines([lineNode(3, 0)]));

    const [order] = await client.listOrders();

    expect(order.lines[0]).toMatchObject({
      quantity: 0,
      orderedQuantity: 3,
      refundedQuantity: 3,
    });
  });

  it("iadesiz siparişte adet değişmez", async () => {
    const { client } = clientWithResponse(orderWithLines([lineNode(3, 3)]));

    const [order] = await client.listOrders();

    expect(order.lines[0]).toMatchObject({
      quantity: 3,
      orderedQuantity: 3,
      refundedQuantity: 0,
    });
  });

  it("güncel sürümde kalan adet alanı sorulur", async () => {
    const { client, adminGraphql } = clientWithResponse(orderWithLines([lineNode(1, 1)]));

    await client.listOrders();

    expect(adminGraphql.mock.calls[0]?.[0]).toContain("currentQuantity");
  });

  it("2022-04 öncesi sürümde alan sorulmaz ve adet sipariş anındaki adet kalır", async () => {
    const { client, adminGraphql } = clientWithResponse(
      orderWithLines([lineNode(3)]),
      "2021-10"
    );

    const [order] = await client.listOrders();

    expect(adminGraphql.mock.calls[0]?.[0]).not.toContain("currentQuantity");
    expect(order.lines[0]).toMatchObject({
      quantity: 3,
      orderedQuantity: 3,
      refundedQuantity: 0,
    });
  });
});
