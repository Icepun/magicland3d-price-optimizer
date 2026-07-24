import { NextRequest, NextResponse } from "next/server";
import { invalidateOrdersCache } from "@/lib/orders-cache";
import { bustCache } from "@/lib/route-cache";
import { syncTrendyolActualCosts } from "@/lib/trendyol-finance";

let activeSync: Promise<Awaited<
  ReturnType<typeof syncTrendyolActualCosts>
>> | null = null;

export async function POST(req: NextRequest) {
  try {
    const requested = Number(req.nextUrl.searchParams.get("days") ?? 60);
    const days = Number.isFinite(requested)
      ? Math.max(1, Math.min(180, Math.trunc(requested)))
      : 60;

    if (!activeSync) {
      activeSync = syncTrendyolActualCosts(days).finally(() => {
        activeSync = null;
      });
    }
    const result = await activeSync;
    invalidateOrdersCache();
    bustCache("finance-monthly:");

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Trendyol maliyetleri alınamadı.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
