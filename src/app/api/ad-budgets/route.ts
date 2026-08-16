import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { bustProfitInputCaches } from "@/lib/cache-busting";
import { tarifeDonemSiniri } from "@/core/tariff-period";
import { adRateSnapshot, bustAdRateCache } from "@/lib/ad-rate";
import { recalculateFinanceMonths } from "@/lib/order-finance-snapshots";
import { REKLAM_PENCERE_GUN } from "@/core/ad-cost";

/**
 * REKLAM BÜTÇESİ — platform başına günlük reklam harcaması.
 *
 * GET  → kayıtlı bütçeler + her platformun BUGÜNKÜ oranı (ciroya oran) ve o oranın
 *        sipariş/adet karşılığı (arayüzde canlı önizleme).
 * POST → yeni bütçe dönemi başlat: aynı platformun yürürlükteki kaydı başlangıçtan 1 ms önce
 *        kapanır (SİLİNMEZ — geçmiş siparişlerin kârı ona bağlı), yenisi açılır.
 *
 * ⚠️ Bu uç KÂR RAKAMINI DEĞİŞTİRİR: bütçe girildiği andan itibaren o platformun siparişleri
 * reklam payı taşımaya başlar.
 */


/**
 * Başlangıçtan bugüne kadarki ay anahtarları ("2026-08"). Reklam payı yalnız bu ayları
 * etkiler; öncesi zaten pay taşımıyor.
 */
function etkilenenAylar(bas: Date, son: Date): string[] {
  const aylar: string[] = [];
  const d = new Date(Date.UTC(bas.getUTCFullYear(), bas.getUTCMonth(), 1));
  const bitis = new Date(Date.UTC(son.getUTCFullYear(), son.getUTCMonth(), 1));
  // Üst sınır: makul bir tavan (yanlış tarihte sonsuz döngü olmasın).
  while (d <= bitis && aylar.length < 60) {
    aylar.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return aylar;
}

export async function GET() {
  await ensureRuntimeSchema();
  try {
    const butceler = await prisma.adBudget.findMany({
      orderBy: [{ platform: "asc" }, { validFrom: "desc" }],
    });
    const snap = await adRateSnapshot();
    const oranlar = Object.fromEntries(
      [...snap.bugun.entries()].map(([platform, o]) => [
        platform,
        {
          oran: o.oran,
          yuzde: o.oran * 100,
          toplamHarcama: o.toplamHarcama,
          guvenilir: o.guvenilir,
          cirodanBuyuk: o.cirodanBuyuk,
        },
      ])
    );
    return NextResponse.json({ butceler, oranlar, pencereGun: REKLAM_PENCERE_GUN });
  } catch {
    return NextResponse.json({ butceler: [], oranlar: {}, pencereGun: REKLAM_PENCERE_GUN });
  }
}

const Body = z.object({
  platform: z.enum(["trendyol", "shopify", "hepsiburada"]),
  /** Günlük reklam harcaması (TL). 0 = reklamı durdur (dönem kapanır, yenisi 0 ile açılır). */
  dailyAmount: z.coerce.number().min(0),
  /** Bu andan itibaren geçerli (ISO). */
  startsAt: z.string().datetime({ offset: true }),
});

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const { platform, dailyAmount, startsAt } = Body.parse(await req.json());

    const baslangic = new Date(startsAt);
    if (Number.isNaN(baslangic.getTime())) {
      return NextResponse.json({ error: "Başlangıç tarihi geçersiz." }, { status: 400 });
    }
    const { eskiBitis } = tarifeDonemSiniri(baslangic);

    /**
     * Var olan bir dönemin üstüne/gerisine yazmayı engelle — kargo tarifesindeki aynı koruma.
     * İzin verilseydi kapatma işlemi o dönemin `validTo`sunu kendi `validFrom`undan öne düşürür,
     * hiç eşleşmeyen ölü kayıtlar doğar ve dönemler iç içe geçerdi.
     */
    const cakisan = await prisma.adBudget.findFirst({
      where: { platform, validFrom: { gte: baslangic } },
      orderBy: { validFrom: "desc" },
      select: { validFrom: true },
    });
    if (cakisan) {
      const t = new Date(cakisan.validFrom).toLocaleDateString("tr-TR", { timeZone: "Europe/Istanbul" });
      return NextResponse.json(
        { error: `${t} tarihinde başlayan bir reklam bütçesi zaten var. Yeni bütçe ondan sonraki bir tarihte başlamalı.` },
        { status: 409 }
      );
    }

    // Süresi dolmamış kayıtları kapat (yürürlükteki + yaklaşan) — geçmişe dokunma.
    await prisma.adBudget.updateMany({
      where: {
        platform,
        OR: [{ validTo: null }, { validTo: { gte: new Date() } }],
      },
      data: { validTo: eskiBitis },
    });

    const yeni = await prisma.adBudget.create({
      data: { platform, dailyAmount, validFrom: baslangic, validTo: null, isActive: true },
    });

    bustAdRateCache();
    bustProfitInputCaches(); // reklam payı değişti → sipariş kârı yeni oranla hesaplansın

    /**
     * RAPORLARI YENİDEN HESAPLA — Raporlar DONMUŞ kâr okuyor (`OrderFinanceSnapshot.profitKurus`).
     * Bütçe girildiğinde Siparişler ekranı anında yeni kârı gösterir ama Raporlar, biri
     * "yeniden hesapla" diyene kadar ESKİ (reklamsız, yüksek) kârı göstermeye devam ederdi —
     * iki ekran birbirini tutmaz, kullanıcı hangisine güveneceğini bilemezdi.
     *
     * Yalnız ETKİLENEN aylar: bütçenin başladığı aydan bugüne. Öncesi zaten reklam payı
     * taşımıyor, dokunmaya gerek yok.
     *
     * Beklenmiyor (void): yeniden hesap yüzlerce satır yazabilir; isteği bekletmek arayüzü
     * kilitlerdi. Hata olursa yutulur — kullanıcı istediğinde elle tetikleyebilir.
     */
    const aylar = etkilenenAylar(baslangic, new Date());
    if (aylar.length > 0) {
      void recalculateFinanceMonths(aylar).catch(() => {});
    }

    return NextResponse.json({ ok: true, butce: yeni, yenidenHesaplananAy: aylar.length });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Reklam bütçesi kaydedilemedi" },
      { status: 400 }
    );
  }
}
