import { NextRequest, NextResponse } from "next/server";
import { etiketYazicisiKaydet, yaziciDurumu } from "@/lib/etiket/ham-yazici";
import { basilanlariOku } from "@/lib/etiket/kayit";
import { jsonError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

/** Bu bilgisayardaki yazıcılar + etiket için seçili olan + daha önce basılan etiketler. */
export async function GET() {
  try {
    const durum = await yaziciDurumu().catch(() => ({ yazicilar: [], secili: null, elleSecildi: false }));
    return NextResponse.json({ ...durum, basilanlar: basilanlariOku() });
  } catch (error) {
    return jsonError(error);
  }
}

/** Etiket yazıcısını seç (bu bilgisayar için). */
export async function PUT(req: NextRequest) {
  try {
    const govde = (await req.json().catch(() => null)) as { yazici?: unknown } | null;
    const yazici = typeof govde?.yazici === "string" ? govde.yazici.trim() : "";
    if (!yazici) return NextResponse.json({ error: "Bir yazıcı seç." }, { status: 400 });
    const durum = await yaziciDurumu();
    if (!durum.yazicilar.includes(yazici)) {
      return NextResponse.json({ error: "Bu yazıcı bilgisayarda bulunamadı." }, { status: 400 });
    }
    etiketYazicisiKaydet(yazici);
    return NextResponse.json({ ...(await yaziciDurumu()), basilanlar: basilanlariOku() });
  } catch (error) {
    return jsonError(error);
  }
}
