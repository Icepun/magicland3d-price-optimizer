import { NextResponse } from "next/server";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { pushToAllDevices } from "@/lib/push-notify";
import { ozelBildirimOku, pushSonucu } from "@/lib/push-sonuc";

/**
 * ÖZEL BİLDİRİM — ayarlardan elle yazılan başlık + metin tüm telefonlara ya da tek telefona.
 * Bildirim tercihine (kapatılan türler) bakılmaz: elle yazılan mesaj bilinçli gönderiliyor.
 * Teslim makbuzunu bekler (~8 sn) ki ekran "ulaştı / ulaşmadı" diyebilsin.
 */
const MAKBUZ_GECIKME_MS = 8_000;

export async function POST(req: Request) {
  try {
    const girdi = ozelBildirimOku(await req.json().catch(() => null));
    if (!girdi.tamam) return NextResponse.json({ error: girdi.hata }, { status: 400 });
    await ensureRuntimeSchema();

    const ozet = await pushToAllDevices(girdi.baslik, girdi.metin, {
      makbuzlariBekle: true,
      makbuzGecikmeMs: MAKBUZ_GECIKME_MS,
      yalnizToken: girdi.cihaz,
    });
    return NextResponse.json(pushSonucu(ozet, { tekTelefon: !!girdi.cihaz, ne: "Bildirim" }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return jsonError(error);
  }
}
