import { NextResponse } from "next/server";
import { HepsijetClient, HepsijetHatasi } from "@/services/hepsijet-client";
import { hepsijetKimligi } from "@/services/hepsijet-settings";

export const dynamic = "force-dynamic";

/** Kayıtlı bilgilerle HepsiJet'e giriş yapmayı dener; hesabın şirket ve şube adını döner. */
export async function POST() {
  try {
    const kimlik = await hepsijetKimligi().catch((e: Error) => {
      throw new HepsijetHatasi(e.message, 400);
    });
    const hesap = await new HepsijetClient(kimlik).girisYap();
    return NextResponse.json({ ok: true, ortam: kimlik.ortam, sirket: hesap.sirketAdi, sube: hesap.aktarmaAdi });
  } catch (error) {
    if (error instanceof HepsijetHatasi) {
      return NextResponse.json({ error: error.message }, { status: error.durum });
    }
    console.error("[hepsijet] bağlantı denemesi başarısız:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Bağlantı denenemedi. Tekrar dene." }, { status: 500 });
  }
}
