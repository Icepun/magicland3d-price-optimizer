import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hepsijetHesabiKaydet, hepsijetHesabiOku } from "@/lib/kargo/hepsijet-hesap";
import { kargoHataYaniti } from "@/lib/kargo/api-yanit";

export const dynamic = "force-dynamic";

const alan = (ad: string) => z.string().trim().min(1, `${ad} gerekli`).max(300);

const Schema = z.object({
  sirketAdi: alan("Şirket adı"),
  sirketKodu: alan("Şirket kodu"),
  aktarmaKodu: alan("Aktarma merkezi kodu"),
  barkodOnEki: z.string().trim().regex(/^[A-Za-z0-9]{3}$/, "Barkod ön eki 3 karakter olmalı"),
  depo: z.object({
    adresKimligi: alan("Depo adres kimliği"),
    il: alan("İl"),
    ilce: alan("İlçe"),
    mahalle: alan("Mahalle"),
    adres: alan("Açık adres"),
    yetkili: z.string().trim().max(120).optional(),
    telefon: z.string().trim().max(30).optional(),
  }),
});

/** HepsiJet hesap sabitleri (gönderici / iade deposu) — Entegrasyonlar → HepsiJet. */
export async function GET() {
  try {
    return NextResponse.json({ hesap: await hepsijetHesabiOku() });
  } catch (error) {
    return kargoHataYaniti(error);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const hesap = await hepsijetHesabiKaydet(Schema.parse(await req.json()));
    return NextResponse.json({ hesap });
  } catch (error) {
    return kargoHataYaniti(error);
  }
}
