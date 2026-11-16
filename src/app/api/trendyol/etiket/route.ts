import { NextRequest, NextResponse } from "next/server";
import { EtiketBasilamadi, trendyolEtiketiBas } from "@/lib/etiket/bas";
import { takipNoTemizle } from "@/lib/etiket/kayit";
import { basildiBulutaYaz } from "@/lib/etiket/telefon-istekleri";

export const dynamic = "force-dynamic";

/**
 * Bir Trendyol siparişinin kargo etiketini alıp etiket yazıcısına basar.
 * Gövde: { takipNo, siparisNo? }. Pakete durum YAZMAZ.
 */
export async function POST(req: NextRequest) {
  const govde = (await req.json().catch(() => null)) as { takipNo?: unknown; siparisNo?: unknown } | null;
  const takipNo = takipNoTemizle(govde?.takipNo);
  if (!takipNo) {
    return NextResponse.json({ error: "Bu siparişin takip numarası yok." }, { status: 400 });
  }

  try {
    const b = await trendyolEtiketiBas(takipNo);
    void basildiBulutaYaz({
      platform: "trendyol",
      orderNumber: typeof govde?.siparisNo === "string" ? govde.siparisNo : null,
      labelKey: b.anahtar,
      trackingNumber: takipNo,
      packageNumber: null,
    });
    return NextResponse.json({ ok: true, takipNo, basildi: b.basildi, etiketSayisi: b.etiketSayisi });
  } catch (error) {
    if (error instanceof EtiketBasilamadi && error.yaziciGerekli) {
      return NextResponse.json({ error: error.message, yaziciGerekli: true }, { status: 409 });
    }
    const mesaj = error instanceof EtiketBasilamadi ? error.message : "Etiket basılamadı. Tekrar dene.";
    return NextResponse.json({ error: mesaj }, { status: 502 });
  }
}
