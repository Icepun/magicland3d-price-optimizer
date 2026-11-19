/**
 * SHOPIFY KARGO ADIMLARI — Berke'nin panelde elle yaptığının aynısı.
 *
 * Canlı kayıtlardan (19 Kas 2026): elle açılan gönderimlerde kargo şirketi "Other", takip bağlantısı
 * `https://hepsijet.com/gonderi-takibi/<barkod>`, teslim işareti `DELIVERED` gönderim olayı.
 * Şema (sunucu 2026-01): fulfillmentCreate(fulfillment: FulfillmentInput!),
 * fulfillmentEventCreate(fulfillmentEvent: FulfillmentEventInput!).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShopifyClient, hepsijetTakipUrl } from "./shopify-client";

// Her testte ayrı mağaza adı: süreç içi token önbelleği testler arasında taşınmasın.
let sira = 0;
const istemci = () =>
  new ShopifyClient({
    shopDomain: `kargo-test-${++sira}.myshopify.com`, apiVersion: "2026-01",
    storefrontAccessToken: "sf", clientId: "cid", clientSecret: "sec",
  });

let istekler: { query: string; variables: Record<string, unknown> }[];
let yanit: unknown;

beforeEach(() => {
  istekler = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/admin/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "tkn", scope: "write_orders,write_fulfillments", expires_in: 86399 }), { status: 200 });
    }
    istekler.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(yanit), { status: 200 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("kargo bilgisi (okuma)", () => {
  it("adres ham hâliyle; yalnız gönderim AÇILABİLEN emirler; iptal gönderim sayılmaz", async () => {
    yanit = {
      data: {
        order: {
          id: "gid://shopify/Order/1", name: "#1213", cancelledAt: null,
          shippingAddress: {
            firstName: "Deneme", lastName: "Müşteri", address1: "Örnek Mah.", address2: "Lale Sok. No:1",
            city: "Çankaya", province: "Ankara", zip: "06000", phone: "5321234567",
          },
          fulfillmentOrders: {
            nodes: [
              { id: "gid://shopify/FulfillmentOrder/10", supportedActions: [{ action: "CREATE_FULFILLMENT" }, { action: "HOLD" }] },
              { id: "gid://shopify/FulfillmentOrder/11", supportedActions: [] },
            ],
          },
          fulfillments: [
            { id: "gid://shopify/Fulfillment/5", status: "CANCELLED", displayStatus: "CANCELED", trackingInfo: [{ number: "ESKI" }] },
            { id: "gid://shopify/Fulfillment/6", status: "SUCCESS", displayStatus: "DELIVERED", trackingInfo: [{ number: "ORN1" }] },
          ],
        },
      },
    };
    const b = await istemci().kargoBilgisi("gid://shopify/Order/1");
    expect(istekler[0].variables).toEqual({ id: "gid://shopify/Order/1" });
    expect(b).toMatchObject({
      ad: "#1213", iptal: false,
      adres: { ad: "Deneme", soyad: "Müşteri", city: "Çankaya", province: "Ankara", phone: "5321234567" },
      acikGonderimEmirleri: ["gid://shopify/FulfillmentOrder/10"],
      gonderimler: [{ id: "gid://shopify/Fulfillment/6", takipNo: "ORN1", teslimEdildi: true }],
    });
  });

  it("sipariş yoksa null", async () => {
    yanit = { data: { order: null } };
    expect(await istemci().kargoBilgisi("gid://shopify/Order/404")).toBeNull();
  });
});

describe("gönderildi olarak işaretle", () => {
  it('takip no + HepsiJet bağlantısı, kargo şirketi "Other", müşteriye bildir', async () => {
    yanit = { data: { fulfillmentCreate: { fulfillment: { id: "gid://shopify/Fulfillment/77" }, userErrors: [] } } };
    const id = await istemci().gonderimAc({
      gonderimEmirleri: ["gid://shopify/FulfillmentOrder/10"], takipNo: "ORN179507520007",
      takipUrl: hepsijetTakipUrl("ORN179507520007"), musteriyeBildir: true,
    });
    expect(id).toBe("gid://shopify/Fulfillment/77");
    expect(istekler[0].query).toContain("fulfillmentCreate(fulfillment: $fulfillment)");
    expect(istekler[0].variables).toEqual({
      fulfillment: {
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "gid://shopify/FulfillmentOrder/10" }],
        notifyCustomer: true,
        trackingInfo: { number: "ORN179507520007", url: "https://hepsijet.com/gonderi-takibi/ORN179507520007", company: "Other" },
      },
    });
  });

  it("Shopify reddederse başarı denmez; gönderilecek emir yoksa istek hiç gitmez", async () => {
    yanit = { data: { fulfillmentCreate: { fulfillment: null, userErrors: [{ message: "Fulfillment order is closed" }] } } };
    await expect(
      istemci().gonderimAc({ gonderimEmirleri: ["x"], takipNo: "ORN1", takipUrl: "https://e", musteriyeBildir: true }),
    ).rejects.toThrow(/gönderimi açmadı: Fulfillment order is closed/);
    const once = istekler.length;
    await expect(
      istemci().gonderimAc({ gonderimEmirleri: [], takipNo: "ORN1", takipUrl: "https://e", musteriyeBildir: true }),
    ).rejects.toThrow(/gönderilecek ürün kalmamış/);
    expect(istekler).toHaveLength(once);
  });
});

describe("teslim edildi olarak işaretle", () => {
  it("DELIVERED olayı, verilen zamanla", async () => {
    yanit = { data: { fulfillmentEventCreate: { fulfillmentEvent: { id: "gid://shopify/FulfillmentEvent/1", status: "DELIVERED" }, userErrors: [] } } };
    await istemci().teslimEdildiIsaretle("gid://shopify/Fulfillment/77", new Date("2026-11-20T12:30:00Z"));
    expect(istekler[0].variables).toEqual({
      olay: { fulfillmentId: "gid://shopify/Fulfillment/77", status: "DELIVERED", happenedAt: "2026-11-20T12:30:00.000Z" },
    });
  });

  it("kaydedilmediyse hata", async () => {
    yanit = { data: { fulfillmentEventCreate: { fulfillmentEvent: null, userErrors: [{ message: "Fulfillment not found" }] } } };
    await expect(istemci().teslimEdildiIsaretle("gid://shopify/Fulfillment/0")).rejects.toThrow(/teslim işaretini kaydetmedi/);
  });
});
