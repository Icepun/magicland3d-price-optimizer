import { NextResponse } from "next/server";
import { TrendyolClient } from "@/services/trendyol-client";
import { getTrendyolCredentials } from "@/services/trendyol-settings";
import { jsonError } from "@/lib/api-error";

export async function POST() {
  try {
    const credentials = await getTrendyolCredentials();
    const client = new TrendyolClient(credentials);
    const result = await client.listProducts({ page: 0, size: 1, approved: true });

    return NextResponse.json({
      ok: true,
      totalElements: result.totalElements ?? 0,
      totalPages: result.totalPages ?? 0,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return jsonError(error);
  }
}
