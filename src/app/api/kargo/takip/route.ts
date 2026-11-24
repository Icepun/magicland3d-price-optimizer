import { NextRequest, NextResponse } from "next/server";
import { takipNoTemizle } from "@/lib/etiket/kayit";
import { barkodlaGonderi, gonderiOzeti } from "@/lib/kargo/kargo-gonderileri";
import { kargoTakibiTuru } from "@/lib/kargo/kargo-takip";
import { kargoHataYaniti } from "@/lib/kargo/api-yanit";

export const dynamic = "force-dynamic";

/** "Durumu yenile": takip turunu hemen çalıştırır; gövdede barkod varsa o gönderinin son hâlini döner. */
export async function POST(req: NextRequest) {
  const govde = (await req.json().catch(() => null)) as { barkod?: unknown } | null;
  try {
    const tur = await kargoTakibiTuru();
    const barkod = takipNoTemizle(govde?.barkod);
    const satir = barkod ? await barkodlaGonderi(barkod) : null;
    return NextResponse.json({ tur, gonderi: satir ? gonderiOzeti(satir) : null });
  } catch (error) {
    return kargoHataYaniti(error);
  }
}
