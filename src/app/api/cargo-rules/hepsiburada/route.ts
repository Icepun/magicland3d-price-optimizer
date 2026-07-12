import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { invalidateOrdersCache } from "@/lib/orders-cache";
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
    await prisma.cargoRule.deleteMany({ where: { platform: "hepsiburada" } });
    const rules = buildHepsiburadaCargoRules(mode);
    await prisma.cargoRule.createMany({ data: rules });
    await prisma.appSetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: mode },
      update: { value: mode },
    });
    invalidateOrdersCache(); // kargo değişti → sipariş kârı bir sonraki istekte YENİ baremle hesaplansın
    return NextResponse.json({ ok: true, mode, count: rules.length });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Barem uygulanamadı" },
      { status: 400 }
    );
  }
}
