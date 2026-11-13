import { NextRequest, NextResponse } from "next/server";
import { HepsiburadaClient } from "@/services/hepsiburada-client";
import { getHepsiburadaCredentials } from "@/services/hepsiburada-settings";
import { hamYazdir, yaziciDurumu } from "@/lib/etiket/ham-yazici";
import { hbEtiketiGetir } from "@/lib/etiket/hb-etiket";
import {
  basildiIsaretle,
  eskiKopyalariSupur,
  etiketleriBirlestir,
  takipNoTemizle,
} from "@/lib/etiket/kayit";
import { KullaniciHatasi } from "@/lib/etiket/kullanici-hatasi";

export const dynamic = "force-dynamic";

/**
 * Bir Hepsiburada paketinin kargo etiketini 100×100'e sığdırıp etiket yazıcısına basar.
 * Gövde: { paketNo, takipNo? } — takipNo (teslimat no) "basıldı" işaretinin anahtarı.
 * Paketin durumunu DEĞİŞTİRMEZ.
 */
export async function POST(req: NextRequest) {
  const govde = (await req.json().catch(() => null)) as { paketNo?: unknown; takipNo?: unknown } | null;
  const paketNo = takipNoTemizle(govde?.paketNo);
  if (!paketNo) {
    return NextResponse.json({ error: "Sipariş henüz paketlenmemiş." }, { status: 400 });
  }
  const anahtar = takipNoTemizle(govde?.takipNo) ?? paketNo;

  try {
    const { secili } = await yaziciDurumu();
    if (!secili) {
      return NextResponse.json({ error: "Etiket yazıcısı seçilmedi.", yaziciGerekli: true }, { status: 409 });
    }
    const istemci = new HepsiburadaClient(await getHepsiburadaCredentials());
    const { etiketler, kaynak } = await hbEtiketiGetir(istemci, paketNo, anahtar);
    await hamYazdir(secili, etiketleriBirlestir(etiketler));
    const basildi = basildiIsaretle(anahtar);
    eskiKopyalariSupur();
    console.info(`[etiket] HB ${paketNo} → ${secili} (${etiketler.length} etiket, ${kaynak})`);
    return NextResponse.json({ ok: true, takipNo: anahtar, basildi, etiketSayisi: etiketler.length });
  } catch (error) {
    console.error(`[etiket] HB ${paketNo} basılamadı:`, error);
    const mesaj =
      error instanceof KullaniciHatasi
        ? error.message
        : error instanceof Error && /okunamad|eksik/i.test(error.message)
          ? "Hepsiburada bağlantısı kurulmamış."
          : "Etiket basılamadı. Tekrar dene.";
    return NextResponse.json({ error: mesaj }, { status: 502 });
  }
}
