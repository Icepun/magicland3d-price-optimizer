import { NextResponse } from "next/server";
import { remotePrisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { pushToAllDevices, sonPushOzeti } from "@/lib/push-notify";

/**
 * Telefon bildirimi tanı ucu (arayüz başka yerde yazılıyor; burada yalnız sade veri var).
 *   GET  → kaç telefon kayıtlı + en son ne zaman kaydolmuş + son gönderimin özeti
 *   POST → tüm telefonlara tek test bildirimi gönderir ve SONUCU döner
 *
 * POST teslim makbuzunu da bekler (gerçekten düştü mü?), bu yüzden ~8 sn sürebilir;
 * arayüz bu süre boyunca aşamalı ilerleme gösterebilsin diye `tahminiSureMs` de dönüyor.
 */

/** Test gönderiminde makbuz beklemesi — kısa tutuldu ki ekran çok bekletmesin. */
const TEST_MAKBUZ_GECIKME_MS = 8_000;

export async function GET() {
  try {
    await ensureRuntimeSchema();
    const [cihazSayisi, sonKayitSatiri] = await Promise.all([
      remotePrisma.pushToken.count(),
      remotePrisma.pushToken.findFirst({
        orderBy: { updatedAt: "desc" },
        select: { platform: true, updatedAt: true },
      }),
    ]);

    return NextResponse.json(
      {
        cihazSayisi,
        sonKayitTarihi: sonKayitSatiri?.updatedAt?.toISOString() ?? null,
        sonKayitPlatform: sonKayitSatiri?.platform || null,
        sonGonderim: sonPushOzeti(),
        tahminiSureMs: TEST_MAKBUZ_GECIKME_MS + 2_000,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST() {
  try {
    await ensureRuntimeSchema();

    const ozet = await pushToAllDevices(
      "Magicland 3D Hub",
      "Test bildirimi — bunu gördüyseniz bildirimler çalışıyor.",
      { makbuzlariBekle: true, makbuzGecikmeMs: TEST_MAKBUZ_GECIKME_MS }
    );

    const teslimEdilen = ozet.teslim?.basarili ?? 0;
    const durum: "basarili" | "kismi" | "basarisiz" | "cihaz-yok" =
      ozet.toplamCihaz === 0
        ? "cihaz-yok"
        : teslimEdilen > 0 && ozet.hata === 0 && (ozet.teslim?.hatali ?? 0) === 0
          ? "basarili"
          : teslimEdilen > 0
            ? "kismi"
            : "basarisiz";

    const mesaj =
      durum === "cihaz-yok"
        ? "Kayıtlı telefon yok. Telefondaki uygulamayı açıp bildirim iznini verin."
        : durum === "basarili"
          ? `Test bildirimi ${teslimEdilen} telefona ulaştı.`
          : durum === "kismi"
            ? `${teslimEdilen} telefona ulaştı, bazılarına ulaşmadı.`
            : "Hiçbir telefona ulaşmadı.";

    return NextResponse.json(
      {
        durum,
        mesaj,
        toplamCihaz: ozet.toplamCihaz,
        gonderildi: ozet.gonderildi,
        teslimEdilen,
        hata: ozet.hata + (ozet.teslim?.hatali ?? 0),
        temizlenenKayit: ozet.temizlenenKayit,
        sebepler: ozet.sebepler,
        zaman: ozet.zaman,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return jsonError(error);
  }
}
