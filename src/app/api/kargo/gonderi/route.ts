import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { kargoGonderisiAc, kargoGonderisiniIptalEt } from "@/lib/kargo/hepsijet-gonder";
import { kargoHataYaniti } from "@/lib/kargo/api-yanit";
import { EtiketBasilamadi, hepsijetEtiketiBas } from "@/lib/etiket/bas";
import { takipNoTemizle } from "@/lib/etiket/kayit";
import { basildiBulutaYaz } from "@/lib/etiket/telefon-istekleri";

export const dynamic = "force-dynamic";

const Olustur = z.object({
  siparisId: z.string().trim().min(1).max(200),
  bas: z.boolean().optional().default(true),
  alici: z.object({
    ad: z.string().max(80),
    soyad: z.string().max(80),
    telefon: z.string().max(30),
    il: z.string().max(80),
    ilce: z.string().max(80),
    mahalle: z.string().max(120).nullable().optional(),
    adres: z.string().max(400),
  }),
});

/**
 * HepsiJet gönderisi aç (+ istenirse etiketi hemen bas). Gönderi açılıp etiket basılamazsa
 * gönderi GERİ ALINMAZ — yanıt `baski.ok: false` ile döner, etiket sonradan basılır.
 */
export async function POST(req: NextRequest) {
  let girdi: z.infer<typeof Olustur>;
  try {
    girdi = Olustur.parse(await req.json());
  } catch (error) {
    return kargoHataYaniti(error);
  }
  let sonuc;
  try {
    sonuc = await kargoGonderisiAc({ siparisId: girdi.siparisId, alici: girdi.alici });
  } catch (error) {
    return kargoHataYaniti(error);
  }
  let baski: { ok: true; basildi: string } | { ok: false; mesaj: string; yaziciGerekli: boolean } | null = null;
  if (girdi.bas) {
    try {
      const b = await hepsijetEtiketiBas(sonuc.gonderi.barkod);
      void basildiBulutaYaz({
        platform: "shopify",
        orderNumber: sonuc.siparisNo,
        labelKey: b.anahtar,
        trackingNumber: sonuc.gonderi.barkod,
        packageNumber: null,
      });
      baski = { ok: true, basildi: b.basildi };
    } catch (error) {
      baski = {
        ok: false,
        mesaj: error instanceof EtiketBasilamadi ? error.message : "Etiket basılamadı. Tekrar dene.",
        yaziciGerekli: error instanceof EtiketBasilamadi && error.yaziciGerekli,
      };
    }
  }
  return NextResponse.json({ gonderi: sonuc.gonderi, baski });
}

/** Kurye almadan önce iptal et. Gövde: { barkod }. */
export async function DELETE(req: NextRequest) {
  const govde = (await req.json().catch(() => null)) as { barkod?: unknown } | null;
  const barkod = takipNoTemizle(govde?.barkod);
  if (!barkod) return NextResponse.json({ error: "Gönderi seçilmedi." }, { status: 400 });
  try {
    return NextResponse.json({ gonderi: await kargoGonderisiniIptalEt(barkod) });
  } catch (error) {
    return kargoHataYaniti(error);
  }
}
