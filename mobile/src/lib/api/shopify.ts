import type { UnifiedOrder } from "@/lib/api/orders";

const SHOP = process.env.EXPO_PUBLIC_SHOPIFY_SHOP_DOMAIN;
const VER = process.env.EXPO_PUBLIC_SHOPIFY_API_VERSION || "2024-10";
const CID = process.env.EXPO_PUBLIC_SHOPIFY_CLIENT_ID;
const CSECRET = process.env.EXPO_PUBLIC_SHOPIFY_CLIENT_SECRET;

let cached: { token: string; exp: number } | null = null;

/** client_credentials OAuth → admin token (read_orders'lı). 24sa cache. */
async function getAdminToken(): Promise<string> {
  if (cached && cached.exp > Date.now()) return cached.token;
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
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

const ORDERS_QUERY = `query($first:Int!){
  orders(first:$first, sortKey:CREATED_AT, reverse:true){
    edges{ node{
      id name createdAt displayFulfillmentStatus
      totalPriceSet{ shopMoney{ amount } }
      customer{ firstName lastName }
      lineItems(first:10){ edges{ node{ title quantity } } }
    } }
  }
}`;

interface ShEdge {
  node: {
    id: string;
    name: string;
    createdAt: string;
    displayFulfillmentStatus: string;
    totalPriceSet?: { shopMoney?: { amount?: string } };
    customer?: { firstName?: string; lastName?: string };
    lineItems: { edges: { node: { title: string; quantity: number } }[] };
  };
}

export async function getShopifyOrders(limit = 30): Promise<UnifiedOrder[]> {
  if (!SHOP || !CID || !CSECRET) return [];
  const token = await getAdminToken();
  const res = await fetch(`https://${SHOP}/admin/api/${VER}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query: ORDERS_QUERY, variables: { first: limit } }),
  });
  const json = (await res.json()) as {
    data?: { orders?: { edges: ShEdge[] } };
    errors?: { message: string }[];
  };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return (json.data?.orders?.edges ?? []).map(({ node }) => ({
    id: `sh-${node.id}`,
    platform: "shopify" as const,
    orderNumber: node.name,
    date: new Date(node.createdAt).getTime(),
    status: node.displayFulfillmentStatus,
    customer:
      [node.customer?.firstName, node.customer?.lastName].filter(Boolean).join(" ") || null,
    total: Number(node.totalPriceSet?.shopMoney?.amount ?? 0),
    items: node.lineItems.edges.map((e) => ({ name: e.node.title, quantity: e.node.quantity })),
  }));
}
