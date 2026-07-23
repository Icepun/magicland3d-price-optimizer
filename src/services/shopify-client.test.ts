import { afterEach, describe, expect, it, vi } from "vitest";
import { ShopifyClient } from "./shopify-client";
import type { ShopifyCredentials } from "./shopify-settings";

const EMPTY_ORDERS_RESPONSE = {
  data: {
    orders: {
      edges: [],
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
      // İlk çağrı: token üret ve cache'le.
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "old-token",
          scope: "read_orders",
          expires_in: 86399,
        })
      )
      // İlk sipariş sorgusu başarılı.
      .mockResolvedValueOnce(jsonResponse(EMPTY_ORDERS_RESPONSE))
      // İkinci sipariş sorgusunda cache'teki token artık geçersiz.
      .mockResolvedValueOnce(jsonResponse({ errors: "Invalid API key or access token" }, 401))
      // Otomatik olarak yeni token üret.
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "fresh-token",
          scope: "read_orders",
          expires_in: 86399,
        })
      )
      // Aynı sipariş sorgusunu yeni token'la tekrar et.
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
    expect((secondTokenRequestBody as URLSearchParams).get("client_secret")).toBe("new-secret");
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

    await expect(client.listOrders()).rejects.toThrow(/read_orders.*yayınla.*yeniden kur/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
