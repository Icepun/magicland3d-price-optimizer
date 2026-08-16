import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { bustProfitInputCaches } from "@/lib/cache-busting";
import {
  buildHepsiburadaCargoRules,
  HEPSIJET_DESI_BRACKETS,
  HEPSIJET_FLAT_TIERS,
  type HepsiburadaCargoMode,
} from "@/core/hepsijet-tariff";

/**
 * Hepsiburada (HepsiJet) kargo baremi yönetimi.
 *  GET  → mevcut mod ("standart"|"avantajli") + uygulanmış mı + tarife tabloları (UI gösterimi).
 *  POST → seçilen baremi DB'ye yaz: SADECE HB kargo kurallarını temizle + yeni baremi ekle + flag'i kaydet.
 *         (Trendyol/Shopify kargo kurallarına dokunmaz.)
 */
const KEY = "hepsiburadaCargoMode";

export async function GET() {
  await ensureRuntimeSchema();
  let mode: HepsiburadaCargoMode = "standart";
  let applied = 0;
  try {
    const s = await prisma.appSetting.findUnique({ where: { key: KEY } });
    if (s?.value === "avantajli") mode = "avantajli";
    applied = await prisma.cargoRule.count({ where: { platform: "hepsiburada" } });
  } catch {
    /* tablo yoksa varsayılan */
  }
  return NextResponse.json({
    mode,
    applied: applied > 0,
    desiBrackets: HEPSIJET_DESI_BRACKETS,
    flatTiers: HEPSIJET_FLAT_TIERS,
  });
}

const Body = z.object({ mode: z.enum(["standart", "avantajli"]) });

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const { mode } = Body.parse(await req.json());
    /**
     * ⚠️ DÖNEM SINIRLARI KORUNUR.
     *
     * Süresi dolmuş kurallara hiç dokunulmaz: onlar geçmiş siparişlerin kargo maliyetini
     * belirliyor (`core/order-profit.ts` kuralı siparişin KENDİ tarihine göre seçer).
     *
     * Kapanmamış kurallar (validTo boş) ise DÖNEMİNE GÖRE gruplanır ve her grup KENDİ
     * `validFrom`'uyla yeniden yazılır. Eskiden hepsi silinip tek seferde `validFrom = null`
     * ile geri yazılıyordu; bu, tarife dönemlendikten sonra moda her geçişte:
     *   • yürürlükteki tarifenin başlangıç tarihini SİLİP onu tüm geçmişe uygular,
     *   • ileri tarihli (yaklaşan) bir tarife varsa onu da bugünkü dönemle BİRLEŞTİRİRDİ.
     * Bugün HB'de tek ve tarihsiz dönem var, o yüzden davranış birebir aynı kalıyor; tarife
     * dönemlendiğinde de doğru çalışacak.
     */
    const simdi = new Date();
    /**
     * SÜRESİ DOLMAMIŞ tüm dönemler: yürürlükteki + yaklaşan.
     *
     * ⚠️ `validTo: null` YETMEZ: ileri tarihli bir tarife başlatıldığında bugünkü dönem de
     * `validTo` alır (yeni tarifenin bir milisaniye öncesi). Yalnız `null` bakılsaydı düğme
     * bugünkü tarifeyi ATLAR, sadece yaklaşan dönemi çevirirdi — kullanıcı düğmeye basar,
     * hiçbir şey değişmezdi.
     */
    const mevcut = await prisma.cargoRule.findMany({
      where: {
        platform: "hepsiburada",
        OR: [{ validTo: null }, { validTo: { gte: simdi } }],
      },
      select: { id: true, validFrom: true, validTo: true },
    });

    // Dönem anahtarı: (validFrom, validTo) çifti — her dönem KENDİ sınırlarıyla yeniden yazılır.
    const donemler = new Map<string, { validFrom: Date | null; validTo: Date | null }>();
    for (const r of mevcut) {
      const anahtar = `${r.validFrom?.toISOString() ?? ""}|${r.validTo?.toISOString() ?? ""}`;
      if (!donemler.has(anahtar)) {
        donemler.set(anahtar, { validFrom: r.validFrom ?? null, validTo: r.validTo ?? null });
      }
    }
    // Hiç kural yoksa tek bir tarihsiz dönem kur (ilk kurulum).
    if (donemler.size === 0) donemler.set("|", { validFrom: null, validTo: null });

    await prisma.cargoRule.deleteMany({
      where: { id: { in: mevcut.map((r) => r.id) } },
    });

    const rules = buildHepsiburadaCargoRules(mode);
    for (const { validFrom, validTo } of donemler.values()) {
      await prisma.cargoRule.createMany({
        data: rules.map((r) => ({ ...r, validFrom, validTo })),
      });
    }
    await prisma.appSetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: mode },
      update: { value: mode },
    });
    bustProfitInputCaches(); // kargo değişti → sipariş kârı bir sonraki istekte YENİ baremle hesaplansın
    return NextResponse.json({ ok: true, mode, count: rules.length });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Barem uygulanamadı" },
      { status: 400 }
    );
  }
}
