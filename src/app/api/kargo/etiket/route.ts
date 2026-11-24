import { NextRequest, NextResponse } from "next/server";
import { EtiketBasilamadi, hepsijetEtiketiBas } from "@/lib/etiket/bas";
import { takipNoTemizle } from "@/lib/etiket/kayit";
import { basildiBulutaYaz } from "@/lib/etiket/telefon-istekleri";
import { barkodlaGonderi } from "@/lib/kargo/kargo-gonderileri";

export const dynamic = "force-dynamic";

/** Uygulamadan açılan HepsiJet gönderisinin etiketini bas. Gövde: { barkod, siparisNo? }. */
export async function POST(req: NextRequest) {
  const govde = (await req.json().catch(() => null)) as { barkod?: unknown; siparisNo?: unknown } | null;
  const barkod = takipNoTemizle(govde?.barkod);
  if (!barkod) return NextResponse.json({ error: "Bu siparişin kargosu oluşturulmamış." }, { status: 400 });
  const gonderi = await barkodlaGonderi(barkod).catch(() => null);
  if (!gonderi) return NextResponse.json({ error: "Bu siparişin kargosu oluşturulmamış." }, { status: 404 });
  if (gonderi.status === "iptal") return NextResponse.json({ error: "Bu gönderi iptal edildi." }, { status: 409 });
  try {
    const b = await hepsijetEtiketiBas(barkod);
    void basildiBulutaYaz({
      platform: "shopify",
      orderNumber: typeof govde?.siparisNo === "string" ? govde.siparisNo : gonderi.orderNumber,
      labelKey: b.anahtar,
      trackingNumber: barkod,
      packageNumber: null,
    });
    return NextResponse.json({ ok: true, barkod, basildi: b.basildi, etiketSayisi: b.etiketSayisi });
  } catch (error) {
    if (error instanceof EtiketBasilamadi && error.yaziciGerekli) {
      return NextResponse.json({ error: error.message, yaziciGerekli: true }, { status: 409 });
    }
    const mesaj = error instanceof EtiketBasilamadi ? error.message : "Etiket basılamadı. Tekrar dene.";
    return NextResponse.json({ error: mesaj }, { status: 502 });
  }
}
