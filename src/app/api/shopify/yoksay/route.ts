import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { yoksayilanlariGuncelle } from "@/lib/shopify-katalog-sunucu";

/**
 * "Bunu ekleme" — Shopify ürününü yeni ürünler listesinden gizle (ya da geri getir).
 * Liste tüm cihazlarda ortak (veritabanında).
 */
const Schema = z.object({
  varyantlar: z.array(z.string().min(1)).min(1).max(500),
  geriAl: z.boolean().default(false),
});

export async function POST(req: Request) {
  try {
    await ensureRuntimeSchema();
    const { varyantlar, geriAl } = Schema.parse(await req.json());
    await yoksayilanlariGuncelle(geriAl ? [] : varyantlar, geriAl ? varyantlar : []);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
