import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  clearShopifyAccessToken,
  getPublicShopifySettings,
  saveShopifySettings,
} from "@/services/shopify-settings";
import { jsonError } from "@/lib/api-error";

export async function GET() {
  try {
    return NextResponse.json(await getPublicShopifySettings());
  } catch (error) {
    return jsonError(error);
  }
}

const SaveSchema = z.object({
  shopDomain: z.string().min(1, "Shopify alan adı gerekli"),
  apiVersion: z.string().optional(),
  storefrontAccessToken: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const body = SaveSchema.parse(await req.json());
    await saveShopifySettings(body);
    return NextResponse.json(await getPublicShopifySettings());
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE() {
  try {
    await clearShopifyAccessToken();
    return NextResponse.json(await getPublicShopifySettings());
  } catch (error) {
    return jsonError(error);
  }
}
