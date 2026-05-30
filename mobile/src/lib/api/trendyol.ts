import type { UnifiedOrder } from "@/lib/api/orders";

const SELLER = process.env.EXPO_PUBLIC_TRENDYOL_SELLER_ID;
const KEY = process.env.EXPO_PUBLIC_TRENDYOL_API_KEY;
const SECRET = process.env.EXPO_PUBLIC_TRENDYOL_API_SECRET;
const INTEGRATOR = process.env.EXPO_PUBLIC_TRENDYOL_INTEGRATOR || "SelfIntegration";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** ASCII string → base64 (RN'de Buffer yok; btoa varsa onu kullan). */
function base64(str: string): string {
  if (typeof globalThis.btoa === "function") return globalThis.btoa(str);
  let out = "";
  for (let i = 0; i < str.length; i += 3) {
    const a = str.charCodeAt(i);
    const b = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
    const c = i + 2 < str.length ? str.charCodeAt(i + 2) : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < str.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < str.length ? B64[c & 63] : "=";
  }
  return out;
}

interface TyOrder {
  orderNumber: string;
  orderDate: number;
  status: string;
  customerFirstName?: string;
  customerLastName?: string;
  totalPrice: number;
  lines?: { productName: string; quantity: number }[];
}

export async function getTrendyolOrders(size = 30): Promise<UnifiedOrder[]> {
  if (!SELLER || !KEY || !SECRET) return [];
  const token = base64(`${KEY}:${SECRET}`);
  const ua = `${SELLER} - ${INTEGRATOR.replace(/[^a-zA-Z0-9]/g, "").slice(0, 30) || "SelfIntegration"}`;
  const res = await fetch(
    `https://apigw.trendyol.com/integration/order/sellers/${SELLER}/orders?page=0&size=${size}&orderByField=PackageLastModifiedDate&orderByDirection=DESC`,
    { headers: { Authorization: `Basic ${token}`, Accept: "application/json", "User-Agent": ua } }
  );
  if (!res.ok) throw new Error(`Trendyol siparişler: HTTP ${res.status}`);
  const json = (await res.json()) as { content?: TyOrder[] };
  return (json.content ?? []).map((o) => ({
    id: `ty-${o.orderNumber}`,
    platform: "trendyol" as const,
    orderNumber: o.orderNumber,
    date: o.orderDate,
    status: o.status,
    customer: [o.customerFirstName, o.customerLastName].filter(Boolean).join(" ") || null,
    total: o.totalPrice,
    items: (o.lines ?? []).map((l) => ({ name: l.productName, quantity: l.quantity })),
  }));
}
