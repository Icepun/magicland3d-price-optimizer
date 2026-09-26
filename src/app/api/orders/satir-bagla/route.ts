import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { bagOnizlemesi, bagiKaldir, satiriBagla } from "@/lib/order-line-links";
import { siparisleriTazele } from "@/lib/order-line-refresh";
import { satirBagiAnahtari } from "@/core/order-line-link";

/**
 * ELLE ÜRÜN BAĞI — Siparişler ekranındaki "Ürüne bağla".
 *   GET    ?platform&ad                 → mevcut bağ + bu adla kayıtlı sipariş sayısı
 *   PUT    { platform, ad, productId }  → bağla (varsa eski bağın yerine)
 *   DELETE { platform, ad }             → bağı kaldır
 *
 * Bağ o ADLA gelen tüm siparişlere uygulanır (kural: core/order-line-link).
 */

const Platform = z.enum(["shopify", "trendyol", "hepsiburada"]);
const Ad = z
  .string()
  .max(300)
  .refine((s) => satirBagiAnahtari(s) !== "", "Satır adı boş");

const Anahtar = z.object({ platform: Platform, ad: Ad });
const BaglaSchema = Anahtar.extend({ productId: z.string().min(1).max(200) });

export async function GET(req: Request) {
  try {
    await ensureRuntimeSchema();
    const url = new URL(req.url);
    const { platform, ad } = Anahtar.parse({
      platform: url.searchParams.get("platform"),
      ad: url.searchParams.get("ad") ?? "",
    });
    const { bag, siparisSayisi } = await bagOnizlemesi(platform, ad);
    const urun = bag
      ? await prisma.product.findUnique({
          where: { id: bag.productId },
          select: { id: true, name: true, imageUrl: true },
        })
      : null;
    return NextResponse.json(
      { bag: bag && urun ? { urun } : null, siparisSayisi },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(req: Request) {
  try {
    await ensureRuntimeSchema();
    const govde = BaglaSchema.parse(await req.json());
    const urun = await prisma.product.findUnique({
      where: { id: govde.productId },
      select: { id: true, name: true },
    });
    if (!urun) return NextResponse.json({ error: "Ürün bulunamadı" }, { status: 404 });
    const e = await satiriBagla(govde.platform, govde.ad, urun.id);
    siparisleriTazele(e);
    return NextResponse.json({ ok: true, urun, siparisSayisi: e.externalOrderIds.length });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(req: Request) {
  try {
    await ensureRuntimeSchema();
    const govde = Anahtar.parse(await req.json());
    const e = await bagiKaldir(govde.platform, govde.ad);
    siparisleriTazele(e);
    return NextResponse.json({ ok: true, siparisSayisi: e.externalOrderIds.length });
  } catch (error) {
    return jsonError(error);
  }
}
