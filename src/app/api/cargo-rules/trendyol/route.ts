import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";

/**
 * Trendyol (TEX) kargo desteği modu — mevcut TEX kurallarının isActive bayrağını çevirir.
 * VERİYE DOKUNMAZ (barem rakamları, desi tablosu aynı kalır) — yalnızca hangi düz baremin
 * (Avantajlı/Standart) aktif olduğunu değiştirir. 350+ desi tablosu her iki modda da aktiftir.
 *
 *  POST {mode:"standart"|"avantajli"} →
 *    • Avantajlı düz kurallar (TEX + adında "Avantaj") isActive = (mode==="avantajli")
 *    • Standart  düz kurallar (TEX + adında "Standart") isActive = (mode==="standart")
 *  GET → mevcut mod (avantajlı kural aktifse "avantajli", değilse "standart").
 */
const KEY = "trendyolCargoMode";
const texWhere = { OR: [{ cargoProvider: { contains: "TEX" } }, { name: { contains: "TEX" } }] };

export async function GET() {
  await ensureRuntimeSchema();
  let mode: "standart" | "avantajli" = "standart";
  try {
    const avantajActive = await prisma.cargoRule.count({
      where: { AND: [texWhere, { name: { contains: "Avantaj" } }, { isActive: true }] },
    });
    mode = avantajActive > 0 ? "avantajli" : "standart";
  } catch {
    /* tablo yoksa varsayılan */
  }
  return NextResponse.json({ mode });
}

const Body = z.object({ mode: z.enum(["standart", "avantajli"]) });

export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const { mode } = Body.parse(await req.json());
    // Avantajlı düz barem
    await prisma.cargoRule.updateMany({
      where: { AND: [texWhere, { name: { contains: "Avantaj" } }] },
      data: { isActive: mode === "avantajli" },
    });
    // Standart düz barem
    await prisma.cargoRule.updateMany({
      where: { AND: [texWhere, { name: { contains: "Standart" } }] },
      data: { isActive: mode === "standart" },
    });
    await prisma.appSetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: mode },
      update: { value: mode },
    });
    return NextResponse.json({ ok: true, mode });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Mod değiştirilemedi" },
      { status: 400 }
    );
  }
}
