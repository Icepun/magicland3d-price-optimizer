/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { jsonError } from "@/lib/api-error";
import { computeFullProductCost } from "@/core/cost-calculator";
import { computePackagingCost, parsePackagingSettings } from "@/core/packaging";
import { invalidateOrdersCache } from "@/lib/orders-cache";

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
    let finalCost: any = { ...cost };
    if (cost.costMode === "detailed") {
      const appSettings = await prisma.appSetting.findMany();
      const settings = Object.fromEntries(appSettings.map((s) => [s.key, s.value]));
      const electricityCostPerHour =
        settings.costElectricityIncluded === "true"
          ? parseFloat(settings.costElectricityPerHour || "0")
          : 0;
      const machineWearCostPerHour = parseFloat(settings.costMachineWearPerHour || "0");
      const laborCostPerHour = parseFloat(settings.costLaborPerHour || "0");

      let costPerGram = 0;
      if (cost.filamentTypeId) {
        const filament = await prisma.filamentType.findUnique({ where: { id: cost.filamentTypeId } });
        costPerGram = filament?.costPerGram || 0;
      }

      const packagingSettings = parsePackagingSettings(settings);
      const packaging = computePackagingCost(
        { packagingOptionId: cost.packagingOptionId, nylonLevel: cost.nylonLevel, tapeUsed: cost.tapeUsed },
        packagingSettings
      );
      const calc = computeFullProductCost({
        filamentWeight: cost.filamentWeight ?? 0,
        costPerGram,
        printTimeHours: cost.printTimeHours ?? 0,
        electricityCostPerHour,
        machineWearCostPerHour,
        laborCostPerHour,
        wasteRate: cost.wasteRate ?? 0,
        packagingCost: packaging.total,
      });
      finalCost = {
        ...cost,
        materialCost: calc.filamentCost,
        electricityCost: calc.electricityCost,
        machineWearCost: calc.machineWearCost,
        laborCost: calc.laborCost,
        packagingCost: calc.packagingCost,
        otherCost: calc.wasteCost,
        totalCost: calc.totalCost,
      };
    }

    // Her üyeye uygula: maliyet upsert + (verildiyse) desi.
    for (const m of members) {
      await prisma.productCost.upsert({
        where: { productId: m.id },
        create: { productId: m.id, ...finalCost },
        update: finalCost,
      });
      if (desi !== undefined) {
        await prisma.product.update({ where: { id: m.id }, data: { desi } }).catch(() => {});
      }
    }

    invalidateOrdersCache();
    return NextResponse.json({ ok: true, count: members.length });
  } catch (error) {
    return jsonError(error);
  }
}
