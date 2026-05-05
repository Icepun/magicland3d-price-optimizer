import { NextResponse } from "next/server";
import { TrendyolClient } from "@/services/trendyol-client";
import { getTrendyolCredentials } from "@/services/trendyol-settings";
import { jsonError } from "@/lib/api-error";

export async function GET(_req: Request, ctx: RouteContext<"/api/trendyol/batch/[id]">) {
  try {
    const { id } = await ctx.params;
    const client = new TrendyolClient(await getTrendyolCredentials());
    const result = await client.getBatchRequestResult(id);
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}
