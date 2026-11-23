/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { bustProfitInputCaches } from "@/lib/cache-busting";
import { detayliMaliyetOnbellegi, maliyetGovdesiniKolonlaraCevir } from "@/lib/product-cost-cache";
import { filamentFiyatlariOku } from "@/lib/filament-fiyatlari";

export const dynamic = "force-dynamic";

/**
 * Bu ürünün üretim maliyetini (ve desi) AYNI varyant grubundaki TÜM ürünlere (kendisi dahil) uygular.
 * Renk gibi değişen ama maliyeti aynı olan varyantlar için tek tıkla toplu maliyet.
 * Body, ürün detayındaki "Kaydet" ile aynı şekildedir: { cost: {...}, desi }.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureRuntimeSchema();
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const cost: any = body?.cost ?? {};
    const desi: number | null | undefined =
      body?.desi === undefined ? undefined : body.desi === null ? null : Number(body.desi);

    const product = await prisma.product.findUnique({ where: { id }, select: { variantGroupId: true } });
    if (!product) return NextResponse.json({ error: "Ürün bulunamadı" }, { status: 404 });
    if (!product.variantGroupId) {
      return NextResponse.json({ error: "Bu ürün bir varyant grubunda değil" }, { status: 400 });
    }

    const members = await prisma.product.findMany({
      where: { variantGroupId: product.variantGroupId },
      select: { id: true },
    });
    if (members.length === 0) return NextResponse.json({ error: "Grup üyesi bulunamadı" }, { status: 400 });

    // finalCost'u BİR KEZ hesapla (ayarlar + filament fiyatı tüm üyelerde ortak).
    // Ek filamentler (çoklu filament) de kopyalanır: `ekFilamentler` → `ekFilamentlerJson`.
    let finalCost: any = maliyetGovdesiniKolonlaraCevir(cost);
    if (cost.costMode === "detailed") {
      const appSettings = await prisma.appSetting.findMany();
      const settings = Object.fromEntries(appSettings.map((s) => [s.key, s.value]));
      finalCost = {
        ...finalCost,
        ...detayliMaliyetOnbellegi(finalCost, settings, await filamentFiyatlariOku()),
      };
    }

    // TEK İŞLEM, en çok 3 yazma (ya hepsi ya hiçbiri). Eskiden üye başına sıralı 2 yazma vardı:
    // 28 varyantta 56 uzak istek, tüm uygulama o süre kuyrukta; desi hatası yutulup yine
    // "hepsine uygulandı" deniyordu (denetim, 23 Kas 2026). Telefon da tek işlemde yapıyor.
    const ids = members.map((m) => m.id);
    const varolan = new Set(
      (await prisma.productCost.findMany({ where: { productId: { in: ids } }, select: { productId: true } })).map(
        (r) => r.productId
      )
    );
    const yeni = ids.filter((pid) => !varolan.has(pid));
    await prisma.$transaction([
      ...(varolan.size > 0
        ? [prisma.productCost.updateMany({ where: { productId: { in: [...varolan] } }, data: finalCost })]
        : []),
      ...(yeni.length > 0
        ? [prisma.productCost.createMany({ data: yeni.map((productId) => ({ productId, ...finalCost })) })]
        : []),
      ...(desi !== undefined ? [prisma.product.updateMany({ where: { id: { in: ids } }, data: { desi } })] : []),
    ]);

    bustProfitInputCaches();
    return NextResponse.json({ ok: true, count: ids.length });
  } catch (error) {
    return jsonError(error);
  }
}
