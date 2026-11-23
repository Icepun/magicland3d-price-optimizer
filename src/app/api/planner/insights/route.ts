import { NextResponse } from "next/server";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { deriveSalesInsights } from "@/lib/planner-insights";
import { satisHiziSatirlari } from "@/lib/satis-hizi-veri";

/**
 * Üretim Planı satış hızı ucu. Okuma `@/lib/satis-hizi-veri` (kuyruk ve ürün detayıyla ortak,
 * manuel siparişler dahil, önbellekli), hesap `@/lib/planner-insights`. Bu dosya YALNIZ istek
 * işleyicisi barındırır (Next 16 rota dosyaları başka bir değer dışa açamaz).
 */
export async function GET() {
  try {
    await ensureRuntimeSchema();
    const now = Date.now();
    const { satirlar, kapsamBaslangicMs } = await satisHiziSatirlari(now);
    return NextResponse.json(deriveSalesInsights(satirlar, kapsamBaslangicMs, now));
  } catch (error) {
    return jsonError(error);
  }
}
