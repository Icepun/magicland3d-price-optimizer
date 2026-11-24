import { NextResponse } from "next/server";
import { sonGonderiler } from "@/lib/kargo/kargo-gonderileri";
import { kargoHataYaniti } from "@/lib/kargo/api-yanit";

export const dynamic = "force-dynamic";

/** Shopify siparişlerinin HepsiJet gönderileri: { gonderiler: { "sh-<no>": özet } }. Tek hafif sorgu. */
export async function GET() {
  try {
    return NextResponse.json({ gonderiler: await sonGonderiler("shopify") }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return kargoHataYaniti(error);
  }
}
