import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/lib/api-error";
import { swr } from "@/lib/route-cache";
import { computeQueue, parseTarget } from "@/lib/print-queue";

export const dynamic = "force-dynamic";

/**
 * Baskı kuyruğu ucu. Türetmenin tamamı @/lib/print-queue içinde — bu dosya YALNIZ istek
 * işleyicisi barındırır (Next 16 rota dosyaları başka bir değer dışa açamaz).
 */
export async function GET(req: NextRequest) {
  try {
    const target = parseTarget(new URL(req.url).searchParams.get("target"));
    // Kısa ömürlü önbellek: ekran açık kalırken tekrar tekrar aynı sorguları yaptırmasın.
    const data = await swr(`planner-queue:v1:${target ?? "auto"}`, 20_000, () =>
      computeQueue(target)
    );
    return NextResponse.json(data);
  } catch (error) {
    return jsonError(error);
  }
}
