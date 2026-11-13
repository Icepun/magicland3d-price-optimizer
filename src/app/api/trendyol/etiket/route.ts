import { NextRequest, NextResponse } from "next/server";
import { TrendyolClient, TrendyolApiError } from "@/services/trendyol-client";
import { getTrendyolCredentials } from "@/services/trendyol-settings";
import { hamYazdir, yaziciDurumu } from "@/lib/etiket/ham-yazici";
import { trendyolEtiketiGetir } from "@/lib/etiket/trendyol-etiket";
import {
  basildiIsaretle,
  eskiKopyalariSupur,
  etiketleriBirlestir,
  takipNoTemizle,
} from "@/lib/etiket/kayit";
import { KullaniciHatasi } from "@/lib/etiket/kullanici-hatasi";

export const dynamic = "force-dynamic";

/**
 * Bir Trendyol siparişinin kargo etiketini alıp etiket yazıcısına basar.
 * Gövde: { takipNo }. Pakete durum YAZMAZ.
 */
export async function POST(req: NextRequest) {
  const govde = (await req.json().catch(() => null)) as { takipNo?: unknown } | null;
  const takipNo = takipNoTemizle(govde?.takipNo);
  if (!takipNo) {
    return NextResponse.json({ error: "Bu siparişin takip numarası yok." }, { status: 400 });
  }

  try {
    const { secili } = await yaziciDurumu();
    if (!secili) {
      return NextResponse.json({ error: "Etiket yazıcısı seçilmedi.", yaziciGerekli: true }, { status: 409 });
    }

    const istemci = new TrendyolClient(await getTrendyolCredentials());
    const { etiketler, kaynak } = await trendyolEtiketiGetir(istemci, takipNo);
    await hamYazdir(secili, etiketleriBirlestir(etiketler));
    const basildi = basildiIsaretle(takipNo);
    eskiKopyalariSupur();
    console.info(`[etiket] ${takipNo} → ${secili} (${etiketler.length} etiket, ${kaynak})`);
    return NextResponse.json({ ok: true, takipNo, basildi, etiketSayisi: etiketler.length });
  } catch (error) {
    console.error(`[etiket] ${takipNo} basılamadı:`, error);
    return NextResponse.json({ error: kullaniciMesaji(error) }, { status: 502 });
  }
}

function kullaniciMesaji(error: unknown): string {
  if (error instanceof TrendyolApiError) {
    if (error.status === 401 || error.status === 403) return "Trendyol bağlantı bilgilerini kontrol et.";
    if (error.status === 429) return "Trendyol çok sık istek aldı. Biraz bekleyip tekrar dene.";
    if (error.status === 408) return "Trendyol yanıt vermedi. Tekrar dene.";
    if (error.status === 400 || error.status === 404) {
      return "Trendyol bu gönderi için etiket vermedi. Kargo firması Trendyol Express mi, kontrol et.";
    }
    return "Trendyol'a ulaşılamadı. Tekrar dene.";
  }
  if (error instanceof KullaniciHatasi) return error.message;
  // Trendyol ayarı eksikse ayar okuyucunun hatası gelir (bkz. trendyol-settings).
  if (error instanceof Error && /okunamad|eksik/i.test(error.message)) return "Trendyol bağlantısı kurulmamış.";
  return "Etiket basılamadı. Tekrar dene.";
}
