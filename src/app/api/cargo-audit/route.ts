import { NextResponse } from "next/server";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { swr } from "@/lib/route-cache";
import { kargoDenetimiHesapla } from "@/lib/kargo-denetim";

/**
 * Kargo denetimi — fazla desi kesilen siparişler ve Trendyol gecikme bedelleri (son 90 gün).
 * Kalıcı kayıtlardan hesaplanır; kısa ömürlü önbellek (kayıtlar 3 saatte bir tazeleniyor).
 */
export async function GET() {
  try {
    await ensureRuntimeSchema();
    return NextResponse.json(await swr("kargo-denetim:v1", 2 * 60_000, () => kargoDenetimiHesapla(90)));
  } catch (error) {
    return jsonError(error);
  }
}
