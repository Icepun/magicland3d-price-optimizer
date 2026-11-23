import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { ekFilamentleriOku } from "@/core/filament-karisimi";

export const dynamic = "force-dynamic";

/**
 * Filament türü başına kaç ürün kullanıyor (ana filament + ek filamentler) — silme onayı
 * "N ürün kullanıyor, pasifleştir" diyebilsin. Silinen türe bağlı ürünlerin kârı "bilinmiyor"a düşer.
 */
export async function GET() {
  try {
    await ensureRuntimeSchema();
    const satirlar = await prisma.$queryRawUnsafe<Array<{ filamentTypeId: string | null; ekFilamentlerJson: string | null }>>(
      `SELECT "filamentTypeId", "ekFilamentlerJson" FROM "ProductCost"
        WHERE "costMode" = 'detailed' AND ("filamentTypeId" IS NOT NULL OR "ekFilamentlerJson" IS NOT NULL)`,
    );
    const sayim: Record<string, number> = {};
    for (const r of satirlar) {
      const idler = new Set<string>();
      if (r.filamentTypeId) idler.add(String(r.filamentTypeId));
      for (const ek of ekFilamentleriOku(r.ekFilamentlerJson)) if (ek.filamentTypeId) idler.add(ek.filamentTypeId);
      for (const id of idler) sayim[id] = (sayim[id] ?? 0) + 1;
    }
    return NextResponse.json(sayim);
  } catch (error) {
    return jsonError(error);
  }
}
