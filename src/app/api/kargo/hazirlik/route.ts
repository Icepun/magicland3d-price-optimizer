import { NextRequest, NextResponse } from "next/server";
import { kargoHazirligi } from "@/lib/kargo/hepsijet-gonder";
import { kargoHataYaniti } from "@/lib/kargo/api-yanit";

export const dynamic = "force-dynamic";

/** "Kargo oluştur" ekranının verisi: müşterinin yazdığı + HepsiJet alanları için öneri. */
export async function GET(req: NextRequest) {
  const siparisId = req.nextUrl.searchParams.get("siparisId")?.trim();
  if (!siparisId) return NextResponse.json({ error: "Sipariş seçilmedi." }, { status: 400 });
  try {
    return NextResponse.json(await kargoHazirligi(siparisId));
  } catch (error) {
    return kargoHataYaniti(error);
  }
}
