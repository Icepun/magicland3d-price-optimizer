import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { bustFinanceCaches, bustProfitInputCaches } from "@/lib/cache-busting";
import { bustAdRateCache, reklamEtkisiniYenidenHesapla } from "@/lib/ad-rate";
import { tarifeDonemSiniri } from "@/core/tariff-period";
import { TekParcaYazilamadi, tekParcaYaz, type YazmaIfadesi } from "@/lib/actual-expenses";
import { dbEpochMs, toDbDate } from "@/lib/sqlite-date";

/**
 * REKLAM BÜTÇESİ — tek kaydı DÜZELT veya KALDIR.
 *
 * POST (üst rota) "yeni dönem başlat" içindir: eskisi kapanır, yenisi açılır. Burası ise
 * DÜZELTME içindir — "yanlış tarih/tutar girdim". Kargo tarifelerinde kararlaştırılan ayrımın
 * aynısı: düzenleme geçmişe de işler, dönem değişimi ayrı akışla yapılır.
 *
 * Bu ayrım olmadan kullanıcı sıkışıyordu: 1 Ağustos girip 1 Temmuz yapmak isteyince "bu tarihte
 * zaten bütçe var" hatası alıyor, silemediği için de düzeltemiyordu.
 *
 * Denetim (23 Kas 2026): iki uç da Raporlar'ı güncellemiyordu (donmuş kâr eski bütçeyle kalıyordu),
 * yazımlar tek parça değildi ve "önceki dönem" eşitlikle aranıyordu — telefonun `…Z` biçiminde
 * yazdığı tarihte tutmuyordu. Şimdi tarihler `dbEpochMs` ile karşılaştırılır, yazım tek işlemdir,
 * etkilenen aralıktaki siparişler arkada yeniden hesaplanır.
 */

const Body = z.object({
  dailyAmount: z.coerce.number().min(0).optional(),
  /** Yeni başlangıç anı (ISO). */
  startsAt: z.string().datetime({ offset: true }).optional(),
});

interface Donem {
  id: string;
  platform: string;
  basMs: number;
  bitMs: number | null;
}

const sayi = (v: unknown): number | null => (v == null ? null : Number(v));

function donem(r: Record<string, unknown>): Donem {
  return { id: String(r.id), platform: String(r.platform), basMs: Number(r.bas), bitMs: sayi(r.bit) };
}

async function donemOku(id: string): Promise<Donem | null> {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT "id","platform",${dbEpochMs("validFrom")} AS "bas",${dbEpochMs("validTo")} AS "bit"
       FROM "AdBudget" WHERE "id" = ?`,
    id
  );
  return rows[0] ? donem(rows[0]) : null;
}

/**
 * Bu dönem açılırken kapatılan ÖNCEKİ dönem: bitişi tam olarak `başlangıç − 1 ms`.
 * Eşitlik `dbEpochMs` üzerinden — metin karşılaştırması telefonun `…Z` biçimini kaçırıyordu.
 */
async function oncekiDonem(d: Donem): Promise<Donem | null> {
  const { eskiBitis } = tarifeDonemSiniri(new Date(d.basMs));
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT "id","platform",${dbEpochMs("validFrom")} AS "bas",${dbEpochMs("validTo")} AS "bit"
       FROM "AdBudget"
      WHERE "platform" = ? AND "id" <> ? AND "validTo" IS NOT NULL AND ${dbEpochMs("validTo")} = ?
      ORDER BY ${dbEpochMs("validFrom")} DESC LIMIT 1`,
    d.platform,
    d.id,
    eskiBitis.getTime()
  );
  return rows[0] ? donem(rows[0]) : null;
}

function hataYaniti(error: unknown, varsayilan: string) {
  if (error instanceof TekParcaYazilamadi) {
    return NextResponse.json({ error: error.message }, { status: 503 });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : varsayilan },
    { status: 400 }
  );
}

