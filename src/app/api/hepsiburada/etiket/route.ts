import { NextRequest, NextResponse } from "next/server";
import { EtiketBasilamadi, hbEtiketiBas } from "@/lib/etiket/bas";
import { takipNoTemizle } from "@/lib/etiket/kayit";
import { basildiBulutaYaz } from "@/lib/etiket/telefon-istekleri";

export const dynamic = "force-dynamic";

/**
 * Bir Hepsiburada paketinin kargo etiketini 100×100'e sığdırıp etiket yazıcısına basar.
 * Gövde: { paketNo, takipNo?, siparisNo? } — takipNo (teslimat no) "basıldı" işaretinin anahtarı.
 * Paketin durumunu DEĞİŞTİRMEZ.
 */
export async function POST(req: NextRequest) {
  const govde = (await req.json().catch(() => null)) as
    | { paketNo?: unknown; takipNo?: unknown; siparisNo?: unknown }
    | null;
  const paketNo = takipNoTemizle(govde?.paketNo);
  if (!paketNo) {
    return NextResponse.json({ error: "Sipariş henüz paketlenmemiş." }, { status: 400 });
  }
  const takipNo = takipNoTemizle(govde?.takipNo);

  try {
    const b = await hbEtiketiBas(paketNo, takipNo);
    void basildiBulutaYaz({
      platform: "hepsiburada",
      orderNumber: typeof govde?.siparisNo === "string" ? govde.siparisNo : null,
      labelKey: b.anahtar,
      trackingNumber: takipNo,
      packageNumber: paketNo,
    });
    return NextResponse.json({ ok: true, takipNo: b.anahtar, basildi: b.basildi, etiketSayisi: b.etiketSayisi });
  } catch (error) {
    if (error instanceof EtiketBasilamadi && error.yaziciGerekli) {
      return NextResponse.json({ error: error.message, yaziciGerekli: true }, { status: 409 });
    }
    const mesaj = error instanceof EtiketBasilamadi ? error.message : "Etiket basılamadı. Tekrar dene.";
    return NextResponse.json({ error: mesaj }, { status: 502 });
  }
}
