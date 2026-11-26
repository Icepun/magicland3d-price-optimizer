import { NextResponse } from "next/server";
import { N11Client, N11Hatasi } from "@/services/n11-client";
import { n11Kimligi } from "@/services/n11-settings";

export const dynamic = "force-dynamic";

/**
 * Kayıtlı bilgilerle n11'e iki OKUMA isteği atar: ürün sayısı ve son 30 günün sipariş sayısı.
 * Hiçbir şey yazmaz.
 */
export async function POST() {
  try {
    const kimlik = await n11Kimligi().catch((e: Error) => {
      throw new N11Hatasi(e.message, 400);
    });
    const n11 = new N11Client(kimlik);
    const urunler = await n11.urunler(0, 1);
    const simdi = Date.now();
    const siparisler = await n11.siparisPaketleri({ baslangic: simdi - 30 * 86_400_000, bitis: simdi, boyut: 1 });
    return NextResponse.json({ ok: true, urunSayisi: urunler.toplam, siparisSayisi: siparisler.toplam });
  } catch (error) {
    if (error instanceof N11Hatasi) {
      return NextResponse.json({ error: error.message }, { status: error.durum });
    }
    console.error("[n11] bağlantı denemesi başarısız:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Bağlantı denenemedi. Tekrar dene." }, { status: 500 });
  }
}