/** Kaydı izleyen yeniden hesap: yalnız aralıktaki siparişler; bitince Raporlar önbelleği düşer. */
async function yenidenHesapla(basMs: number, bitMs: number, platform: string): Promise<number> {
  return reklamEtkisiniYenidenHesapla({ basMs, bitMs, platform }, { onDone: bustFinanceCaches }).catch(
    (error) => {
      console.error("[reklam-butcesi] yeniden hesap başlatılamadı:", error);
      return 0;
    }
  );
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await ctx.params;
    const { dailyAmount, startsAt } = Body.parse(await req.json());

    const mevcut = await donemOku(id);
    if (!mevcut) {
      return NextResponse.json({ error: "Reklam bütçesi bulunamadı." }, { status: 404 });
    }

    let yeniBasMs = mevcut.basMs;
    if (startsAt) {
      const d = new Date(startsAt);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: "Başlangıç tarihi geçersiz." }, { status: 400 });
      }
      yeniBasMs = d.getTime();
    }
    if (mevcut.bitMs != null && yeniBasMs > mevcut.bitMs) {
      return NextResponse.json({ error: "Başlangıç, dönemin bitişinden sonra olamaz." }, { status: 400 });
    }

    /**
     * ÖNCEKİ DÖNEM DE KAYAR. Başlangıç ileri alınırsa önceki dönemin bitişi eskide kalır ve arada
     * KURALSIZ bir boşluk doğar (o günlerin siparişleri sessizce reklamsız sayılırdı). Geri
     * alınırsa önceki dönem yeni başlangıca kadar kısalır — önceki dönemin kendi başlangıcını
     * geçmediği sürece (geçerse aşağıdaki çakışma uyarısı çıkar).
     */
    const baslangicDegisti = yeniBasMs !== mevcut.basMs;
    const onceki = baslangicDegisti ? await oncekiDonem(mevcut) : null;
    const kayacakOnceki = onceki != null && yeniBasMs > onceki.basMs ? onceki : null;

    if (baslangicDegisti) {
      /**
       * Aynı platformdaki BAŞKA bir dönemle çakışma olmasın (kendisi ve kaydırılacak önceki dönem
       * hariç). Çakışsaydı iki dönem aynı anda geçerli olur, hangi bütçenin uygulanacağı satır
       * sırasına kalırdı. Bu dönem açıksa üst sınır yoktur.
       */
      const cakisan = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT ${dbEpochMs("validFrom")} AS "bas" FROM "AdBudget"
          WHERE "platform" = ? AND "id" <> ? AND "id" <> ?
            AND ("validTo" IS NULL OR ${dbEpochMs("validTo")} >= ?)
            ${mevcut.bitMs != null ? `AND ${dbEpochMs("validFrom")} <= ?` : ""}
          LIMIT 1`,
        mevcut.platform,
        id,
        kayacakOnceki?.id ?? "",
        yeniBasMs,
        ...(mevcut.bitMs != null ? [mevcut.bitMs] : [])
      );
      if (cakisan.length > 0) {
        const t = new Date(Number(cakisan[0].bas)).toLocaleDateString("tr-TR", { timeZone: "Europe/Istanbul" });
        return NextResponse.json(
          { error: `${t} tarihli başka bir bütçeyle çakışıyor. Önce onu kaldır ya da farklı bir tarih seç.` },
          { status: 409 }
        );
      }
    }

    // Dönem + önceki dönemin bitişi TEK işlemde (yarım kalırsa boşluk ya da çakışma kalırdı).
    const alanlar: string[] = [];
    const degerler: Array<string | number | null> = [];
    if (dailyAmount !== undefined) {
      alanlar.push(`"dailyAmount" = ?`);
      degerler.push(dailyAmount);
    }
    if (baslangicDegisti) {
      alanlar.push(`"validFrom" = ?`);
      degerler.push(toDbDate(new Date(yeniBasMs)));
    }
    const ifadeler: YazmaIfadesi[] = [];
    if (alanlar.length > 0) {
      ifadeler.push({ sql: `UPDATE "AdBudget" SET ${alanlar.join(", ")} WHERE "id" = ?`, args: [...degerler, id] });
    }
    if (kayacakOnceki) {
      ifadeler.push({
        sql: `UPDATE "AdBudget" SET "validTo" = ? WHERE "id" = ?`,
        args: [toDbDate(tarifeDonemSiniri(new Date(yeniBasMs)).eskiBitis), kayacakOnceki.id],
      });
    }
    await tekParcaYaz(ifadeler, prisma);

    bustAdRateCache();
    bustProfitInputCaches();

    // Etkilenen aralık: bu dönemin eski/yeni başlangıcından (önceki dönem kaydıysa onun
    // başından — oranı değişti) dönemin sonuna (açıksa bugüne).
    const basMs = Math.min(mevcut.basMs, yeniBasMs, kayacakOnceki?.basMs ?? Infinity);
    const yenidenHesap = await yenidenHesapla(basMs, mevcut.bitMs ?? Date.now(), mevcut.platform);

    return NextResponse.json({
      ok: true,
      butce: {
        id,
        platform: mevcut.platform,
        ...(dailyAmount !== undefined ? { dailyAmount } : {}),
        validFrom: new Date(yeniBasMs).toISOString(),
        validTo: mevcut.bitMs == null ? null : new Date(mevcut.bitMs).toISOString(),
      },
      yenidenHesap,
    });
  } catch (error) {
    return hataYaniti(error, "Bütçe güncellenemedi");
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await ctx.params;

    const mevcut = await donemOku(id);
    if (!mevcut) {
      return NextResponse.json({ error: "Reklam bütçesi bulunamadı." }, { status: 404 });
    }

    /**
     * ÖNCEKİ DÖNEMİ UZAT. Bu kayıt açılırken kendinden önceki dönemi `başlangıç − 1 ms`de
     * kapatmıştı; silince o dönem kapalı kalırsa arada KURALSIZ bir boşluk doğar ve o aralıktaki
     * siparişler sessizce reklam payı taşımaz olur. Önceki dönem bu kaydın bittiği yere kadar
     * uzar (bu kayıt açıksa yeniden açılır) — sonraki bir dönemle çakışmaz.
     * Silme ve uzatma TEK işlemde.
     */
    const onceki = await oncekiDonem(mevcut);
    const ifadeler: YazmaIfadesi[] = [{ sql: `DELETE FROM "AdBudget" WHERE "id" = ?`, args: [id] }];
    if (onceki) {
      ifadeler.push({
        sql: `UPDATE "AdBudget" SET "validTo" = ? WHERE "id" = ?`,
        args: [mevcut.bitMs == null ? null : toDbDate(new Date(mevcut.bitMs)), onceki.id],
      });
    }
    await tekParcaYaz(ifadeler, prisma);

    bustAdRateCache();
    bustProfitInputCaches();

    const yenidenHesap = await yenidenHesapla(
      onceki ? onceki.basMs : mevcut.basMs,
      mevcut.bitMs ?? Date.now(),
      mevcut.platform
    );
    return NextResponse.json({ ok: true, yenidenHesap });
  } catch (error) {
    return hataYaniti(error, "Bütçe kaldırılamadı");
  }
}
