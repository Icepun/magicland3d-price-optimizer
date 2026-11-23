import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { bustFinanceCaches, bustProfitInputCaches } from "@/lib/cache-busting";
import { tarifeDonemSiniri } from "@/core/tariff-period";
import { adRateSnapshot, bustAdRateCache, reklamEtkisiniYenidenHesapla } from "@/lib/ad-rate";
import { REKLAM_PENCERE_GUN } from "@/core/ad-cost";
import { TekParcaYazilamadi, tekParcaYaz } from "@/lib/actual-expenses";
import { dbEpochMs, toDbDate } from "@/lib/sqlite-date";

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

export async function GET() {
  await ensureRuntimeSchema();
  try {
    const butceler = await prisma.adBudget.findMany({
      orderBy: [{ platform: "asc" }, { validFrom: "desc" }],
    });
    const snap = await adRateSnapshot();
    // Oran okunamadı ≠ "bütçe yok": boş oran listesi kârı reklamsız (yüksek) gösterirdi.
    if (snap.bilinmiyor) throw new Error("reklam oranı okunamadı");
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
    // Boş yanıt "reklam bütçesi yok" demekti → kâr reklam payı düşülmeden (yüksek) görünüyordu.
    // Hata açıkça bildirilir; ekran "hesaplanamadı · tekrar dene" der.
    return NextResponse.json({ error: "Reklam bütçesi şu an okunamadı" }, { status: 503 });
  }
}

const Body = z.object({
  /** "all" = tüm platformlar (marka reklamı) — paydası TOPLAM cirodur. */
  platform: z.enum(["all", "trendyol", "shopify", "hepsiburada"]),
  /** Günlük reklam harcaması (TL). 0 = reklamı durdur (dönem kapanır, yenisi 0 ile açılır). */
  dailyAmount: z.coerce.number().min(0),
  /** Bu andan itibaren geçerli (ISO). */
  startsAt: z.string().datetime({ offset: true }),
});

/** Ham sorgu sayıları sürücüye göre BigInt gelebilir. */
const sayi = (v: unknown): number | null => (v == null ? null : Number(v));

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const { platform, dailyAmount, startsAt } = Body.parse(await req.json());

    const baslangic = new Date(startsAt);
    if (Number.isNaN(baslangic.getTime())) {
      return NextResponse.json({ error: "Başlangıç tarihi geçersiz." }, { status: 400 });
    }
    const { eskiBitis } = tarifeDonemSiniri(baslangic);
    const kayitAniMs = Date.now();

    /**
     * Var olan bir dönemin üstüne/gerisine yazmayı engelle — kargo tarifesindeki aynı koruma.
     * İzin verilseydi kapatma işlemi o dönemin `validTo`sunu kendi `validFrom`undan öne düşürür,
     * hiç eşleşmeyen ölü kayıtlar doğar ve dönemler iç içe geçerdi.
     * Tarihler `dbEpochMs` ile: telefonun yazdığı biçim farklı olsa da karşılaştırma tutar.
     */
    const cakisan = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${dbEpochMs("validFrom")} AS "bas" FROM "AdBudget"
        WHERE "platform" = ? AND ${dbEpochMs("validFrom")} >= ?
        ORDER BY ${dbEpochMs("validFrom")} DESC LIMIT 1`,
      platform,
      baslangic.getTime()
    );
    if (cakisan.length > 0) {
      const t = new Date(Number(cakisan[0].bas)).toLocaleDateString("tr-TR", { timeZone: "Europe/Istanbul" });
      return NextResponse.json(
        { error: `${t} tarihinde başlayan bir reklam bütçesi zaten var. Yeni bütçe ondan sonraki bir tarihte başlamalı.` },
        { status: 409 }
      );
    }

    // Kapanacak dönemler (yürürlükteki + yaklaşan) — sınırları değiştiği için oranları da değişir,
    // yeniden hesap aralığına girerler.
    const kapanacaklar = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${dbEpochMs("validFrom")} AS "bas" FROM "AdBudget"
        WHERE "platform" = ? AND ("validTo" IS NULL OR ${dbEpochMs("validTo")} >= ?)`,
      platform,
      kayitAniMs
    );

    // Eski dönemi kapatma + yenisini açma TEK işlemde: biri yazılıp diğeri düşerse ya bütçe
    // tamamen kaybolur ya da iki dönem birden yürürlükte kalırdı (telefon da böyle yazıyor).
    const id = randomUUID();
    await tekParcaYaz(
      [
        {
          sql: `UPDATE "AdBudget" SET "validTo" = ?
                 WHERE "platform" = ? AND ("validTo" IS NULL OR ${dbEpochMs("validTo")} >= ?)`,
          args: [toDbDate(eskiBitis), platform, kayitAniMs],
        },
        {
          sql: `INSERT INTO "AdBudget" ("id","platform","dailyAmount","validFrom","validTo","isActive","createdAt")
                VALUES (?,?,?,?,NULL,1,?)`,
          args: [id, platform, dailyAmount, toDbDate(baslangic), toDbDate(new Date(kayitAniMs))],
        },
      ],
      prisma
    );

    bustAdRateCache();
    bustProfitInputCaches(); // reklam payı değişti → sipariş kârı yeni oranla hesaplansın

    /**
     * RAPORLARI YENİDEN HESAPLA — Raporlar DONMUŞ kâr okuyor (`OrderFinanceSnapshot.profitKurus`).
     * Yalnız bütçe ARALIĞINDAKİ siparişler (yeni dönem + sınırı değişen önceki dönem): eskiden
     * başlangıç ayının TAMAMI (UTC ayıyla) yazılıyordu, bütçeden önceki ilgisiz siparişler de
     * bugünkü maliyetle yeniden donuyordu. Tur arkada koşar; bitince finans önbelleği düşer.
     */
    const basMs = Math.min(
      baslangic.getTime(),
      ...kapanacaklar.map((k) => sayi(k.bas)).filter((v): v is number => v != null && Number.isFinite(v))
    );
    const yenidenHesap = await reklamEtkisiniYenidenHesapla(
      { basMs, bitMs: Math.max(kayitAniMs, baslangic.getTime()), platform },
      { onDone: bustFinanceCaches }
    ).catch((error) => {
      console.error("[reklam-butcesi] yeniden hesap başlatılamadı:", error);
      return 0;
    });

    return NextResponse.json({
      ok: true,
      butce: {
        id,
        platform,
        dailyAmount,
        validFrom: baslangic.toISOString(),
        validTo: null,
        isActive: true,
      },
      yenidenHesap,
    });
  } catch (error) {
    if (error instanceof TekParcaYazilamadi) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Reklam bütçesi kaydedilemedi" },
      { status: 400 }
    );
  }
}
