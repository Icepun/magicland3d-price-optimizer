import { NextResponse } from "next/server";
import { ShopifyClient } from "@/services/shopify-client";
import { getShopifyCredentials } from "@/services/shopify-settings";
import { jsonError } from "@/lib/api-error";

export async function POST() {
  try {
    const credentials = await getShopifyCredentials();
    const client = new ShopifyClient(credentials);
    const info = await client.testConnection();
    return NextResponse.json({ ok: true, ...info });
  } catch (error) {
    return jsonError(error);
  }
}
