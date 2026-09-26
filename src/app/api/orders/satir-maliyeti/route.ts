import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { invalidateOrdersCache } from "@/lib/orders-cache";
import { bustCache } from "@/lib/route-cache";
import { filamentFiyatlariOku } from "@/lib/filament-fiyatlari";
import {
  satirMaliyetiCozumle,
  satirMaliyetiOku,
  satirMaliyetiYaz,
  siparisKimligi,
} from "@/core/order-line-cost";

/**
 * SİPARİŞE ÖZEL MALİYET — Siparişler ekranındaki "Maliyet gir".
 *   GET    ?platform&siparis&anahtar → kayıtlı girdi (düzenleme için)
 *   PUT    { platform, siparisId, satirAnahtari, satirAdi, maliyet, desi } → kaydet
 *   DELETE { platform, siparisId, satirAnahtari } → kaldır
 *
 * Kayıt değişince o siparişin finans özeti "yeniden hesapla" diye işaretlenir: ilk tam kâr
 * yakalandıktan sonra özet donuyor (bkz. shouldReplaceCapturedProfit); işaret olmadan düzeltilen
 * maliyet Raporlar'a hiç yansımazdı.
 */

const Platform = z.enum(["shopify", "trendyol", "hepsiburada"]);
const Anahtar = z.object({
  platform: Platform,
  siparisId: z.string().min(1).max(200),
  satirAnahtari: z.string().min(3).max(400),
});

const KaydetSchema = Anahtar.extend({
  satirAdi: z.string().max(300).default(""),
  maliyet: z.record(z.string(), z.unknown()),
  desi: z.number().min(0, "Desi eksi olamaz").max(1000).nullable().optional(),
});

/** Kâr özetini bir sonraki sipariş yenilemesinde yeniden hesaplanacak şekilde işaretle. */
async function ozetiYenidenHesaplat(platform: string, siparisId: string): Promise<void> {
  await prisma
    .$executeRawUnsafe(
      `UPDATE "OrderFinanceSnapshot" SET "calculationVersion" = 0 WHERE "platform" = ? AND "externalOrderId" = ?`,
      platform,
      siparisKimligi(platform, siparisId)
    )
    .catch(() => {});
  invalidateOrdersCache();
  bustCache("dashboard:");
}

export async function GET(req: Request) {
  try {
    await ensureRuntimeSchema();
    const url = new URL(req.url);
    const { platform, siparisId, satirAnahtari } = Anahtar.parse({
      platform: url.searchParams.get("platform"),
      siparisId: url.searchParams.get("siparis"),
      satirAnahtari: url.searchParams.get("anahtar"),
    });
    const kayit = await prisma.orderLineCost.findUnique({
      where: {
        platform_externalOrderId_lineKey: {
          platform,
          externalOrderId: siparisKimligi(platform, siparisId),
          lineKey: satirAnahtari,
        },
      },
      select: { costJson: true, desi: true, lineName: true, updatedAt: true },
    });
    return NextResponse.json(
      {
        kayit: kayit
          ? { maliyet: satirMaliyetiOku(kayit.costJson), desi: kayit.desi, satirAdi: kayit.lineName }
          : null,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(req: Request) {
  try {
    await ensureRuntimeSchema();
    const govde = KaydetSchema.parse(await req.json());
    const maliyet = satirMaliyetiOku(govde.maliyet);
    if (!maliyet) return NextResponse.json({ error: "Maliyet okunamadı" }, { status: 400 });

    // Eksik girdiyle kayıt açılmasın: kâra girmeyecek bir kayıt kullanıcıyı yanıltır.
    const settings = Object.fromEntries(
      (await prisma.appSetting.findMany()).map((s) => [s.key, s.value])
    );
    const cozum = satirMaliyetiCozumle(maliyet, settings, await filamentFiyatlariOku());
    if (!cozum?.productionCostKnown) {
      return NextResponse.json(
        { error: maliyet.mod === "tutar" ? "Maliyet tutarını gir" : "Filament ve ağırlık gir" },
        { status: 400 }
      );
    }

    const externalOrderId = siparisKimligi(govde.platform, govde.siparisId);
    await prisma.orderLineCost.upsert({
      where: {
        platform_externalOrderId_lineKey: {
          platform: govde.platform,
          externalOrderId,
          lineKey: govde.satirAnahtari,
        },
      },
      create: {
        id: `olc_${randomUUID().replace(/-/g, "")}`,
        platform: govde.platform,
        externalOrderId,
        lineKey: govde.satirAnahtari,
        lineName: govde.satirAdi.trim(),
        costJson: satirMaliyetiYaz(maliyet),
        desi: govde.desi ?? null,
      },
      update: {
        lineName: govde.satirAdi.trim(),
        costJson: satirMaliyetiYaz(maliyet),
        desi: govde.desi ?? null,
      },
    });
    await ozetiYenidenHesaplat(govde.platform, govde.siparisId);
    return NextResponse.json({ ok: true, birimMaliyet: cozum.totalCost });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(req: Request) {
  try {
    await ensureRuntimeSchema();
    const govde = Anahtar.parse(await req.json());
    await prisma.orderLineCost.deleteMany({
      where: {
        platform: govde.platform,
        externalOrderId: siparisKimligi(govde.platform, govde.siparisId),
        lineKey: govde.satirAnahtari,
      },
    });
    await ozetiYenidenHesaplat(govde.platform, govde.siparisId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
