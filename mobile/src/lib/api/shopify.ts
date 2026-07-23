import type { UnifiedOrder } from "@/lib/api/orders";
import { fetchT } from "@/lib/api/http";

const SHOP = process.env.EXPO_PUBLIC_SHOPIFY_SHOP_DOMAIN;
const VER = process.env.EXPO_PUBLIC_SHOPIFY_API_VERSION || "2024-10";
const CID = process.env.EXPO_PUBLIC_SHOPIFY_CLIENT_ID;
const CSECRET = process.env.EXPO_PUBLIC_SHOPIFY_CLIENT_SECRET;

let cached: { token: string; exp: number } | null = null;

/** client_credentials OAuth → admin token (read_orders'lı). 24sa cache. */
async function getAdminToken(): Promise<string> {
  if (cached && cached.exp > Date.now()) return cached.token;
  const res = await fetchT(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CID ?? "",
      client_secret: CSECRET ?? "",
    }).toString(),
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("Shopify admin token alınamadı (clientId/secret?)");
  cached = { token: json.access_token, exp: Date.now() + (json.expires_in ?? 86000) * 1000 };
  return json.access_token;
}

const ORDERS_QUERY = `query($first:Int!,$after:String,$query:String){
  orders(first:$first, after:$after, sortKey:CREATED_AT, reverse:true, query:$query){
    pageInfo{ hasNextPage endCursor }
    edges{ node{
      id name createdAt displayFulfillmentStatus displayFinancialStatus cancelledAt
      currentTotalPriceSet{ shopMoney{ amount currencyCode } }
      customer{ firstName lastName }
      lineItems(first:20){
        pageInfo{ hasNextPage }
        edges{ node{
        title quantity sku
        variant{ id barcode sku }
        discountedUnitPriceSet{ shopMoney{ amount } }
      } } }
    } }
  }
}`;

interface ShEdge {
  node: {
    id: string;
    name: string;
    createdAt: string;
    displayFulfillmentStatus: string;
    displayFinancialStatus?: string;
    cancelledAt?: string | null;
    currentTotalPriceSet?: {
      shopMoney?: { amount?: string; currencyCode?: string };
    };
    customer?: { firstName?: string; lastName?: string };
    lineItems: {
      pageInfo?: { hasNextPage?: boolean };
      edges: {
        node: {
          title: string;
          quantity: number;
          sku?: string | null;
          variant?: { id?: string | null; barcode?: string | null; sku?: string | null };
          discountedUnitPriceSet?: { shopMoney?: { amount?: string } };
        };
      }[];
    };
  };
}

/**
 * Masaüstü shopifyStatus önceliğiyle BİREBİR: iptal > iade(financial) > fulfillment durumu.
 * Böylece iptal/iade Shopify siparişleri (orders.ts isCancelledOrder ile) ciro/kâr özetinden elenir.
 */
function shopifyStatusKey(node: ShEdge["node"]): string {
  if (node.cancelledAt) return "CANCELLED";
  const fin = node.displayFinancialStatus;
  if (fin === "REFUNDED") return "REFUNDED";
  return node.displayFulfillmentStatus;
}

export async function getShopifyOrders(
  limit = 100,
  historyDays = 30
): Promise<UnifiedOrder[]> {
  if (!SHOP || !CID || !CSECRET) return [];
  const token = await getAdminToken();
  // Rapor görünümü 30 gün, kalıcı finans geçmişi ilk dolumda 60 gün ister.
  // UTC gün başına sabitleme masaüstü orders route ile birebirdir.
  const safeDays = Math.max(1, Math.min(60, Math.trunc(historyDays)));
  const cutoff = (Math.floor(Date.now() / 86_400_000) - safeDays) * 86_400_000;
  const sinceQuery = `created_at:>=${new Date(cutoff).toISOString()}`;
  const allEdges: ShEdge[] = [];
  let after: string | null = null;
  let hasNextPage = true;
  // Shopify Admin GraphQL en fazla 250 kayıt/sayfa kabul eder. Güvenlik sınırı,
  // bozuk bir cursor yanıtında mobilin sonsuz döngüye girmesini önler.
  const pageSize = Math.max(1, Math.min(250, limit));
  for (let page = 0; page < 20 && hasNextPage; page++) {
    const res = await fetchT(`https://${SHOP}/admin/api/${VER}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: ORDERS_QUERY,
        variables: { first: pageSize, after, query: sinceQuery },
      }),
    });
    const json = (await res.json()) as {
      data?: {
        orders?: {
          edges: ShEdge[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        };
      };
      errors?: { message: string }[];
    };
    if (json.errors?.length) throw new Error(json.errors[0].message);
    const connection = json.data?.orders;
    allEdges.push(...(connection?.edges ?? []));
    hasNextPage = !!connection?.pageInfo?.hasNextPage;
    const nextCursor = connection?.pageInfo?.endCursor ?? null;
    if (hasNextPage && (!nextCursor || nextCursor === after)) {
      throw new Error("Shopify sipariş sayfalaması ilerlemedi.");
    }
    after = nextCursor;
  }
  if (hasNextPage) {
    throw new Error("Shopify sipariş sayfalaması güvenlik sınırına ulaştı.");
  }

  return allEdges.map(({ node }) => ({
    id: `sh-${node.id.split("/").pop() ?? node.name}`,
    platform: "shopify" as const,
    orderNumber: node.name,
    date: new Date(node.createdAt).getTime(),
    status: shopifyStatusKey(node),
    customer:
      [node.customer?.firstName, node.customer?.lastName].filter(Boolean).join(" ") || null,
    total: Number(node.currentTotalPriceSet?.shopMoney?.amount ?? 0),
    currency: node.currentTotalPriceSet?.shopMoney?.currencyCode ?? "TRY",
    financialPartial:
      node.displayFinancialStatus === "PARTIALLY_REFUNDED" ||
      !!node.lineItems.pageInfo?.hasNextPage,
    items: node.lineItems.edges.map((e) => {
      const variantId = e.node.variant?.id?.split("/").pop() ?? null;
      const keys = [
        e.node.variant?.barcode,
        e.node.variant?.sku,
        e.node.sku,
        variantId ? `shopify-variant-${variantId}` : null,
        variantId,
      ].filter((k): k is string => !!k);
      return {
        name: e.node.title,
        quantity: e.node.quantity,
        unitPrice: Number(e.node.discountedUnitPriceSet?.shopMoney?.amount ?? 0),
        matchKeys: keys,
      };
    }),
  }));
}
