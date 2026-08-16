import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { bustProfitInputCaches } from "@/lib/cache-busting";
import { bustAdRateCache } from "@/lib/ad-rate";
import { tarifeDonemSiniri } from "@/core/tariff-period";

/**
 * REKLAM BÜTÇESİ — tek kaydı DÜZELT veya KALDIR.
 *
 * POST (üst rota) "yeni dönem başlat" içindir: eskisi kapanır, yenisi açılır. Burası ise
 * DÜZELTME içindir — "yanlış tarih/tutar girdim". Kargo tarifelerinde kararlaştırılan ayrımın
 * aynısı: düzenleme geçmişe de işler, dönem değişimi ayrı akışla yapılır.
 *
 * Bu ayrım olmadan kullanıcı sıkışıyordu: 1 Ağustos girip 1 Temmuz yapmak isteyince "bu tarihte
 * zaten bütçe var" hatası alıyor, silemediği için de düzeltemiyordu.
 */

const Body = z.object({
  dailyAmount: z.coerce.number().min(0).optional(),
  /** Yeni başlangıç anı (ISO). */
  startsAt: z.string().datetime({ offset: true }).optional(),
});

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await ctx.params;
    const { dailyAmount, startsAt } = Body.parse(await req.json());

    const mevcut = await prisma.adBudget.findUnique({ where: { id } });
    if (!mevcut) {
      return NextResponse.json({ error: "Reklam bütçesi bulunamadı." }, { status: 404 });
    }

    let yeniBaslangic = mevcut.validFrom;
    if (startsAt) {
      const d = new Date(startsAt);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: "Başlangıç tarihi geçersiz." }, { status: 400 });
      }
      /**
       * Aynı platformdaki BAŞKA bir dönemle çakışma olmasın. (Kendisi hariç.) Çakışsaydı iki
       * dönem aynı anda geçerli olur, hangi bütçenin uygulanacağı satır sırasına kalırdı.
       */
      const cakisan = await prisma.adBudget.findFirst({
        where: {
          platform: mevcut.platform,
          id: { not: id },
          // Diğer dönemin BİTİŞİ, bizim yeni başlangıcımızdan sonra mı? (açık dönem = sonsuz)
          OR: [{ validTo: null }, { validTo: { gte: d } }],
          // ...ve diğer dönemin BAŞLANGICI bizim bitişimizden önce mi?
          // Bizim dönem açıksa (validTo yok) üst sınır yoktur → bu koşul hiç eklenmez.
          // (Prisma çok uzak "sonsuz" tarihi serileştiremiyor; koşulu koymamak doğru karşılığı.)
          ...(mevcut.validTo ? { validFrom: { lte: mevcut.validTo } } : {}),
        },
        select: { validFrom: true },
      });
      if (cakisan) {
        const t = new Date(cakisan.validFrom).toLocaleDateString("tr-TR", { timeZone: "Europe/Istanbul" });
        return NextResponse.json(
          { error: `${t} tarihli başka bir bütçeyle çakışıyor. Önce onu kaldır ya da farklı bir tarih seç.` },
          { status: 409 }
        );
      }
      yeniBaslangic = d;
    }

    const guncel = await prisma.adBudget.update({
      where: { id },
      data: {
        ...(dailyAmount !== undefined ? { dailyAmount } : {}),
        ...(startsAt ? { validFrom: yeniBaslangic } : {}),
      },
    });

    bustAdRateCache();
    bustProfitInputCaches();
    return NextResponse.json({ ok: true, butce: guncel });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Bütçe güncellenemedi" },
      { status: 400 }
    );
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await ctx.params;

    const mevcut = await prisma.adBudget.findUnique({ where: { id } });
    if (!mevcut) {
      return NextResponse.json({ error: "Reklam bütçesi bulunamadı." }, { status: 404 });
    }

    await prisma.adBudget.delete({ where: { id } });

    /**
     * ÖNCEKİ DÖNEMİ GERİ AÇ. Bu kayıt açılırken kendinden önceki dönemi `başlangıç − 1 ms`de
     * kapatmıştı; silince o dönem kapalı kalırsa arada KURALSIZ bir boşluk doğar ve o aralıktaki
     * siparişler sessizce reklam payı taşımaz olur. Kapanışı tam bu kaydın açılışına denk gelen
     * dönem varsa yeniden açılır.
     */
    const { eskiBitis } = tarifeDonemSiniri(mevcut.validFrom);
    await prisma.adBudget.updateMany({
      where: { platform: mevcut.platform, validTo: eskiBitis },
      data: { validTo: null },
    });

    bustAdRateCache();
    bustProfitInputCaches();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Bütçe kaldırılamadı" },
      { status: 400 }
    );
  }
}
