import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getPublicTrendyolSettings,
  saveTrendyolSettings,
} from "@/services/trendyol-settings";
import { jsonError } from "@/lib/api-error";

const Schema = z.object({
  sellerId: z.string().min(1),
  integrationReferenceCode: z.string().optional(),
  apiKey: z.string().optional(),
  apiSecret: z.string().optional(),
  environment: z.enum(["prod", "stage"]).default("prod"),
  integratorName: z.string().min(1).max(30).default("SelfIntegration"),
});

const emptySettings = {
  sellerId: "",
  hasIntegrationReferenceCode: false,
  integrationReferenceCodeMasked: "",
  environment: "prod",
  integratorName: "SelfIntegration",
  hasApiKey: false,
  hasApiSecret: false,
  apiKeyMasked: "",
  apiSecretMasked: "",
};

export async function GET() {
  try {
    return NextResponse.json(await getPublicTrendyolSettings());
  } catch (error) {
    console.error("Could not load Trendyol settings", error);
    return NextResponse.json(emptySettings);
  }
}

export async function POST(req: NextRequest) {
  try {
    const data = Schema.parse(await req.json());
    await saveTrendyolSettings(data);
    return NextResponse.json(await getPublicTrendyolSettings());
  } catch (error) {
    return jsonError(error);
  }
}
