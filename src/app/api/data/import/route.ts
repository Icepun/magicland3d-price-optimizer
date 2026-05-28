import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { z } from "zod";

const ImportSchema = z.object({
  version: z.number().optional(),
  exportedAt: z.string().optional(),
  appVersion: z.string().optional(),
  products: z.array(z.any()).optional(),
  productCosts: z.array(z.any()).optional(),
  listings: z.array(z.any()).optional(),
  filamentTypes: z.array(z.any()).optional(),
  appSettings: z.array(z.any()).optional(),
  commissionRules: z.array(z.any()).optional(),
  cargoRules: z.array(z.any()).optional(),
  expenseRules: z.array(z.any()).optional(),
  costTemplates: z.array(z.any()).optional(),
  priceHistory: z.array(z.any()).optional(),
});

/**
 * Daha önce export edilmiş JSON'u geri yükler.
 * Mevcut veri SİLİNMEZ — barcode/id ile upsert yapılır.
 */
export async function POST(req: NextRequest) {
  try {
    await ensureRuntimeSchema();
    const data = ImportSchema.parse(await req.json());

    const stats = {
      products: 0,
      productCosts: 0,
      listings: 0,
      filamentTypes: 0,
      appSettings: 0,
      commissionRules: 0,
      cargoRules: 0,
      expenseRules: 0,
      costTemplates: 0,
      priceHistory: 0,
    };

    // AppSettings — upsert by key
    if (data.appSettings) {
      for (const s of data.appSettings) {
        if (!s.key) continue;
        await prisma.appSetting.upsert({
          where: { key: s.key },
          create: { key: s.key, value: s.value },
          update: { value: s.value },
        });
        stats.appSettings++;
      }
    }

    // FilamentTypes — by id
    if (data.filamentTypes) {
      for (const f of data.filamentTypes) {
        if (!f.id) continue;
        await prisma.filamentType.upsert({
          where: { id: f.id },
          create: f,
          update: f,
        });
        stats.filamentTypes++;
      }
    }

    // Rules
    for (const [arr, model, statKey] of [
      [data.commissionRules, "commissionRule", "commissionRules"],
      [data.cargoRules, "cargoRule", "cargoRules"],
      [data.expenseRules, "expenseRule", "expenseRules"],
      [data.costTemplates, "costTemplate", "costTemplates"],
    ] as const) {
      if (!arr) continue;
      for (const r of arr) {
        if (!r.id) continue;
        try {
          await (prisma as unknown as Record<string, { upsert: (a: { where: { id: string }; create: unknown; update: unknown }) => Promise<unknown> }>)[
            model
          ].upsert({ where: { id: r.id }, create: r, update: r });
          (stats as Record<string, number>)[statKey]++;
        } catch {
          /* skip bad rows */
        }
      }
    }

    // Products — by barcode (unique)
    if (data.products) {
      for (const p of data.products) {
        if (!p.barcode) continue;
        try {
          const productFields = {
            sku: p.sku ?? p.barcode,
            name: p.name ?? p.barcode,
            categoryName: p.categoryName ?? "Imported",
            currentSalePrice: p.currentSalePrice ?? 0,
            listPrice: p.listPrice ?? null,
            stock: p.stock ?? 0,
            desi: p.desi ?? null,
            weight: p.weight ?? null,
            imageUrl: p.imageUrl ?? null,
            isActive: p.isActive ?? true,
            hidden: p.hidden ?? false,
            source: p.source ?? "imported",
            trendyolId: p.trendyolId ?? null,
            productMainId: p.productMainId ?? null,
            commissionRate: p.commissionRate ?? null,
            commissionSource: p.commissionSource ?? null,
          };
          await prisma.product.upsert({
            where: { barcode: p.barcode },
            create: { id: p.id, barcode: p.barcode, ...productFields },
            update: productFields,
          });
          stats.products++;
        } catch {
          /* skip */
        }
      }
    }

    // ProductCosts — by productId (unique)
    if (data.productCosts) {
      for (const c of data.productCosts) {
        if (!c.productId) continue;
        try {
          await prisma.productCost.upsert({
            where: { productId: c.productId },
            create: c,
            update: c,
          });
          stats.productCosts++;
        } catch {
          /* skip */
        }
      }
    }

    // Listings — by productId+platform unique
    if (data.listings) {
      for (const l of data.listings) {
        if (!l.productId || !l.platform) continue;
        const existing = await prisma.listing.findFirst({
          where: { productId: l.productId, platform: l.platform },
        });
        try {
          if (existing) {
            await prisma.listing.update({
              where: { id: existing.id },
              data: {
                externalId: l.externalId ?? null,
                externalSku: l.externalSku ?? null,
                salePrice: l.salePrice ?? 0,
                listPrice: l.listPrice ?? null,
                stock: l.stock ?? 0,
                commissionRate: l.commissionRate ?? null,
                commissionFixed: l.commissionFixed ?? null,
                cargoCost: l.cargoCost ?? null,
                isActive: l.isActive ?? true,
              },
            });
          } else {
            await prisma.listing.create({
              data: {
                id: l.id,
                productId: l.productId,
                platform: l.platform,
                externalId: l.externalId ?? null,
                externalSku: l.externalSku ?? null,
                salePrice: l.salePrice ?? 0,
                listPrice: l.listPrice ?? null,
                stock: l.stock ?? 0,
                commissionRate: l.commissionRate ?? null,
                commissionFixed: l.commissionFixed ?? null,
                cargoCost: l.cargoCost ?? null,
                isActive: l.isActive ?? true,
              },
            });
          }
          stats.listings++;
        } catch {
          /* skip */
        }
      }
    }

    return NextResponse.json({ ok: true, stats });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Import başarısız" },
      { status: 400 }
    );
  }
}
